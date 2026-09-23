"""Reproducible baseline, paired strategies, ablations and held-out effect families.

Run from participant_package: python -m experiments.benchmark --baseline-only
or: python -m experiments.benchmark --runs 10 --scenario-runs 3
Hidden effect tables exist only in this evaluation harness. Agent receives env only.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import platform
import time
from importlib import metadata
from pathlib import Path

import numpy as np
import pandas as pd

from agent_template import Agent as TemplateAgent
from environment import make_environment
from mock_environment import _mock_fallback, _mock_impact_model
from scoring_core import CHANNELS, MAX_TOTAL_CONTACTS, TOTAL_BUDGET, sanitize_campaigns, score_campaigns, validate_strategy

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"
FILTERS = ["filter_arpu_segment", "filter_data_segment", "filter_call_segment", "filter_current_tariff"]
ALLOWED_FIELDS = {"campaign_name", "target_tariff", "channel", *FILTERS}
SCENARIOS = ("permuted_leaders", "sign_reversed", "weak_history", "low_conversion", "saturated_calls", "near_zero")


def source_hashes():
    names = ["environment.py", "scoring_core.py", "mock_environment.py", "local_eval.py", "make_submission.py", "agent_template.py", "customer_profile.csv", "data/change_tariff.csv", "data/dict_tariff.csv"]
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in names}


def load_inputs():
    profile = pd.read_csv(ROOT / "customer_profile.csv")
    tariffs = pd.read_csv(ROOT / "data/dict_tariff.csv")
    history = pd.read_csv(ROOT / "data/change_tariff.csv")
    return profile, tariffs, _mock_impact_model(history)


def complete_model(profile, tariffs, model):
    """Materialize the documented local fallback before constructing test families."""
    indexed = model.set_index(["tariff_plan_code_from", "arpu_segment", "tariff_plan_code_to"])
    conversion = float(model.conversion_rate.median())
    records = []
    for source in tariffs.tariff_plan_code:
        for segment in ("LOW", "MID", "HIGH"):
            for target in tariffs.tariff_plan_code:
                key = source, segment, target
                if key in indexed.index:
                    row = indexed.loc[key]
                    delta, probability = float(row.arpu_change_pct), float(row.conversion_rate)
                else:
                    delta, probability = _mock_fallback(source, target, segment, tariffs, conversion)
                records.append({"tariff_plan_code_from": source, "arpu_segment": segment,
                                "tariff_plan_code_to": target, "arpu_change_pct": delta,
                                "conversion_rate": probability})
    return pd.DataFrame(records)


def scenario_model(name, complete):
    result = complete.copy()
    rng = np.random.default_rng(20260923)
    if name == "permuted_leaders":
        # Different target ordering in each source/segment, retaining effect scale.
        for _, indexes in result.groupby(["tariff_plan_code_from", "arpu_segment"], sort=True).groups.items():
            indexes = np.asarray(list(indexes))
            shuffled = rng.permutation(indexes)
            result.loc[indexes, ["arpu_change_pct", "conversion_rate"]] = result.loc[shuffled, ["arpu_change_pct", "conversion_rate"]].to_numpy()
    elif name == "sign_reversed":
        result["arpu_change_pct"] *= -1
    elif name == "weak_history":
        result["arpu_change_pct"] = rng.uniform(-0.35, 0.55, len(result))
        result["conversion_rate"] = rng.uniform(0.15, 0.75, len(result))
    elif name == "low_conversion":
        result["conversion_rate"] *= 0.03
    elif name == "saturated_calls":
        result["arpu_change_pct"] = rng.uniform(-0.15, 0.45, len(result))
        result["conversion_rate"] = 0.98
    elif name == "near_zero":
        result["arpu_change_pct"] = rng.uniform(-0.002, 0.002, len(result))
        result["conversion_rate"] = 0.5
    else:
        raise ValueError(name)
    return result


def evaluate(agent, profile, tariffs, model, seed, strategy, scenario="mock", strict=True):
    env, scoring_access = make_environment(profile, model, tariffs, CHANNELS,
        TOTAL_BUDGET, MAX_TOTAL_CONTACTS, _mock_fallback, seed=seed)
    started = time.perf_counter()
    final = agent.act(env)
    runtime = time.perf_counter() - started
    if not isinstance(final, list):
        raise AssertionError("Agent.act must return list")
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        valid = sanitize_campaigns(final, tariffs)
    if len(valid) != len(final):
        raise AssertionError(captured.getvalue())
    if any(set(campaign) - ALLOWED_FIELDS for campaign in final):
        raise AssertionError("Undeclared final campaign fields")
    if final:
        validate_strategy(pd.DataFrame(final), tariffs)
    pilots = scoring_access.executed_pilot_campaigns()
    if not pilots and not final:
        raise AssertionError("No actual contacts")
    all_campaigns = pd.DataFrame(pilots + final)
    for column in FILTERS + ["explicit_ids"]:
        if column not in all_campaigns:
            all_campaigns[column] = None
    score = score_campaigns(all_campaigns, profile, model, tariffs,
        float(profile.predicted_arpu.sum()), _mock_fallback, team_id=strategy)
    final_counts = [row["n_contacts"] for row in score["campaigns_detail"][len(pilots):]]
    conforms = bool(1 <= len(final) <= 10 and 1 <= len(pilots) <= 20
        and all(0 < n <= 5000 for n in final_counts)
        and score["total_contacts"] <= MAX_TOTAL_CONTACTS
        and score["total_cost"] <= TOTAL_BUDGET and runtime < 300)
    if strict and not conforms:
        raise AssertionError(f"Nonconforming {strategy}/{scenario}/{seed}: final={final_counts}, score={score}")
    # Public resource state tracks pilots only; scorer includes final contacts too.
    assert sum(row["n_customers"] for row in env.pilot_history) == MAX_TOTAL_CONTACTS - env.remaining_contacts
    assert sum(row["cost"] for row in env.pilot_history) == TOTAL_BUDGET - env.remaining_budget
    row = {"scenario": scenario, "strategy": strategy, "seed": seed, "agent_seed": 42,
        "net_arpu_gain": score["net_arpu_gain"], "gross_gain": score["gross_arpu_lift"],
        "communication_cost": score["total_cost"], "total_contacts": score["total_contacts"],
        "unique_customers": score["unique_customers_targeted"], "n_pilots": len(pilots),
        "n_final_campaigns": len(final), "runtime_seconds": runtime,
        "negative": score["net_arpu_gain"] < 0, "conforms": conforms}
    print(f"{scenario:18} {strategy:15} seed={seed:2} net={row['net_arpu_gain']:12,.2f} pilots={len(pilots):2} final={len(final):2} time={runtime:.2f}s", flush=True)
    return row


def summarize(rows):
    frame = pd.DataFrame(rows)
    records = []
    for (scenario, strategy), group in frame.groupby(["scenario", "strategy"], sort=True):
        net = group.net_arpu_gain
        record = {"scenario": scenario, "strategy": strategy, "runs": len(group),
            "mean_net": float(net.mean()), "median_net": float(net.median()),
            "min_net": float(net.min()), "p10_net": float(net.quantile(0.1)),
            "negative_fraction": float(group.negative.mean()), "all_conform": bool(group.conforms.all())}
        for col in ("communication_cost", "total_contacts", "unique_customers", "n_pilots", "n_final_campaigns", "runtime_seconds"):
            record["mean_" + col] = float(group[col].mean())
        record["max_runtime_seconds"] = float(group.runtime_seconds.max())
        records.append(record)
    return records


def write_report(name, rows):
    REPORTS.mkdir(exist_ok=True)
    pd.DataFrame(rows).to_csv(REPORTS / f"{name}.csv", index=False)
    (REPORTS / f"{name}_summary.json").write_text(json.dumps(summarize(rows), indent=2, allow_nan=False), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=10)
    parser.add_argument("--scenario-runs", type=int, default=3)
    parser.add_argument("--baseline-only", action="store_true")
    args = parser.parse_args()
    if args.runs < 1 or args.scenario_runs < 1:
        parser.error("run counts must be positive")
    profile, tariffs, model = load_inputs()
    metadata_record = {"python": platform.python_version(), "platform": platform.platform(),
        "versions": {name: metadata.version(name) for name in ("numpy", "pandas", "pytest")},
        "organizer_and_data_sha256": source_hashes(), "seeds": list(range(args.runs)),
        "agent_seed": 42, "scenario_model_seed": 20260923,
        "note": "Mock seed changes sampling/noise only. Families change true effects separately. p10 with ten runs is a coarse descriptive estimate, not a guarantee. Runtime measures act(), excluding loading/scoring."}
    REPORTS.mkdir(exist_ok=True)
    (REPORTS / "experiment_environment.json").write_text(json.dumps(metadata_record, indent=2), encoding="utf-8")
    baseline = [evaluate(TemplateAgent(), profile, tariffs, model, seed, "template", strict=False) for seed in range(args.runs)]
    write_report("baseline", baseline)
    if args.baseline_only:
        return
    from agent import Agent
    main_rows = list(baseline)
    for name, options in (("fixed", {"adaptive": False}), ("adaptive", {})):
        for seed in range(args.runs):
            main_rows.append(evaluate(Agent(**options), profile, tariffs, model, seed, name))
            write_report("benchmark", main_rows)
    ablations = [row for row in main_rows if row["strategy"] in ("fixed", "adaptive")
                 and row["seed"] < min(args.runs, 3)]
    for name, options in (("no_prior", {"use_history": False}), ("no_risk_penalty", {"risk_penalty": 0.0}), ("push_only", {"allowed_channels": ["push"]})):
        for seed in range(min(args.runs, 3)):
            ablations.append(evaluate(Agent(**options), profile, tariffs, model, seed, name))
            write_report("ablation", ablations)
    full = complete_model(profile, tariffs, model)
    scenarios = []
    for scenario in SCENARIOS:
        changed = scenario_model(scenario, full)
        for name, factory in (("template", TemplateAgent), ("fixed", lambda: Agent(adaptive=False)), ("adaptive", Agent)):
            for seed in range(args.scenario_runs):
                scenarios.append(evaluate(factory(), profile, tariffs, changed, seed, name, scenario, strict=name != "template"))
                write_report("scenarios", scenarios)


if __name__ == "__main__":
    main()
