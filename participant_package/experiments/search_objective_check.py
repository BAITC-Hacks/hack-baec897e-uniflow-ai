"""Compare planners on identical frozen public posteriors, without scoring truth.

Run from participant_package: python -m experiments.search_objective_check
This checks the planner's own risk objective, not realized campaign quality.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import time

import numpy as np

from agent import Agent
from mock_environment import make_mock_env
from uniflow.portfolio import optimize, replay_plan

ROOT = Path(__file__).resolve().parents[1]


def hashes():
    return {f"uniflow/{name}": hashlib.sha256((ROOT / "uniflow" / name).read_bytes()).hexdigest()
            for name in ("agent_core.py", "posterior.py", "candidates.py", "portfolio.py")}


def public_objective(agent, env, chosen):
    """Independent scalar overlap calculation after public ID-ordered replay."""
    space, posterior, risk = agent.space, agent.posterior, agent.risk_penalty
    specs = [candidate.spec(f"objective_{number}") for number, (candidate, _, _) in enumerate(chosen)]
    replay = replay_plan(space.profile, specs, space.channels, env.remaining_budget,
                         env.remaining_contacts, space.tariffs)
    indexes = {customer: index for index, customer in enumerate(space.profile.ID_NUMBER)}
    final_effect = np.full(len(space.profile), np.nan)
    for (candidate, _, _), row in zip(chosen, replay):
        effect = candidate.mean - risk * np.sqrt(candidate.variance)
        for customer in row["customer_ids"]:
            index = indexes[customer]
            final_effect[index] = effect if np.isnan(final_effect[index]) else max(final_effect[index], effect)
    initial_gross, final_gross = 0.0, 0.0
    for group, audience in space.groups.items():
        possibilities = []
        for pilot in agent._pilots:
            if pilot["group"] == group:
                mean, variance, _ = posterior.get(group, pilot["target"], pilot["channel"])
                possibilities.append((float(mean - risk * np.sqrt(variance)), min(1.0, pilot["n"] / len(audience.indices))))
        chance_none, outcomes = 1.0, []
        for effect, probability in sorted(possibilities, reverse=True):
            outcomes.append((effect, probability * chance_none))
            chance_none *= 1 - probability
        before = sum(effect * probability for effect, probability in outcomes)
        initial_gross += float(space.baseline[audience.indices].sum()) * before
        for index in audience.indices:
            effect = final_effect[index]
            after = before if np.isnan(effect) else chance_none * effect + sum(
                max(effect, pilot_effect) * probability for pilot_effect, probability in outcomes)
            final_gross += float(space.baseline[index]) * after
    final_cost = sum(row["cost"] for row in replay)
    pilot_cost = float(env.total_budget - env.remaining_budget)
    return {"risk_adjusted_incremental_final_objective": final_gross - initial_gross - final_cost,
            "risk_adjusted_total_objective_including_pilots": final_gross - final_cost - pilot_cost,
            "final_cost": final_cost, "final_contacts": sum(row["n_customers"] for row in replay),
            "final_campaigns": len(replay), "specs": specs}


def main():
    before = hashes()
    rows = []
    for seed in (42, 1):
        env, _ = make_mock_env(seed=seed)
        agent = Agent()
        agent.act(env)
        for label, options in (("basic", {"resource_prices": False, "local_search": False}),
                               ("money_prices", {"resource_prices": True, "local_search": False}),
                               ("full", {"resource_prices": True, "local_search": True})):
            timings = []
            for _ in range(5):
                started = time.perf_counter()
                chosen = optimize(agent.space, agent.posterior, agent._pilots,
                                  env.remaining_budget, env.remaining_contacts,
                                  agent.risk_penalty, agent._channels, thorough=True, **options)
                timings.append(time.perf_counter() - started)
            rows.append({"seed": seed, "variant": label, "median_runtime_seconds": float(np.median(timings)),
                         "timing_repetitions": len(timings), **public_objective(agent, env, chosen)})
    assert before == hashes(), "Decision code changed during frozen-posterior comparison"
    comparisons = []
    for seed in (42, 1):
        variants = {row["variant"]: row for row in rows if row["seed"] == seed}
        key = "risk_adjusted_incremental_final_objective"
        comparisons.append({"seed": seed,
            "full_minus_basic_objective": variants["full"][key] - variants["basic"][key],
            "money_prices_minus_basic_objective": variants["money_prices"][key] - variants["basic"][key],
            "local_search_extra_objective": variants["full"][key] - variants["money_prices"][key],
            "same_specs_full_and_basic": variants["full"]["specs"] == variants["basic"]["specs"]})
    result = {"scope": "Post-hoc diagnostic on one development seed and submission seed, not held-out validation.",
              "method": "Each agent runs once. All planner variants then receive its identical frozen public posterior, pilot requests and remaining resources. Five optimizer timing repetitions. Independent scalar public-rule objective replay.",
              "limitations": "Risk-adjusted posterior-mean objective is a heuristic with analytic pilot overlap. No true effects or official score are used in planner comparison; a higher objective would not prove a realized-net gain.",
              "decision_code_sha256": before, "results": rows, "comparisons": comparisons}
    path = ROOT / "reports" / "search_objective_check.json"
    path.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps(comparisons, indent=2))


if __name__ == "__main__":
    main()
