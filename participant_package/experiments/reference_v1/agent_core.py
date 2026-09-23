"""Adaptive public-interface-only agent with a bounded five-minute safety deadline."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import logging
import math
from pathlib import Path
import time
import numpy as np

from .candidates import Candidate, CandidateSpace
from .posterior import HistoryPrior, NOISE_STD, PosteriorTable
from .portfolio import optimize, describe_portfolio, replay_plan

LOGGER = logging.getLogger(__name__)


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class Agent:
    def __init__(self, seed=42, risk_profile="balanced", observer=None,
                 use_history=True, adaptive=True, risk_penalty=None,
                 allowed_channels=None, max_pilots=16, history_strength=1.0,
                 diverse_fixed=False):
        if risk_profile not in {"balanced", "conservative"}:
            raise ValueError("Unknown risk profile")
        self.seed = int(seed)
        self.risk_profile = risk_profile
        self.observer = observer
        self.use_history = bool(use_history)
        self.history_strength = float(history_strength)
        self.adaptive = bool(adaptive)
        self.diverse_fixed = bool(diverse_fixed)
        self.risk_penalty = float(risk_penalty if risk_penalty is not None else
                                  (0.55 if risk_profile == "balanced" else 1.10))
        if not math.isfinite(self.risk_penalty) or self.risk_penalty < 0:
            raise ValueError("Risk penalty must be finite and nonnegative")
        self.allowed_channels = tuple(allowed_channels) if allowed_channels is not None else None
        self.max_pilots = min(20, max(1, int(max_pilots)))
        self.report = {}
        self.result = self.report

    def _notice(self, code, message, count=None):
        self.report["warnings"].append({"code": code, "severity": "warning", "message": message,
                                        "affected_count": count})

    def _event(self, phase, title, message):
        sequence = len(self.report["events"]) + 1
        self.report["events"].append({"id": f"event-{sequence}", "sequence": sequence,
                                      "created_at": utc_now(), "phase": phase,
                                      "title": title, "message": message})
        self.report["phase"] = phase
        self.report["phase_message"] = message
        if self.observer is not None:
            try:
                self.observer(deepcopy(self.report))
            except Exception as exc:
                LOGGER.warning("Agent observer failed during %s: %s", phase, exc, exc_info=True)
                if not self._observer_failed:
                    self._notice("OBSERVER_FAILED", f"Progress observer failed: {type(exc).__name__}: {exc}")
                    self._observer_failed = True

    def _resources(self, env, views=None):
        planned_cost = sum(x["communication_cost"] for x in views) if views is not None else None
        planned_contacts = sum(x["audience_count"] for x in views) if views is not None else None
        self.report["resources"] = {
            "budget": {"limit": float(env.total_budget), "used_by_pilots": float(env.total_budget - env.remaining_budget),
                       "planned_final": planned_cost,
                       "remaining_after_plan": float(env.remaining_budget - planned_cost) if planned_cost is not None else None},
            "contacts": {"limit": int(env.max_total_contacts), "used_by_pilots": int(env.max_total_contacts - env.remaining_contacts),
                         "planned_final": planned_contacts,
                         "remaining_after_plan": int(env.remaining_contacts - planned_contacts) if planned_contacts is not None else None},
            "pilots_used": 20 - int(env.pilots_left), "pilots_limit": 20,
            "final_campaigns_count": len(views) if views is not None else 0, "final_campaigns_limit": 10}

    def _plan(self, env, thorough=False):
        chosen = optimize(self.space, self.posterior, self._pilots, env.remaining_budget,
                          env.remaining_contacts, self.risk_penalty, self._channels, thorough)
        pilot_cost = float(env.total_budget - env.remaining_budget)
        views, forecast = describe_portfolio(self.space, self.posterior, self._pilots, chosen, pilot_cost)
        specs = [view["spec"] for view in views]
        replay_plan(self.space.profile, specs, self.space.channels, env.remaining_budget,
                    env.remaining_contacts, self.space.tariffs)
        self.report["campaigns"], self.report["forecast"] = views, forecast
        self._resources(env, views)
        self._best_plan = specs
        return specs

    def _experiments(self, env, initial=False):
        """Finite VOI heuristic, not an optimal experiment policy."""
        normal = [c for c in self._channels if self.posterior.normalized(c)]
        available = normal or self._channels
        reference = max(normal, key=lambda c: self.space.channels[c]["conversion_multiplier"], default=available[0])
        ref_scale = float(self.space.channels[reference]["conversion_multiplier"]) if normal else 1.0
        views = self.report["campaigns"]
        planned_n = sum(v["audience_count"] for v in views)
        opportunity = max(0.0, sum(v["expected_incremental_net_gain"] or 0 for v in views) / max(1, planned_n))
        results = []
        for group, target in self.space.hypotheses:
            if (group, target) in self._failed_hypotheses:
                continue
            audience = self.space.groups[group]
            if len(audience.indices) == 0:
                continue
            seen_group = sum(p["group"] == group for p in self._pilots)
            if initial and seen_group:
                continue
            mean, variance, prior_pilots = self.posterior.get(group, target, reference)
            sd = math.sqrt(variance)
            incumbent = max(self.posterior.get(group, t, reference)[0]
                            for t in self.space.tariffs if t != group[0])
            gap = max(0.0, incumbent - mean)
            relevance = math.exp(-0.5 * (gap / max(0.015, 1.5 * sd)) ** 2)
            baseline = float(self.space.baseline[audience.indices[:5000]].sum())
            average = float(self.space.baseline[audience.indices].mean())
            for channel in available:
                cost = float(self.space.channels[channel]["cost_per_contact"])
                multiplier = float(self.space.channels[channel]["conversion_multiplier"])
                channel_mean, channel_variance, _ = self.posterior.get(group, target, channel)
                cheapest = min(float(self.space.channels[c]["cost_per_contact"]) for c in self._channels)
                for requested in (80, 140, 200):
                    reserve_capacity = min(int(env.remaining_contacts) - 1,
                                           int(max(0, env.remaining_budget - cheapest) // cost)
                                           if cost > 0 else int(env.remaining_contacts) - 1)
                    requested = max(10, min(requested, reserve_capacity))
                    actual = min(requested, len(audience.indices))
                    if actual <= 0 or actual > reserve_capacity:
                        continue
                    obs_var = NOISE_STD ** 2 / actual
                    after_var = channel_variance * obs_var / (channel_variance + obs_var)
                    reduction = math.sqrt(channel_variance) - math.sqrt(after_var)
                    if normal:
                        reduction *= ref_scale / multiplier
                    information_value = baseline * reduction * relevance * 0.55
                    harm = max(0.0, -channel_mean) * average * actual
                    value = information_value - actual * cost - harm - opportunity * actual * 0.25
                    value /= 1 + 0.18 * seen_group + 0.35 * len(prior_pilots)
                    results.append((value, baseline, group, target, channel, requested, actual))
        return sorted(results, key=lambda row: (-row[0], -row[1], row[2], row[3], row[4], row[5]))

    def act(self, env) -> list[dict]:
        started = time.monotonic()
        self.rng = np.random.default_rng(self.seed)
        self._observer_failed = False
        self._pilots, self._failed_hypotheses, self._best_plan = [], set(), []
        self.report = {"resources": {}, "pilots": [], "campaigns": [], "events": [],
                       "forecast": None, "warnings": [], "runtime_seconds": 0.0,
                       "options": {"seed": self.seed, "risk_profile": self.risk_profile,
                                   "risk_penalty": self.risk_penalty, "use_history": self.use_history,
                                   "history_strength": self.history_strength,
                                   "diverse_fixed": self.diverse_fixed,
                                   "adaptive": self.adaptive, "max_pilots": self.max_pilots}}
        self.result = self.report
        self._resources(env)
        self._event("audit", "Public profile audit", "Validating customer identifiers, public segment labels and baseline values.")
        self.space = CandidateSpace(env.customer_profile, env.tariffs, env.channels)
        self._channels = sorted(set(self.allowed_channels or self.space.channels) & set(self.space.channels))
        if not self._channels:
            raise ValueError("No allowed public channel available")
        for channel in self._channels:
            params = self.space.channels[channel]
            if (not math.isfinite(float(params["cost_per_contact"])) or float(params["cost_per_contact"]) < 0
                    or not math.isfinite(float(params["conversion_multiplier"])) or float(params["conversion_multiplier"]) <= 0):
                raise ValueError("Invalid public channel parameters")
        if not self.space.hypotheses:
            raise ValueError("No eligible source group and different target tariff")
        history = HistoryPrior(Path(__file__).resolve().parents[2] / "data" / "change_tariff.csv", self.use_history,
                               strength=self.history_strength)
        self.posterior = PosteriorTable(history, self.space.channels)
        if history.warning:
            self._notice("HISTORY_UNAVAILABLE", history.warning)
        if self.space.excluded:
            self._notice("INELIGIBLE_CUSTOMERS", "Missing/unknown current tariff or invalid ARPU segment excluded from targeted candidates.", self.space.excluded)
        missing = self.space.optional_missing_customers
        if missing:
            self._notice("OPTIONAL_SEGMENTS_MISSING", "Missing data/call labels remain in unrestricted groups and cannot match those optional filters.", missing)
        self._notice("FORECAST_APPROXIMATION", "Pilot identities are unavailable; forecast uses analytic expected overlap and posterior mean maxima, without a calibrated interval.")
        self._event("candidates", "Candidates constructed", f"{len(self.space.groups)} homogeneous groups and {len(self.space.hypotheses)} source/target hypotheses; no same-tariff offers.")
        self._plan(env)
        self._event("planning", "Initial feasible plan", f"{len(self._best_plan)} executable final campaigns; risk penalty {self.risk_penalty:.2f} standard deviations.")
        fixed_schedule = None
        if not self.adaptive:
            ranked = self._experiments(env, initial=False)
            unique, fixed_schedule = set(), []
            for experiment in ranked:
                key = (experiment[2], experiment[3])
                if key not in unique:
                    unique.add(key)
                    fixed_schedule.append(experiment)
            if self.diverse_fixed:
                diverse_schedule, selected_keys, counts = [], set(), {}
                for experiment in fixed_schedule:
                    group, target = experiment[2], experiment[3]
                    if group not in counts:
                        diverse_schedule.append(experiment)
                        selected_keys.add((group, target))
                        counts[group] = 1
                    if len(counts) >= min(6, len(self.space.groups)):
                        break
                for experiment in fixed_schedule:
                    group, target = experiment[2], experiment[3]
                    if (group, target) not in selected_keys and counts.get(group, 0) < 4:
                        diverse_schedule.append(experiment)
                        selected_keys.add((group, target))
                        counts[group] = counts.get(group, 0) + 1
                fixed_schedule = diverse_schedule
        max_iterations = min(self.max_pilots, int(env.pilots_left))
        for step in range(max_iterations):
            if time.monotonic() - started > 270:
                self._notice("TIME_RESERVE", "Stopped experimentation with 30 seconds reserved for final validation.")
                break
            if env.pilots_left <= 0 or env.remaining_contacts <= 1:
                break
            diverse = step < min(6, len(self.space.groups))
            if fixed_schedule is not None:
                experiments = fixed_schedule[step:step + 1]
            else:
                experiments = self._experiments(env, initial=diverse)
                if not experiments:
                    experiments = self._experiments(env)
            if not experiments:
                break
            value, _, group, target, channel, requested, _ = experiments[0]
            # A fixed schedule is chosen before any pilots; recheck current balances.
            cost = float(self.space.channels[channel]["cost_per_contact"])
            cheapest = min(float(self.space.channels[c]["cost_per_contact"]) for c in self._channels)
            reserve_capacity = min(int(env.remaining_contacts) - 1,
                                   int(max(0, env.remaining_budget - cheapest) // cost)
                                   if cost > 0 else int(env.remaining_contacts) - 1)
            requested = max(10, min(requested, reserve_capacity))
            if min(requested, len(self.space.groups[group].indices)) > reserve_capacity:
                break
            if step >= min(6, len(self.space.groups)) and self.adaptive and value <= 0:
                self._event("pilots", "Exploration stopped", "Best estimated value of additional information is below its communication, contact and harm costs.")
                break
            audience = self.space.groups[group]
            mean, variance, evidence = self.posterior.get(group, target, channel)
            spec = Candidate(audience, target, channel, mean, variance, evidence).spec(f"pilot_{len(self._pilots)+1}")
            reason = (f"{'Diverse initial coverage' if diverse else 'Decision-relevant uncertainty'}; "
                      f"compared sample sizes 80/140/200 and available unsaturated channels; heuristic value {value:.2f} CU.")
            self._event("pilots", "Pilot selected", f"{group[0]}/{group[1]} → {target}, {channel}, requested {requested}. {reason}")
            try:
                response = env.run_pilot(target_tariff=target, channel=channel, n_customers=requested,
                                         filter_arpu_segment=group[1], filter_current_tariff=group[0])
            except Exception as exc:
                LOGGER.warning("Pilot failed for %s to %s using %s: %s", group, target, channel, exc, exc_info=True)
                self._failed_hypotheses.add((group, target))
                self._notice("PILOT_FAILED", f"Pilot {group}/{target}/{channel} failed: {type(exc).__name__}: {exc}")
                self._resources(env)
                self._plan(env)
                continue
            actual = int(response["n_customers"])
            observed = float(response["observed_lift_ratio"])
            if actual <= 0 or not math.isfinite(observed):
                raise ValueError("Pilot returned invalid actual sample/observation")
            pilot_id = f"pilot-{len(self._pilots)+1}"
            self.posterior.update(group, target, channel, observed, actual, pilot_id)
            self._pilots.append({"group": group, "target": target, "channel": channel, "n": actual})
            updated_mean, _, _ = self.posterior.get(group, target, channel)
            record = {"id": pilot_id, "sequence": len(self._pilots), "campaign": spec,
                      "requested_customers": requested, "actual_customers": actual,
                      "cost": float(response["cost"]), "observed_lift_ratio": observed,
                      "observed_lift_total": float(response["observed_lift_total"]),
                      "selection_reason": reason,
                      "decision_after": f"Posterior mean changed {mean:.5f} → {updated_mean:.5f}; portfolio recomputed with actual resource balances.",
                      "completed_at": utc_now()}
            self.report["pilots"].append(record)
            # The old plan predates this paid pilot and must not look executable.
            self.report["campaigns"], self.report["forecast"] = [], None
            self._resources(env)
            self._event("pilots", "Pilot observed", f"{pilot_id}: actual n={actual}, observed lift={observed:.5f}; {record['decision_after']}")
            self._plan(env)
            self._event("planning", "Portfolio updated", f"{len(self._best_plan)} final campaigns; forecast net including pilots {self.report['forecast']['expected_net_gain']:.2f} CU.")
        if not self._pilots:
            raise RuntimeError("No successful pilot; contest requirement cannot be satisfied")
        self._plan(env, thorough=True)
        if any(view["evidence"] == "fallback" for view in self.report["campaigns"]):
            self._notice("REQUIRED_FALLBACK", "Risk-adjusted profitable portfolio unavailable; required nonempty campaign minimizes estimated damage.")
        self.report["runtime_seconds"] = float(time.monotonic() - started)
        self._event("planning", "Final plan validated", f"{len(self._best_plan)} campaigns, {len(self._pilots)} successful pilots, runtime {self.report['runtime_seconds']:.3f}s. Official evaluation runs separately.")
        return deepcopy(self._best_plan)
