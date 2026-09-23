"""Same-seed comparison of the supplied template and the adaptive agent."""

from __future__ import annotations

from pathlib import Path
import time
import sys

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from agent import Agent
from agent_template import Agent as TemplateAgent
from local_eval import CAMPAIGN_FILTER_COLUMNS
from mock_environment import make_mock_env, _mock_fallback, _mock_impact_model
from scoring_core import MAX_CAMPAIGNS, score_campaigns, sanitize_campaigns


REPORTS = ROOT / "reports"


def evaluate(factory, name: str, seed: int) -> dict:
    env, internals = make_mock_env(seed=seed, data_dir=str(ROOT / "data"),
                                   profile_path=str(ROOT / "customer_profile.csv"))
    agent = factory()
    started = time.perf_counter()
    campaigns = agent.act(env) or []
    runtime = time.perf_counter() - started
    campaigns = sanitize_campaigns(campaigns, env.tariffs)[:MAX_CAMPAIGNS]
    pilots = internals.executed_pilot_campaigns()
    strategy = pd.DataFrame(pilots + campaigns)
    if strategy.empty:
        return {"agent": name, "seed": seed, "net_arpu_gain": float("nan"),
                "gross_arpu_lift": 0.0, "total_cost": 0.0, "total_contacts": 0,
                "n_pilots": 0, "n_final_campaigns": 0, "runtime_seconds": runtime}
    for column in CAMPAIGN_FILTER_COLUMNS + ["explicit_ids"]:
        if column not in strategy:
            strategy[column] = None
    profile = env.customer_profile
    baseline = float(profile["predicted_arpu"].sum())
    changes = pd.read_csv(ROOT / "data" / "change_tariff.csv")
    impact = _mock_impact_model(changes)
    result = score_campaigns(strategy, profile, impact, env.tariffs, baseline,
                             _mock_fallback, team_id=name)
    return {
        "agent": name, "seed": seed,
        "net_arpu_gain": float(result["net_arpu_gain"]),
        "gross_arpu_lift": float(result["gross_arpu_lift"]),
        "total_cost": float(result["total_cost"]),
        "total_contacts": int(result["total_contacts"]),
        "unique_customers_targeted": int(result["unique_customers_targeted"]),
        "n_pilots": len(pilots), "n_final_campaigns": len(campaigns),
        "runtime_seconds": runtime,
        "risk_score_pct": float(result["risk_score_pct"]),
    }


def run(runs: int = 10) -> tuple[pd.DataFrame, pd.DataFrame]:
    factories = [("template", TemplateAgent), ("adaptive", Agent)]
    rows = []
    for seed in range(runs):
        for name, factory in factories:
            row = evaluate(factory, name, seed)
            rows.append(row)
            print(f"{name:>8} seed={seed:2} net={row['net_arpu_gain']:>12,.0f} "
                  f"pilots={row['n_pilots']:2} runtime={row['runtime_seconds']:.2f}s")
    raw = pd.DataFrame(rows)
    summary_rows = []
    for name, group in raw.groupby("agent", sort=True):
        values = group["net_arpu_gain"].dropna()
        summary_rows.append({
            "agent": name,
            "runs": int(len(values)),
            "mean_net": float(values.mean()),
            "median_net": float(values.median()),
            "min_net": float(values.min()),
            "p10_net": float(values.quantile(0.10)),
            "negative_runs": int((values < 0).sum()),
            "mean_cost": float(group["total_cost"].mean()),
            "mean_contacts": float(group["total_contacts"].mean()),
            "mean_pilots": float(group["n_pilots"].mean()),
            "mean_runtime_seconds": float(group["runtime_seconds"].mean()),
        })
    summary = pd.DataFrame(summary_rows)
    REPORTS.mkdir(parents=True, exist_ok=True)
    raw.to_csv(REPORTS / "benchmark_runs.csv", index=False)
    summary.to_csv(REPORTS / "benchmark.csv", index=False)
    return raw, summary


if __name__ == "__main__":
    raw, summary = run()
    print("\nИтог по одинаковым seed:")
    print(summary.to_string(index=False))
