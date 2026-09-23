"""Small prior-strength and pilot-overlap sensitivity study on paired seeds."""
from __future__ import annotations

import argparse
import json

import pandas as pd

from agent import Agent
from environment import make_environment
from scoring_core import CHANNELS, MAX_TOTAL_CONTACTS, TOTAL_BUDGET, score_campaigns
from mock_environment import _mock_fallback
from uniflow.portfolio import describe_portfolio, optimize
from .benchmark import FILTERS, REPORTS, evaluate, load_inputs, write_report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=3)
    args = parser.parse_args()
    profile, tariffs, model = load_inputs()
    rows, comparisons = [], []
    for strength in (.5, 1.0, 2.0):
        for seed in range(args.runs):
            agent = Agent(history_strength=strength)
            rows.append(evaluate(agent, profile, tariffs, model, seed, f"history_x{strength:g}"))
            write_report("prior_sensitivity", rows)
    for seed in range(args.runs):
        env, organizer = make_environment(profile, model, tariffs, CHANNELS,
            TOTAL_BUDGET, MAX_TOTAL_CONTACTS, _mock_fallback, seed=seed)
        agent = Agent()
        actual_plan = agent.act(env)
        # Remove known pilot sampling from the planner, preserving observations,
        # costs, remaining resources, posteriors, and the same candidate set.
        ignored = optimize(agent.space, agent.posterior, [], env.remaining_budget,
            env.remaining_contacts, agent.risk_penalty, agent.allowed_channels, thorough=True)
        ignored_views, _ = describe_portfolio(agent.space, agent.posterior, [], ignored,
            TOTAL_BUDGET - env.remaining_budget)
        ignored_plan = [row["spec"] for row in ignored_views]
        plans = {"analytic_overlap": actual_plan, "ignore_pilot_overlap": ignored_plan}
        for method, final in plans.items():
            combined = pd.DataFrame(organizer.executed_pilot_campaigns() + final)
            for column in FILTERS + ["explicit_ids"]:
                if column not in combined:
                    combined[column] = None
            scored = score_campaigns(combined, profile, model, tariffs,
                float(profile.predicted_arpu.sum()), _mock_fallback)
            comparisons.append({"seed": seed, "method": method,
                "net_arpu_gain": scored["net_arpu_gain"],
                "total_contacts": scored["total_contacts"], "communication_cost": scored["total_cost"],
                "unique_customers": scored["unique_customers_targeted"],
                "plan_changed": actual_plan != ignored_plan,
                "n_final_campaigns": len(final)})
        pd.DataFrame(comparisons).to_csv(REPORTS / "overlap_sensitivity.csv", index=False)
    explanation = {
        "prior_sensitivity": "Multiply weak historical mean ranking by 0.5, 1, 2 before the same clipping; prior variance stays broad and unchanged. Paired noise seeds, standard agent seed42.",
        "overlap_sensitivity": "Compare final analytic pilot inclusion against ignoring pilot overlap, holding learned posterior and spent pilot resources fixed. Scorer uses actual hidden pilot IDs only after both plans are fixed. Agent does not see the scores.",
        "limits": "Three local-model seeds are a sensitivity check, not statistical evidence of judging performance. Analytic inclusion is exact under uniform independent sampling at fixed posterior means; uncertainty of the maximum over uncertain effect parameters is not integrated.",
    }
    (REPORTS / "sensitivity_notes.json").write_text(json.dumps(explanation, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
