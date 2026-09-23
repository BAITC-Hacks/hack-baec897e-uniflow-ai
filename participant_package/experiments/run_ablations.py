"""Small fixed-seed ablations of prior, risk penalty, and portfolio search."""

from __future__ import annotations

from pathlib import Path
import sys

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from agent import Agent
from experiments.run_benchmarks import evaluate


REPORTS = ROOT / "reports"


VARIANTS = {
    "full": lambda: Agent(),
    "no_history_prior": lambda: Agent(use_history=False),
    "no_risk_penalty": lambda: Agent(risk_penalty=0.0),
    "no_advanced_search": lambda: Agent(advanced_search=False),
}


def run(seeds=(0, 1, 42)) -> pd.DataFrame:
    rows = []
    for seed in seeds:
        for name, factory in VARIANTS.items():
            row = evaluate(factory, name, int(seed))
            rows.append(row)
            print(f"{name:>18} seed={seed:2} net={row['net_arpu_gain']:>12,.0f} "
                  f"pilots={row['n_pilots']:2}")
    raw = pd.DataFrame(rows)
    REPORTS.mkdir(parents=True, exist_ok=True)
    summary = raw.groupby("agent", sort=True).agg(
        runs=("net_arpu_gain", "count"), mean_net=("net_arpu_gain", "mean"),
        median_net=("net_arpu_gain", "median"), min_net=("net_arpu_gain", "min"),
        negative_runs=("net_arpu_gain", lambda s: int((s < 0).sum())),
        mean_cost=("total_cost", "mean"), mean_contacts=("total_contacts", "mean"),
        mean_pilots=("n_pilots", "mean"), mean_runtime_seconds=("runtime_seconds", "mean"),
    ).reset_index()
    raw.to_csv(REPORTS / "ablation_runs.csv", index=False)
    summary.to_csv(REPORTS / "ablation.csv", index=False)
    return summary


if __name__ == "__main__":
    print(run().to_string(index=False))
