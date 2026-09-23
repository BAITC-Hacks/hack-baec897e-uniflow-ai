"""Measure planner caching separately from changes in exploration and objective."""
from __future__ import annotations

import json
from statistics import median
from time import perf_counter

from mock_environment import make_mock_env
from orbitduo.portfolio import optimize
from .benchmark import REPORTS, ROOT
from .reference_v1 import Agent
from .reference_v1.portfolio import optimize as original_optimize


def signature(plan):
    return [(candidate.spec(str(i)), indices.tolist(), fallback)
            for i, (candidate, indices, fallback) in enumerate(plan)]


def main():
    env, _ = make_mock_env(seed=42, data_dir=str(ROOT / "data"), profile_path=str(ROOT / "customer_profile.csv"))
    agent = Agent()
    agent.act(env)
    args = (agent.space, agent.posterior, agent._pilots, env.remaining_budget,
            env.remaining_contacts, agent.risk_penalty, agent._channels)
    original = original_optimize(*args, thorough=True)
    cached = optimize(*args, thorough=True, local_search=False, resource_prices=False)
    assert signature(original) == signature(cached), "Cache-only optimization changed the selected plan"
    durations = {"original": [], "cached_identical_objective": [], "new_search": []}
    for _ in range(5):
        for name, callback in (
            ("original", lambda: original_optimize(*args, thorough=True)),
            ("cached_identical_objective", lambda: optimize(*args, thorough=True, local_search=False, resource_prices=False)),
            ("new_search", lambda: optimize(*args, thorough=True)),
        ):
            start = perf_counter()
            callback()
            durations[name].append(perf_counter() - start)
    medians = {name: median(times) for name, times in durations.items()}
    report = {"seed": 42, "repetitions": 5,
              "method": "Frozen v1 public posterior and spent resources. Alternating calls; loading and pilot time excluded. Cache-only output equals old specs and actual audiences.",
              "identical_cache_only_plan": True, "seconds": durations, "median_seconds": medians,
              "cache_speedup": medians["original"] / medians["cached_identical_objective"],
              "full_search_speedup": medians["original"] / medians["new_search"]}
    (REPORTS / "planner_benchmark.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
