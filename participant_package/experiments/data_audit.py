"""Rebuild the public-data audit report from the supplied package."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import zipfile

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
REPORT = ROOT / "reports" / "data_audit.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run() -> dict:
    profile_path = ROOT / "customer_profile.csv"
    change_path = ROOT / "data" / "change_tariff.csv"
    tariff_path = ROOT / "data" / "dict_tariff.csv"
    traffic_path = ROOT / "data" / "traffic.csv"
    monthly_path = ROOT / "data" / "arpu_monthly.csv"
    profile = pd.read_csv(profile_path)
    changes = pd.read_csv(change_path)
    tariffs = pd.read_csv(tariff_path)
    traffic = pd.read_csv(traffic_path)
    monthly = pd.read_csv(monthly_path)

    previous = pd.to_numeric(changes["AVG_ARPU_PREV_3M"], errors="coerce")
    following = pd.to_numeric(changes["AVG_ARPU_NEXT_3M"], errors="coerce")
    usable = previous >= 100
    raw_delta = (following - previous) / previous.replace(0, np.nan)
    delta = raw_delta.clip(-1, 3)
    profile_ids = set(profile["ID_NUMBER"].dropna().tolist())
    history_ids = set(changes.loc[usable, "ID_NUMBER"].dropna().tolist())
    changes_by_segment = changes.loc[usable].copy()
    changes_by_segment["arpu_segment"] = pd.cut(
        previous.loc[usable], [-np.inf, 1_000, 5_000, np.inf], labels=["LOW", "MID", "HIGH"]
    )
    changes_by_segment["delta"] = delta.loc[usable]
    source_cells = (profile.dropna(subset=["current_tariff", "arpu_segment"])
                    .groupby(["current_tariff", "arpu_segment"], observed=True).size())

    root_docx = REPO / "HackAlem AI_ Beeline Tariff Marketing Campaigns Case.docx"
    archive_path = REPO / "beeline_case_participants (1).zip"
    with zipfile.ZipFile(archive_path) as archive:
        archived_pdf = archive.read("PARTICIPANT_GUIDE.pdf")
    docx_bytes = root_docx.read_bytes()

    report = {
        "source": "participant_package files extracted from beeline_case_participants (1).zip",
        "synthetic_data_notice": True,
        "files": {
            path.name: {"bytes": path.stat().st_size, "sha256": sha256(path)}
            for path in (profile_path, change_path, tariff_path, traffic_path, monthly_path)
        },
        "profile": {
            "rows": int(len(profile)), "columns": int(len(profile.columns)),
            "duplicate_id_rows": int(profile["ID_NUMBER"].duplicated().sum()),
            "predicted_arpu_sum": float(profile["predicted_arpu"].sum()),
            "missing": {column: int(profile[column].isna().sum()) for column in profile.columns},
            "arpu_segment_counts": {str(k): int(v) for k, v in profile["arpu_segment"].value_counts(dropna=False).items()},
            "arpu_segment_predicted_arpu_mean": {str(k): float(v) for k, v in profile.groupby("arpu_segment", dropna=False, observed=True)["predicted_arpu"].mean().items()},
            "nonempty_current_tariff_arpu_cells": int(len(source_cells)),
            "ids_in_history_intersection": int(len(profile_ids & history_ids)),
            "rows_without_current_tariff_or_arpu_segment": int(profile[["current_tariff", "arpu_segment"]].isna().any(axis=1).sum()),
        },
        "change_tariff": {
            "rows": int(len(changes)),
            "columns": int(len(changes.columns)),
            "rows_with_previous_arpu_at_least_100": int(usable.sum()),
            "unique_id_count": int(changes["ID_NUMBER"].nunique()),
            "all_rows_next_gt_previous": int((following > previous).sum()),
            "all_rows_next_lt_previous": int((following < previous).sum()),
            "all_rows_next_eq_previous": int((following == previous).sum()),
            "rows_previous_zero": int((previous == 0).sum()),
            "rows_previous_below_100": int((previous < 100).sum()),
            "relative_delta_positive_when_defined": int((raw_delta > 0).sum()),
            "relative_delta_negative_when_defined": int((raw_delta < 0).sum()),
            "relative_delta_zero_when_defined": int((raw_delta == 0).sum()),
            "delta_clip": [-1.0, 3.0],
            "delta_positive_rows": int((delta.loc[usable] > 0).sum()),
            "delta_negative_rows": int((delta.loc[usable] < 0).sum()),
            "delta_zero_rows": int((delta.loc[usable] == 0).sum()),
            "mean_clipped_delta": float(delta.loc[usable].mean()),
            "distinct_source_arpu_groups": int(changes_by_segment[["tariff_plan_code_from", "arpu_segment"]].drop_duplicates().shape[0]),
            "distinct_source_target_arpu_groups": int(changes_by_segment[["tariff_plan_code_from", "tariff_plan_code_to", "arpu_segment"]].drop_duplicates().shape[0]),
        },
        "other_tables": {
            "tariff_dictionary_rows": int(len(tariffs)),
            "traffic_rows": int(len(traffic)),
            "arpu_monthly_rows": int(len(monthly)),
        },
        "format_check": {
            "user_docx_extension": root_docx.suffix,
            "user_docx_signature": docx_bytes[:8].decode("ascii", errors="replace"),
            "archive_guide_pdf_signature": archived_pdf[:8].decode("ascii", errors="replace"),
            "byte_identical_to_archived_pdf": docx_bytes == archived_pdf,
        },
        "interpretation": [
            "Completed transitions are descriptive observations, not randomized campaign outcomes.",
            "The history does not contain a full offer denominator or non-converters.",
            "A destination frequency is only a weak popularity proxy, not a calibrated offer conversion probability.",
        ],
    }
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return report


if __name__ == "__main__":
    print(json.dumps(run(), indent=2, ensure_ascii=False))
