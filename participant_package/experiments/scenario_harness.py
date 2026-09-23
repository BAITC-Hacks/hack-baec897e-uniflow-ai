"""Run the agent on several explicit, locally constructed impact models.

These are robustness probes, not estimates of the hidden judging model.
"""

from __future__ import annotations

from pathlib import Path
import sys
import time

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from agent import Agent
from mock_environment import CHANNELS, TOTAL_BUDGET, MAX_TOTAL_CONTACTS, _mock_fallback
from environment import make_environment
from scoring_core import MAX_CAMPAIGNS, score_campaigns, sanitize_campaigns


REPORTS = ROOT / "reports"


def scenario_model(name: str, seed: int = 2026) -> pd.DataFrame:
    profile = pd.read_csv(ROOT / "customer_profile.csv")
    tariffs = pd.read_csv(ROOT / "data" / "dict_tariff.csv")
    changes = pd.read_csv(ROOT / "data" / "change_tariff.csv")
    price = dict(zip(tariffs["tariff_plan_code"], tariffs["price_tariff"]))
    rows = profile[["current_tariff", "arpu_segment"]].dropna().drop_duplicates()
    targets = tariffs["tariff_plan_code"].astype(str).tolist()
    grid = rows.assign(_k=1).merge(pd.DataFrame({"tariff_plan_code_to": targets, "_k": 1}), on="_k").drop(columns="_k")
    history = changes.copy()
    prev = history["AVG_ARPU_PREV_3M"]
    nxt = history["AVG_ARPU_NEXT_3M"]
    history["arpu_segment"] = pd.cut(prev, [-np.inf, 1_000, 5_000, np.inf], labels=["LOW", "MID", "HIGH"])
    history["arpu_change_pct"] = ((nxt - prev) / prev.replace(0, np.nan)).clip(-1, 3)
    history = history.loc[prev >= 100]
    base = (history.groupby(["tariff_plan_code_from", "arpu_segment", "tariff_plan_code_to"], observed=True)
            .agg(arpu_change_pct=("arpu_change_pct", "mean"), count=("ID_NUMBER", "size"))
            .reset_index())
    base = grid.merge(base, left_on=["current_tariff", "arpu_segment", "tariff_plan_code_to"],
                      right_on=["tariff_plan_code_from", "arpu_segment", "tariff_plan_code_to"], how="left")
    target_count = history.groupby(["tariff_plan_code_from", "arpu_segment", "tariff_plan_code_to"], observed=True).size()
    src_total = history.groupby(["tariff_plan_code_from", "arpu_segment"], observed=True).size()
    probs = []
    for row in base.itertuples(index=False):
        src = row.current_tariff
        seg = row.arpu_segment
        tgt = row.tariff_plan_code_to
        denom = float(src_total.get((src, seg), 0))
        count = float(target_count.get((src, seg, tgt), 0))
        probs.append((count + 40 * 0.05) / (denom + 40))
    base["conversion_rate"] = probs
    missing = base["arpu_change_pct"].isna()
    base.loc[missing, "arpu_change_pct"] = [
        np.clip((price.get(tgt, 0) - price.get(src, 0)) / max(price.get(src, 0), 5_000) * 0.25, -0.4, 0.4)
        for src, tgt in zip(base.loc[missing, "current_tariff"], base.loc[missing, "tariff_plan_code_to"])
    ]
    model = base.drop(columns=["tariff_plan_code_from"], errors="ignore").rename(
        columns={"current_tariff": "tariff_plan_code_from"}
    )[
        ["tariff_plan_code_from", "tariff_plan_code_to", "arpu_segment", "arpu_change_pct", "conversion_rate"]
    ].copy()
    model["tariff_plan_code_from"] = model["tariff_plan_code_from"].astype(str)
    rng = np.random.default_rng(seed)

    if name == "leader_shift_to_tariff_17":
        model["arpu_change_pct"] = np.where(model["tariff_plan_code_to"].eq("tariff_17"), 0.40, -0.12)
        model["conversion_rate"] = 0.28
    elif name == "reversed_effect_signs":
        model["arpu_change_pct"] = -model["arpu_change_pct"].abs().clip(lower=0.05)
        model["conversion_rate"] = model["conversion_rate"].clip(0.05, 0.35)
    elif name == "low_conversion":
        model["conversion_rate"] = 0.06
        model["arpu_change_pct"] = model["arpu_change_pct"].clip(-0.4, 0.6)
    elif name == "call_saturation":
        model["conversion_rate"] = 0.95
        model["arpu_change_pct"] = 0.15
    elif name == "weak_history_signal":
        model["arpu_change_pct"] = rng.uniform(-0.30, 0.40, len(model))
        model["conversion_rate"] = rng.uniform(0.08, 0.65, len(model))
    else:
        raise ValueError(f"Unknown scenario: {name}")
    model["conversion_rate"] = model["conversion_rate"].clip(0.01, 1.0)
    return model


