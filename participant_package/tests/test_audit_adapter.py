"""Real-data audit invariants and the frontend DTO boundary."""
import json
from pathlib import Path
import sys

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from uniflow.audit import PACKAGE_ROOT, build_audit, json_safe


def test_audit_counts_exclusions_and_history_overlap():
    audit = build_audit()
    profile = pd.read_csv(PACKAGE_ROOT / "customer_profile.csv")
    tariffs = pd.read_csv(PACKAGE_ROOT / "data" / "dict_tariff.csv")
    history = pd.read_csv(PACKAGE_ROOT / "data" / "change_tariff.csv")
    eligible = profile.current_tariff.isin(tariffs.tariff_plan_code) & profile.arpu_segment.isin(["LOW", "MID", "HIGH"])
    assert audit["customer_count"] == len(profile)
    assert audit["eligible_customer_count"] == int(eligible.sum())
    assert audit["excluded_customer_count"] == int((~eligible).sum())
    assert audit["baseline_revenue"] == profile.predicted_arpu.sum()
    assert audit["target_history_id_overlap"] == len(set(history.ID_NUMBER) & set(profile.ID_NUMBER))
    assert sum(row["customer_count"] for row in audit["segments"]) == len(profile)
    assert "submission.csv" not in audit["input_sha256"]
    json.dumps(audit, allow_nan=False)


def test_unknown_values_are_null_and_overview_is_detached():
    from uniflow.service_data import build_overview
    assert json_safe({"a": float("nan"), "b": float("inf"), "c": pd.NA}) == {"a": None, "b": None, "c": None}
    first = build_overview()
    first["dataset"]["customer_count"] = -1
    assert build_overview()["dataset"]["customer_count"] > 0
    json.dumps(build_overview(), allow_nan=False)
