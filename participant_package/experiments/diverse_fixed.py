"""Independent comparison of frozen reconnaissance with explicit group diversity.

python -m experiments.diverse_fixed --runs 10 --scenario-runs 3
Uses the same public factory, effect families and paired seeds as benchmark.py.
"""
from __future__ import annotations
import argparse
from collections import Counter

from agent import Agent
from .benchmark import SCENARIOS, complete_model, evaluate, load_inputs, scenario_model, write_report


def checked_agent_result(profile, tariffs, model, seed, scenario):
    agent = Agent(adaptive=False, diverse_fixed=True)
    row = evaluate(agent, profile, tariffs, model, seed, "diverse_fixed", scenario)
    counts = Counter((p["campaign"]["filter_current_tariff"], p["campaign"]["filter_arpu_segment"])
                     for p in agent.report["pilots"])
    assert len(counts) >= min(6, len(agent.space.groups), len(agent.report["pilots"]))
    assert max(counts.values()) <= 4
    row["pilot_groups"] = len(counts)
    row["max_pilots_per_group"] = max(counts.values())
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--scenario-runs", type=int, default=3)
    args = parser.parse_args()
    profile, tariffs, model = load_inputs()
    rows = []
    for seed in range(args.runs):
        rows.append(checked_agent_result(profile, tariffs, model, seed, "mock"))
        write_report("diverse_fixed", rows)
    full = complete_model(profile, tariffs, model)
    for name in SCENARIOS:
        changed = scenario_model(name, full)
        for seed in range(args.scenario_runs):
            rows.append(checked_agent_result(profile, tariffs, changed, seed, name))
            write_report("diverse_fixed", rows)


if __name__ == "__main__":
    main()
