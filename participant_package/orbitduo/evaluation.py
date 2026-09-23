"""Isolated organizer adapter: true effects are used only after Agent.act returns.

This module is never imported by the competition Agent or its decision modules.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
import logging
from pathlib import Path
import sys
import time

from .audit import PACKAGE_ROOT, json_safe

LOG = logging.getLogger(__name__)
REPORT_KEYS = ("resources", "pilots", "campaigns", "events", "forecast", "warnings")
CAMPAIGN_COLUMNS = ("campaign_name", "filter_arpu_segment", "filter_data_segment",
                    "filter_call_segment", "filter_current_tariff", "target_tariff", "channel")


def bootstrap_package():
    """Support untouched organizer imports without process-global chdir."""
    if str(PACKAGE_ROOT) not in sys.path:
        sys.path.insert(0, str(PACKAGE_ROOT))


def _notify(observer, patch):
    if observer is not None:
        try:
            observer(deepcopy(json_safe(patch)))
        except Exception:
            LOG.exception("Progress observer failed; strategy and evaluation are unchanged")


def run_experiment(seed=42, risk_profile="balanced", observer=None, **agent_options):
    bootstrap_package()
    import pandas as pd
    from agent import Agent
    from mock_environment import make_mock_env, _mock_impact_model, _mock_fallback
    from scoring_core import validate_strategy, score_campaigns, sanitize_campaigns

    started = time.perf_counter()
    _notify(observer, {"phase": "audit", "phase_message": "Чтение публичных данных и создание независимой среды."})
    env, internals = make_mock_env(seed=seed, data_dir=str(PACKAGE_ROOT / "data"),
                                   profile_path=str(PACKAGE_ROOT / "customer_profile.csv"))

    def progress(report):
        patch = {key: report[key] for key in REPORT_KEYS if key in report}
        events = patch.get("events", [])
        if events:
            patch.update(phase=events[-1]["phase"], phase_message=events[-1]["message"])
        _notify(observer, patch)

    agent = Agent(seed=seed, risk_profile=risk_profile, observer=progress, **agent_options)
    final = agent.act(env)
    # Fail explicitly: local_eval swallows agent errors and sanitizes silently.
    if not isinstance(final, list) or not 1 <= len(final) <= 10:
        raise ValueError("Agent must return 1–10 final campaigns")
    if any(not isinstance(c, dict) or set(c) - set(CAMPAIGN_COLUMNS) for c in final):
        raise ValueError("Final campaign contains forbidden fields")
    if len(sanitize_campaigns(final, env.tariffs)) != len(final):
        raise ValueError("The official sanitizer rejected a final campaign")
    validate_strategy(pd.DataFrame(final), env.tariffs)
    if not 1 <= len(env.pilot_history) <= 20:
        raise ValueError("At least one successful pilot is required")
    if any(p["n_customers"] <= 0 for p in env.pilot_history):
        raise ValueError("Pilot must have a nonempty actual audience")
    _notify(observer, {"phase": "evaluation", "phase_message": "План зафиксирован; независимая оценка локальным harness."})
    # Organizer-only data first accessed here, after the decision has finished.
    pilots = internals.executed_pilot_campaigns()
    model = _mock_impact_model(pd.read_csv(PACKAGE_ROOT / "data" / "change_tariff.csv"))
    combined = pd.DataFrame(pilots + final)
    for key in CAMPAIGN_COLUMNS[1:5] + ("explicit_ids",):
        if key not in combined:
            combined[key] = None
    scored = score_campaigns(combined, env.customer_profile, model, env.tariffs,
                             float(env.customer_profile.predicted_arpu.sum()), _mock_fallback,
                             team_id="orbitduo_local")
    details = scored["campaigns_detail"][len(pilots):]
    if any(not 0 < row["n_contacts"] <= 5000 for row in details):
        raise ValueError("Final campaign has an empty or oversized executable audience")
    if scored["total_cost"] > env.total_budget or scored["total_contacts"] > env.max_total_contacts:
        raise ValueError("Official evaluation exceeded the resource limits")
    report = deepcopy(agent.report)
    output = {key: report[key] for key in REPORT_KEYS}
    if len(output["campaigns"]) != len(final):
        raise ValueError("Reported and returned campaign counts differ")
    for view, spec, actual in zip(output["campaigns"], final, details):
        if view["spec"] != {key: spec.get(key) for key in CAMPAIGN_COLUMNS}:
            raise ValueError("Reported and returned campaign specifications differ")
        if view["audience_count"] != actual["n_contacts"] or abs(view["communication_cost"] - actual["cost"]) > 1e-7:
            raise ValueError("Public replay disagrees with the official scorer")
    for resource, actual_total in (("budget", scored["total_cost"]), ("contacts", scored["total_contacts"])):
        counter = output["resources"][resource]
        if abs(counter["used_by_pilots"] + counter["planned_final"] - actual_total) > 1e-7:
            raise ValueError(f"Reported {resource} disagrees with the official scorer")
    output["local_evaluation"] = {
        "label": "local_simulation", "gross_gain": scored["gross_arpu_lift"],
        "net_arpu_gain": scored["net_arpu_gain"], "communication_cost": scored["total_cost"],
        "total_contacts": scored["total_contacts"], "unique_customers": scored["unique_customers_targeted"],
        "n_pilots": len(pilots), "n_final_campaigns": len(final),
        "runtime_seconds": time.perf_counter() - started,
    }
    from .service_data import build_overview
    output["warnings"] = build_overview()["dataset"]["notices"] + output["warnings"]
    return json_safe(output)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--risk-profile", choices=("balanced", "conservative"), default="balanced")
    parser.add_argument("--output", type=Path, default=PACKAGE_ROOT / "reports" / "decision_trace.json")
    args = parser.parse_args()
    result = run_experiment(seed=args.seed, risk_profile=args.risk_profile)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps(result["local_evaluation"], ensure_ascii=False))


if __name__ == "__main__":
    main()