def evaluate_scenario(name: str, seed: int) -> dict:
    profile = pd.read_csv(ROOT / "customer_profile.csv")
    tariffs = pd.read_csv(ROOT / "data" / "dict_tariff.csv")
    changes = pd.read_csv(ROOT / "data" / "change_tariff.csv")
    # Public mock fallback, used only for source/ARPU combinations absent from
    # the generated scenario matrix. The scenario impact model is not the agent's input.
    fallback_conversion = 0.20

    def fallback(source, target, segment, tariff_table, _fallback_p):
        prices = tariff_table.set_index("tariff_plan_code")["price_tariff"]
        if source not in prices.index or target not in prices.index:
            return 0.0, fallback_conversion
        scale = max(float(prices.median()), 1.0)
        return float(np.clip((prices[target] - prices[source]) / scale * 0.2, -0.5, 0.5)), fallback_conversion

    env, internals = make_environment(
        customer_profile=profile,
        impact_model=scenario_model(name, seed),
        dict_tariff=tariffs,
        channels=CHANNELS,
        total_budget=TOTAL_BUDGET,
        max_total_contacts=MAX_TOTAL_CONTACTS,
        fallback_predict=fallback,
        seed=seed,
    )
    agent = Agent()
    started = time.perf_counter()
    campaigns = sanitize_campaigns(agent.act(env) or [], env.tariffs)[:MAX_CAMPAIGNS]
    runtime = time.perf_counter() - started
    pilots = internals.executed_pilot_campaigns()
    strategy = pd.DataFrame(pilots + campaigns)
    for col in ["filter_arpu_segment", "filter_data_segment", "filter_call_segment", "filter_current_tariff", "explicit_ids"]:
        if col not in strategy:
            strategy[col] = None
    # Scoring uses the same scenario passed to the public environment.
    result = score_campaigns(strategy, profile, scenario_model(name, seed), tariffs,
                             float(profile["predicted_arpu"].sum()), fallback,
                             team_id=name)
    return {
        "scenario": name, "seed": seed, "net_arpu_gain": float(result["net_arpu_gain"]),
        "gross_arpu_lift": float(result["gross_arpu_lift"]), "total_cost": float(result["total_cost"]),
        "contacts": int(result["total_contacts"]), "pilots": len(pilots),
        "final_campaigns": len(campaigns), "risk_score_pct": float(result["risk_score_pct"]),
        "runtime_seconds": runtime,
    }


def run(seeds=(42,)) -> pd.DataFrame:
    names = ["leader_shift_to_tariff_17", "reversed_effect_signs", "low_conversion",
             "call_saturation", "weak_history_signal"]
    rows = []
    for name in names:
        for seed in seeds:
            row = evaluate_scenario(name, int(seed))
            rows.append(row)
            print(f"{name:>28} seed={seed} net={row['net_arpu_gain']:>12,.0f} "
                  f"pilots={row['pilots']:2} cost={row['total_cost']:>9,.0f}")
    frame = pd.DataFrame(rows)
    REPORTS.mkdir(parents=True, exist_ok=True)
    frame.to_csv(REPORTS / "scenario_results.csv", index=False)
    return frame


if __name__ == "__main__":
    print(run().to_string(index=False))
