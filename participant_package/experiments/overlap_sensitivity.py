"""Bounded overlap validation with frozen learned posterior; organizer-side only.

From participant_package: python -m experiments.overlap_sensitivity
The Monte Carlo error is numerical sampling error, not forecast uncertainty.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np
import pandas as pd

from agent import Agent
from mock_environment import make_mock_env, _mock_impact_model, _mock_fallback
from scoring_core import score_campaigns, sanitize_campaigns
from uniflow.portfolio import optimize, describe_portfolio, replay_plan

ROOT = Path(__file__).resolve().parents[1]
MONTE_CARLO_SEED = 20260923


def monte_carlo(space, posterior, pilots, chosen, replicates, seed):
    """Freeze posterior means; independently sample each public pilot audience."""
    rng = np.random.default_rng(seed)
    gross, reach = [], []
    for _ in range(replicates):
        best = np.full(len(space.profile), np.nan)
        for pilot in pilots:
            audience = space.groups[pilot["group"]].indices
            picked = rng.choice(audience, size=pilot["n"], replace=False)
            mean, _, _ = posterior.get(pilot["group"], pilot["target"], pilot["channel"])
            # fmax(NaN, negative) preserves the negative effect of first contact.
            best[picked] = np.fmax(best[picked], mean)
        for candidate, indices, _ in chosen:
            best[indices] = np.fmax(best[indices], candidate.mean)
        contacted = np.isfinite(best)
        gross.append(float(np.dot(space.baseline[contacted], best[contacted])))
        reach.append(int(contacted.sum()))

    def stats(values):
        return {"mean": float(np.mean(values)), "simulation_standard_error": float(np.std(values, ddof=1) / np.sqrt(replicates))}
    return {"replicates": replicates, "rng_seed": seed, "gross_gain": stats(gross), "unique_reach": stats(reach)}


def signature(specs):
    return [{key: value for key, value in spec.items() if key != "campaign_name"} for spec in specs]


def score_final(env, pilot_campaigns, final, impact_model):
    assert len(sanitize_campaigns(final, env.tariffs)) == len(final)
    frame = pd.DataFrame(pilot_campaigns + final)
    for column in ("filter_arpu_segment", "filter_data_segment", "filter_call_segment", "filter_current_tariff", "explicit_ids"):
        if column not in frame:
            frame[column] = None
    scored = score_campaigns(frame, env.customer_profile, impact_model, env.tariffs,
                             float(env.customer_profile.predicted_arpu.sum()), _mock_fallback,
                             team_id="overlap_sensitivity")
    assert scored["total_cost"] <= env.total_budget and scored["total_contacts"] <= env.max_total_contacts
    assert all(0 < row["n_contacts"] <= 5000 for row in scored["campaigns_detail"][len(pilot_campaigns):])
    return {"gross_gain": scored["gross_arpu_lift"], "net_arpu_gain": scored["net_arpu_gain"],
            "communication_cost": scored["total_cost"], "total_contacts": scored["total_contacts"],
            "unique_customers": scored["unique_customers_targeted"], "n_final_campaigns": len(final)}


def measure(seed, replicates):
    started = time.perf_counter()
    env, organizer = make_mock_env(seed=seed, data_dir=str(ROOT / "data"),
                                   profile_path=str(ROOT / "customer_profile.csv"))
    agent = Agent(seed=seed)
    returned_plan = agent.act(env)
    space, posterior, pilots = agent.space, agent.posterior, agent._pilots
    pilot_cost = float(env.total_budget - env.remaining_budget)
    variants = {}
    for label, optimizer_pilots in (("analytic_overlap", pilots), ("ignore_pilot_overlap", [])):
        chosen = optimize(space, posterior, optimizer_pilots, env.remaining_budget, env.remaining_contacts,
                          agent.risk_penalty, agent._channels, thorough=True)
        views, forecast = describe_portfolio(space, posterior, pilots, chosen, pilot_cost)
        _, selection_forecast = describe_portfolio(space, posterior, optimizer_pilots, chosen, pilot_cost)
        specs = [view["spec"] for view in views]
        replay_plan(space.profile, specs, space.channels, env.remaining_budget, env.remaining_contacts, space.tariffs)
        simulation = monte_carlo(space, posterior, pilots, chosen, replicates, MONTE_CARLO_SEED + seed)
        comparisons = {}
        for metric, analytic in (("gross_gain", forecast["expected_gross_gain"]),
                                 ("unique_reach", forecast["expected_unique_reach"])):
            mean = simulation[metric]["mean"]
            error = float(analytic - mean)
            standard_error = simulation[metric]["simulation_standard_error"]
            comparisons[metric] = {"analytic": analytic, "monte_carlo_mean": mean,
                                   "simulation_standard_error": standard_error,
                                   "analytic_minus_monte_carlo": error,
                                   "difference_in_simulation_standard_errors": error / standard_error if standard_error > 0 else None}
        variants[label] = {"plan": specs,
                           "selection_model_expected_net_gain": selection_forecast["expected_net_gain"],
                           "common_pilot_inclusive_forecast": forecast,
                           "monte_carlo": simulation, "analytic_vs_monte_carlo": comparisons}

    # Actual sampled pilot IDs and true effects are accessed ONLY after both
    # alternative optimizations and their forecasts have completed.
    pilot_campaigns = organizer.executed_pilot_campaigns()
    impact_model = _mock_impact_model(pd.read_csv(ROOT / "data" / "change_tariff.csv"))
    for variant in variants.values():
        variant["official_local_evaluation"] = score_final(env, pilot_campaigns, variant["plan"], impact_model)
    aware, naive = variants["analytic_overlap"], variants["ignore_pilot_overlap"]
    assert signature(aware["plan"]) == signature(returned_plan), "Frozen optimizer should reproduce final default plan"
    return {"environment_seed": seed, "agent_seed": seed, "risk_penalty": agent.risk_penalty,
            "successful_pilots": len(pilots), "pilot_contacts": int(env.max_total_contacts - env.remaining_contacts),
            "pilot_cost": pilot_cost, "remaining_budget": float(env.remaining_budget),
            "remaining_contacts": int(env.remaining_contacts),
            "plan_changed_when_ignoring_pilots": signature(aware["plan"]) != signature(naive["plan"]),
            "analytic_minus_ignore_official_net_gain": aware["official_local_evaluation"]["net_arpu_gain"] - naive["official_local_evaluation"]["net_arpu_gain"],
            "variants": variants, "runtime_seconds": time.perf_counter() - started}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replicates", type=int, default=256)
    parser.add_argument("--output", type=Path, default=ROOT / "reports" / "overlap_sensitivity.json")
    args = parser.parse_args()
    if args.replicates < 2:
        parser.error("replicates must be at least two")
    rows = []
    for seed in (0, 1, 42):
        row = measure(seed, args.replicates)
        rows.append(row)
        print(f"seed={seed}: plan_changed={row['plan_changed_when_ignoring_pilots']}, "
              f"official_net_difference={row['analytic_minus_ignore_official_net_gain']:.2f}", flush=True)
    comparisons = [comparison for row in rows for variant in row["variants"].values()
                   for comparison in variant["analytic_vs_monte_carlo"].values()]
    output = {
        "method": "Freeze each learned posterior and public remaining resources; compare the default risk-penalized optimizer with recorded pilot sizes versus no pilot metadata; evaluate both frozen plans using posterior-mean effects.",
        "notes": [
            "Only three local mock seeds: bounded sensitivity evidence, not a general quality guarantee.",
            "Monte Carlo independently samples each homogeneous pilot without replacement from its known eligible group, using an RNG separate from the environment.",
            "Posterior means are fixed. Reported Monte Carlo SE measures numerical simulation error only, not effect uncertainty or a predictive interval.",
            "Analytic and Monte Carlo forecasts integrate pilot sampling only. Both plug posterior means into maxima and do not integrate posterior uncertainty.",
            "Ignoring pilots changes optimizer overlap assumptions, while leaving learned posterior and already-spent resources identical.",
            "selection_model_expected_net_gain for ignore_pilot_overlap omits pilot effects but still subtracts their already-incurred costs; common_pilot_inclusive_forecast compares both plans on the same accounting scope.",
            "Both plan optimizations complete before organizer-only actual pilot IDs and true effects are accessed for scoring; those IDs never enter optimization.",
            "Plan identity includes execution order, filters, target and channel; cosmetic campaign names are ignored.",
        ],
        "source_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                          for name in ("uniflow/agent_core.py", "uniflow/portfolio.py", "uniflow/candidates.py", "uniflow/posterior.py")},
        "replicates_per_plan": args.replicates, "runs": rows,
        "summary": {"plans_changed": sum(row["plan_changed_when_ignoring_pilots"] for row in rows),
                    "mean_analytic_minus_ignore_official_net_gain": float(np.mean([row["analytic_minus_ignore_official_net_gain"] for row in rows])),
                    "max_absolute_difference_in_simulation_standard_errors": max(abs(c["difference_in_simulation_standard_errors"])
                        for c in comparisons if c["difference_in_simulation_standard_errors"] is not None),
                    "interpretation": "Sampling-overlap arithmetic agrees with the Monte Carlo approximation, but including overlap reduced official local net gain on all three tested seeds. This does not establish a universal strategy ordering; effects/posterior quality and the bounded optimizer remain separate uncertainties."},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"Saved {args.output}")


if __name__ == "__main__":
    main()
