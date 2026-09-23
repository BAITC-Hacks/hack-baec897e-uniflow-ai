"""Read-only, reproducible public-data audit. No decision or hidden-model code."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SEGMENTS = {"arpu_segment": {"LOW", "MID", "HIGH"},
            "data_segment": {"NON_USER", "LITE", "HEAVY"},
            "call_segment": {"LOW", "MEDIUM", "HIGH"}}


def json_safe(value):
    """Normalize scalar missing values; strict JSON never contains NaN/Infinity."""
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value is pd.NA or value is pd.NaT:
        return None
    return value


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def file_summary(frame: pd.DataFrame) -> dict:
    numeric = frame.select_dtypes(include="number")
    return {
        "rows": len(frame), "columns": list(frame.columns),
        "dtypes": {c: str(t) for c, t in frame.dtypes.items()},
        "missing": {c: int(v) for c, v in frame.isna().sum().items()},
        "nonfinite_numeric": {c: int((~np.isfinite(numeric[c]) & numeric[c].notna()).sum())
                              for c in numeric.columns},
        "unique_ids": int(frame.ID_NUMBER.nunique()) if "ID_NUMBER" in frame else None,
        "duplicate_ids": int(frame.ID_NUMBER.duplicated().sum()) if "ID_NUMBER" in frame else None,
    }


def build_audit(root: Path = PACKAGE_ROOT) -> dict:
    root = Path(root)
    paths = sorted(root.glob("*.csv")) + sorted((root / "data").glob("*.csv"))
    # Generated submission is not part of the input dataset fingerprint.
    paths = [p for p in paths if p.name != "submission.csv"]
    frames = {p.relative_to(root).as_posix(): pd.read_csv(p) for p in paths}
    hashes = {p.relative_to(root).as_posix(): sha256(p) for p in paths}
    fingerprint = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    profile, history = frames["customer_profile.csv"], frames["data/change_tariff.csv"]
    tariffs = frames["data/dict_tariff.csv"]
    known = set(tariffs.tariff_plan_code.dropna())
    bad_tariff = ~profile.current_tariff.isin(known)
    bad_arpu = ~profile.arpu_segment.isin(SEGMENTS["arpu_segment"])
    eligible = ~bad_tariff & ~bad_arpu
    baseline = pd.to_numeric(profile.predicted_arpu, errors="coerce")
    notices = [{"code": "SYNTHETIC_DATA", "severity": "info",
                "message": "Синтетические данные; результат симуляции не является прогнозом реального Beeline.",
                "affected_count": None}]
    for name, mask, message in [
        ("INVALID_CURRENT_TARIFF", bad_tariff, "Нет пригодного текущего тарифа: исключены из адресных кандидатов."),
        ("INVALID_ARPU_SEGMENT", bad_arpu, "Нет пригодного ARPU-сегмента: исключены из адресных кандидатов."),
    ]:
        if mask.any():
            notices.append({"code": name, "severity": "warning", "message": message,
                            "affected_count": int(mask.sum())})
    optional_missing = {}
    for column in ("data_segment", "call_segment"):
        bad = ~profile[column].isin(SEGMENTS[column])
        optional_missing[column] = int(bad.sum())
        if bad.any():
            notices.append({"code": f"MISSING_{column.upper()}", "severity": "info",
                            "message": f"Нет пригодного {column}: доступны общие группы, но не адресный фильтр по этому полю.",
                            "affected_count": int(bad.sum())})
    groups = []
    for (tariff, segment), frame in profile.groupby(["current_tariff", "arpu_segment"],
                                                    dropna=False, observed=True, sort=True):
        groups.append({"current_tariff": tariff, "arpu_segment": segment,
                       "customer_count": len(frame),
                       "baseline_revenue": float(frame.predicted_arpu.sum()),
                       "average_predicted_arpu": float(frame.predicted_arpu.mean()),
                       "eligible": bool(pd.notna(tariff) and tariff in known
                                        and pd.notna(segment) and segment in SEGMENTS["arpu_segment"])})
    def frequencies(column):
        return [{"value": k, "count": int(v)}
                for k, v in profile[column].value_counts(dropna=False).items()]
    overlap = set(profile.ID_NUMBER.dropna()) & set(history.ID_NUMBER.dropna())
    audit = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "dataset_id": fingerprint, "input_sha256": hashes,
        "files": {name: file_summary(frame) for name, frame in frames.items()},
        "customer_count": len(profile), "tariff_count": len(tariffs),
        "baseline_revenue": float(baseline.sum()),
        "baseline_min": float(baseline.min()), "baseline_max": float(baseline.max()),
        "invalid_baseline_count": int((baseline.isna() | ~np.isfinite(baseline) | (baseline < 0)).sum()),
        "eligible_customer_count": int(eligible.sum()),
        "excluded_customer_count": int((~eligible).sum()),
        "excluded_baseline_revenue": float(baseline[~eligible].sum()),
        "exclusion_counts": {"missing_current_tariff": int(profile.current_tariff.isna().sum()),
                             "unknown_current_tariff": int((bad_tariff & profile.current_tariff.notna()).sum()),
                             "missing_arpu_segment": int(profile.arpu_segment.isna().sum()),
                             "unknown_arpu_segment": int((bad_arpu & profile.arpu_segment.notna()).sum()),
                             "both_invalid": int((bad_tariff & bad_arpu).sum())},
        "exclusion_reason": "Неизвестный/пропущенный current_tariff или недопустимый/пропущенный arpu_segment; исходные строки сохранены.",
        "optional_filter_unavailable": optional_missing,
        "target_history_id_overlap": len(overlap),
        "history_join_policy": "Групповые агрегаты переходов; соединение целевой аудитории с историей по ID не применяется.",
        "segment_policy": "Используется готовый arpu_segment, определённый ARPU_3m_avg; predicted_arpu не используется для пересегментации.",
        "frequencies": {column: frequencies(column)
                        for column in ("current_tariff", "arpu_segment", "data_segment", "call_segment")},
        "segments": groups, "notices": notices,
    }
    return json_safe(audit)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=PACKAGE_ROOT / "reports" / "data_audit.json")
    args = parser.parse_args()
    result = build_audit()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({k: result[k] for k in ("customer_count", "tariff_count", "baseline_revenue",
                     "eligible_customer_count", "excluded_customer_count", "target_history_id_overlap")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
