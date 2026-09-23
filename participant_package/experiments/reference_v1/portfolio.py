"""Sequential resource replay, negative-safe maxima and marginal portfolio selection."""
from __future__ import annotations
import math
import numpy as np
from .candidates import FILTER_VALUES, SPEC_FIELDS, filter_audience


def replay_plan(profile, plan, channels, remaining_budget, remaining_contacts, tariffs=None):
    """Validate and execute the final filters; pilot resource use is supplied by caller."""
    if not 1 <= len(plan) <= 10:
        raise ValueError("Final plan must contain 1–10 campaigns")
    money, contacts = float(remaining_budget), int(remaining_contacts)
    result = []
    for spec in plan:
        if set(spec) - set(SPEC_FIELDS):
            raise ValueError("Unexpected final campaign fields")
        if spec.get("channel") not in channels:
            raise ValueError("Unknown channel")
        if tariffs is not None and spec.get("target_tariff") not in set(tariffs):
            raise ValueError("Unknown target tariff")
        for field, allowed in FILTER_VALUES.items():
            value = spec.get("filter_" + field)
            if value is not None and value not in allowed:
                raise ValueError(f"Invalid {field} filter")
        source = spec.get("filter_current_tariff")
        if source is not None:
            tokens = {part.strip() for part in str(source).split(";") if part.strip()}
            if not tokens or (tariffs is not None and tokens - set(tariffs)):
                raise ValueError("Unknown or empty current tariff filter")
        cost = float(channels[spec["channel"]]["cost_per_contact"])
        affordable = min(5000, contacts, int(money // cost) if cost > 0 else contacts)
        frame = filter_audience(profile, spec).iloc[:max(0, affordable)]
        if frame.empty:
            raise ValueError("Final campaign has no executable audience")
        money -= len(frame) * cost
        contacts -= len(frame)
        result.append({"spec": dict(spec), "n_customers": len(frame),
                       "customer_ids": frame["ID_NUMBER"].tolist(),
                       "cost": len(frame) * cost,
                       "remaining_budget": money, "remaining_contacts": contacts})
    return result


def best_contacted_effect(previous: np.ndarray, next_effect: np.ndarray) -> np.ndarray:
    """NaN means never contacted; a contacted negative effect is retained."""
    return np.where(np.isnan(previous), next_effect, np.maximum(previous, next_effect))


class PilotOverlap:
    """Analytic independent uniform pilot inclusion, with posterior means plugged in.

    Pilot IDs are unavailable. For a fixed client in a group, each pilot samples
    it with probability n/group_size, independently across separate pilots.
    Effect uncertainty is shared within a group; no sqrt(final N) reduction.
    """
    method = ("Analytic independent uniform sampling within each pilot filter; "
              "posterior mean effects plugged into client-wise maxima. "
              "Final intersections exact, pilot IDs unknown; uncertainty of maxima is not integrated.")

    def __init__(self, space, posterior, pilots, risk_penalty=0.0):
        self.groups = {}
        self.expected = np.zeros(len(space.profile))
        self.reach_probability = np.zeros(len(space.profile))
        for group, audience in space.groups.items():
            effects = []
            for pilot in pilots:
                if pilot["group"] == group:
                    mean, variance, _ = posterior.get(group, pilot["target"], pilot["channel"])
                    effects.append((mean - risk_penalty * math.sqrt(variance),
                                    min(1.0, pilot["n"] / len(audience.indices))))
            # Distribution of the highest effect among actually contacted pilots.
            survival, weights = 1.0, []
            for effect, probability in sorted(effects, reverse=True):
                weights.append((effect, probability * survival))
                survival *= 1.0 - probability
            initial = sum(effect * weight for effect, weight in weights)
            self.groups[group] = (survival, weights, initial)
            self.expected[audience.indices] = initial
            self.reach_probability[audience.indices] = 1 - survival

    def at(self, group, final_effect):
        survival, weights, _ = self.groups[group]
        total = survival * final_effect
        for effect, weight in weights:
            total = total + weight * np.maximum(effect, final_effect)
        return total


def optimize(space, posterior, pilots, budget, contacts, risk_penalty, allowed_channels=None,
             thorough=False):
    """Bounded marginal greedy with several contact shadow prices, not an optimum."""
    candidates = space.candidates(posterior, allowed_channels)
    overlap = PilotOverlap(space, posterior, pilots, risk_penalty)
    if not candidates:
        raise ValueError("No eligible audience/target/channel for a final campaign")
    best_per_contact = max((c.mean - risk_penalty * math.sqrt(c.variance)) *
                           float(space.baseline[c.audience.indices].mean()) -
                           float(space.channels[c.channel]["cost_per_contact"]) for c in candidates)
    penalties = [0.0, max(0.0, best_per_contact) * 0.20, max(0.0, best_per_contact) * 0.45] if thorough else [0.0]
    portfolios = []
    for shadow in penalties:
        money, remaining = float(budget), int(contacts)
        final_best = np.full(len(space.profile), np.nan)
        current = overlap.expected.copy()
        chosen, total_gain = [], 0.0
        for _ in range(10):
            winner, winner_score = None, -np.inf
            for candidate in candidates:
                cost = float(space.channels[candidate.channel]["cost_per_contact"])
                count = min(5000, remaining, len(candidate.audience.indices),
                            int(money // cost) if cost > 0 else remaining)
                if count <= 0:
                    continue
                indices = candidate.audience.indices[:count]
                effect = candidate.mean - risk_penalty * math.sqrt(candidate.variance)
                new_best = best_contacted_effect(final_best[indices], np.full(count, effect))
                new_values = overlap.at(candidate.audience.group, new_best)
                marginal = float(np.dot(space.baseline[indices], new_values - current[indices]) - count * cost)
                score = marginal - shadow * count
                if score > winner_score + 1e-8:
                    winner_score = score
                    winner = (candidate, indices, marginal, new_best, new_values, count * cost)
            if winner is None or winner[2] <= 1e-8 or (winner_score <= 0 and chosen):
                break
            candidate, indices, gain, new_best, new_values, expense = winner
            final_best[indices], current[indices] = new_best, new_values
            money -= expense
            remaining -= len(indices)
            total_gain += gain
            chosen.append((candidate, indices, False))
        portfolios.append((total_gain, chosen))
    chosen = max(portfolios, key=lambda item: item[0])[1]
    if not chosen:
        # Required nonempty final plan: explicitly choose minimum forecast damage.
        winner, winner_gain = None, -np.inf
        mean_overlap = PilotOverlap(space, posterior, pilots)
        for candidate in space.candidates(posterior, allowed_channels, fallback=True):
            cost = float(space.channels[candidate.channel]["cost_per_contact"])
            count = min(5000, int(contacts), len(candidate.audience.indices),
                        int(float(budget) // cost) if cost > 0 else int(contacts))
            if count <= 0:
                continue
            indices = candidate.audience.indices[:count]
            values = mean_overlap.at(candidate.audience.group, np.full(count, candidate.mean))
            gain = float(np.dot(space.baseline[indices], values - mean_overlap.expected[indices]) - cost * count)
            if gain > winner_gain + 1e-8:
                winner_gain, winner = gain, (candidate, indices, True)
        if winner is None:
            raise ValueError("No resources remain for required nonempty final campaign")
        chosen = [winner]
    return chosen


def describe_portfolio(space, posterior, pilots, chosen, pilot_cost):
    overlap = PilotOverlap(space, posterior, pilots)
    current = overlap.expected.copy()
    best_final = np.full(len(space.profile), np.nan)
    reach = overlap.reach_probability.copy()
    views, final_cost = [], 0.0
    for number, (candidate, indices, fallback) in enumerate(chosen, start=1):
        new_best = best_contacted_effect(best_final[indices], np.full(len(indices), candidate.mean))
        values = overlap.at(candidate.audience.group, new_best)
        cost = len(indices) * float(space.channels[candidate.channel]["cost_per_contact"])
        marginal = float(np.dot(space.baseline[indices], values - current[indices]) - cost)
        best_final[indices], current[indices], reach[indices] = new_best, values, 1.0
        final_cost += cost
        spec = candidate.spec(f"orbitduo_{number:02d}_{candidate.audience.group[0]}_{candidate.target}")
        views.append({"id": f"campaign-{number}", "execution_order": number, "spec": spec,
                      "audience_count": len(indices), "communication_cost": cost,
                      "expected_incremental_net_gain": marginal,
                      "expected_lift_ratio": candidate.mean if space.baseline[indices].sum() > 0 else None,
                      "evidence": "fallback" if fallback else ("pilot_supported" if candidate.pilot_ids else "prior_only"),
                      "supporting_pilot_ids": list(candidate.pilot_ids),
                      "reasons": [f"Posterior lift {candidate.mean:.5f}, standard deviation {math.sqrt(candidate.variance):.5f}.",
                                  f"Executable ID-ordered audience: {len(indices)}; marginal expected net: {marginal:.2f} CU.",
                                  "Selection accounts for previous campaigns, estimated pilot overlap, contacts and budget."],
                      "warnings": (["Required nonempty fallback: selected minimum estimated damage; gain is not guaranteed."]
                                   if fallback else ([] if candidate.pilot_ids else ["Historical prior only; no direct pilot evidence."]))})
    gross = float(np.dot(space.baseline, current))
    forecast = {"scope": "pilots_and_final", "expected_gross_gain": gross,
                "expected_net_gain": gross - final_cost - float(pilot_cost),
                "net_gain_interval": None, "expected_unique_reach": float(reach.sum()),
                "overlap_method": PilotOverlap.method}
    return views, forecast
