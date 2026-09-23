"""Publish convenient report names from measured versioned results; no simulation."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pandas as pd

from .benchmark import REPORTS, write_report


def main():
    source = json.loads((REPORTS / "improvement_summary.json").read_text(encoding="utf-8"))
    if source["metadata"]["status"] != "completed":
        raise RuntimeError("Wait for the final comparison to finish")
    for relative, expected in source["metadata"]["source_hashes"]["new"].items():
        if hashlib.sha256((REPORTS.parent / relative).read_bytes()).hexdigest() != expected:
            raise RuntimeError(f"Stale comparison: {relative}")

    final = pd.read_csv(REPORTS / "improvement.csv")
    paired = final.loc[final.scenario == "mock_tuning"].copy()
    paired["strategy"] = paired.strategy.map({"v1": "adaptive_v1", "new": "adaptive_v2"})
    paired["source_report"] = "improvement.csv"
    paired["scenario"] = "mock"
    archived = pd.read_csv(REPORTS / "v1" / "benchmark.csv")
    archived = archived.loc[archived.strategy.isin(["template", "fixed"])].copy()
    archived["strategy"] = archived.strategy.replace({"fixed": "fixed_v1"})
    archived["source_report"] = "v1/benchmark.csv"
    write_report("benchmark", pd.concat([archived, paired], ignore_index=True).to_dict("records"))

    ablations = pd.read_csv(REPORTS / "v2_ablation.csv")
    write_report("ablation", ablations.to_dict("records"))
    changed = final.loc[~final.scenario.str.startswith("mock_")]
    model_check = pd.read_csv(REPORTS / "improvement_model_holdout.csv")
    write_report("scenarios", pd.concat([changed, model_check], ignore_index=True).to_dict("records"))
    names = ("benchmark.csv", "ablation.csv", "scenarios.csv", "improvement.csv",
             "improvement_model_holdout.csv", "v2_ablation.csv", "v1/benchmark.csv")
    manifest = {
        "method": "Aggregate existing measured rows, retaining source/version labels. No new scoring.",
        "fixed_v1": "Frozen earlier fixed policy; not the current v2 fixed-diverse ablation.",
        "template": "Original organizer template; one invalid empty-final run is intentionally retained.",
        "advanced_search": source["metadata"]["resolved_new_options"].get("advanced_search"),
        "sha256": {name: hashlib.sha256((REPORTS / name).read_bytes()).hexdigest() for name in names},
    }
    (REPORTS / "publication_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"benchmark_rows": len(archived) + len(paired),
                      "ablation_rows": len(ablations), "scenario_rows": len(changed) + len(model_check)}))


if __name__ == "__main__":
    main()
