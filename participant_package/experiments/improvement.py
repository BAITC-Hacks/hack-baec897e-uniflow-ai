"""Independent paired v1/current evaluation on fixed, declared seed partitions.

python -m experiments.improvement --scope quick --versions v1
python -m experiments.improvement --scope full --versions both
python -m experiments.improvement --scope model_holdout --versions both
python -m experiments.improvement --scope final_holdout --versions both
Use --new-options '{"strategy_version":"v2"}' only for an explicit development build.
Only this organizer-side harness sees effect models; agents receive public env.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import platform
import time

import numpy as np
import pandas as pd

from experiments.benchmark import SCENARIOS, complete_model, evaluate, load_inputs, source_hashes, summarize
from experiments.reference_v1 import Agent as PreviousAgent

ROOT = Path(__file__).resolve().parents[1]
REPORTS = ROOT / "reports"
MODEL_SEED = 20260924


def family_model(name, complete, seed=MODEL_SEED):
    """Fresh held-out tables; transformations are declared, never seen by policy."""
    model = complete.copy()
    rng = np.random.default_rng(seed + SCENARIOS.index(name))
    if name == "permuted_leaders":
        for _, indices in model.groupby(["tariff_plan_code_from", "arpu_segment"], sort=True).groups.items():
            indices = np.asarray(list(indices))
            shuffled = rng.permutation(indices)
            model.loc[indices, ["arpu_change_pct", "conversion_rate"]] = model.loc[shuffled, ["arpu_change_pct", "conversion_rate"]].to_numpy()
    elif name == "sign_reversed":
        model["arpu_change_pct"] *= -rng.uniform(.6, 1.4, len(model))
    elif name == "weak_history":
        model["arpu_change_pct"] = rng.uniform(-.35, .55, len(model))
        model["conversion_rate"] = rng.uniform(.15, .75, len(model))
    elif name == "low_conversion":
        model["conversion_rate"] *= rng.uniform(.01, .05, len(model))
    elif name == "saturated_calls":
        model["arpu_change_pct"] = rng.uniform(-.15, .45, len(model))
        model["conversion_rate"] = rng.uniform(.90, 1.0, len(model))
    elif name == "near_zero":
        model["arpu_change_pct"] = rng.uniform(-.002, .002, len(model))
        model["conversion_rate"] = rng.uniform(.2, .8, len(model))
    else:
        raise ValueError(name)
    return model


def policy_hashes(version):
    folder = ROOT / ("experiments/reference_v1" if version == "v1" else "uniflow")
    return {str(path.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(folder.glob("*.py"))
            if version == "v1" or path.name not in {"audit.py", "evaluation.py", "service_data.py"}}


def partition(scope):
    if scope == "final_holdout":
        # The standard seed42 has been evaluated repeatedly and cannot be held out.
        return [("mock_fresh", seed) for seed in (40, 41, 43, 44, 45)]
    if scope == "model_holdout":
        return [("model_holdout_" + name, 31) for name in ("permuted_leaders", "weak_history", "saturated_calls")]
    tasks = [("mock_tuning", seed) for seed in (range(3) if scope == "quick" else range(10))]
    if scope == "full":
        tasks.extend(("mock_heldout", seed) for seed in range(20, 30))
    tasks.extend((name, seed) for name in SCENARIOS for seed in (range(10, 12) if scope == "quick" else range(10, 13)))
    return tasks


def model_fingerprint(model):
    return hashlib.sha256(model.to_csv(index=False, lineterminator="\n").encode("utf-8")).hexdigest()


def resolved_options(agent):
    names = ("seed", "risk_profile", "risk_penalty", "use_history", "history_strength",
             "adaptive", "max_pilots", "strategy_version", "calibrate_prior", "advanced_search")
    return {name: getattr(agent, name) for name in names if hasattr(agent, name)}


def write_results(prefix, rows, metadata):
    frame = pd.DataFrame(rows)
    frame.to_csv(REPORTS / f"{prefix}.csv", index=False)
    summaries = summarize(rows) if rows else []
    paired = []
    for scenario, group in frame.groupby("scenario") if len(frame) else []:
        pivot = group.pivot(index="seed", columns="strategy", values="net_arpu_gain")
        if {"v1", "new"}.issubset(pivot.columns):
            values = pivot[["v1", "new"]].dropna()
            differences = values["new"] - values["v1"]
            paired.append({"scenario": scenario, "paired_runs": len(values),
                           "mean_net_difference": float(differences.mean()),
                           "median_net_difference": float(differences.median()),
                           "min_net_difference": float(differences.min()),
                           "fraction_new_better": float((differences > 0).mean()),
                           "fraction_new_worse": float((differences < 0).mean())})
    output = {"metadata": metadata, "strategy_summaries": summaries, "paired_comparisons": paired}
    (REPORTS / f"{prefix}_summary.json").write_text(json.dumps(output, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scope", choices=("quick", "full", "model_holdout", "final_holdout"), default="full")
    parser.add_argument("--versions", choices=("v1", "new", "both"), default="both")
    parser.add_argument("--new-options", default="{}")
    parser.add_argument("--label", default=None, help="Report suffix for a bounded development checkpoint")
    args = parser.parse_args()
    options = json.loads(args.new_options)
    if not isinstance(options, dict):
        parser.error("new-options must be a JSON object")
    if args.label and not all(c.isalnum() or c == "_" for c in args.label):
        parser.error("label must contain letters, digits or underscores")
    REPORTS.mkdir(exist_ok=True)
    profile, tariffs, mock_model = load_inputs()
    expanded = complete_model(profile, tariffs, mock_model)
    model_seed = MODEL_SEED + (1 if args.scope == "model_holdout" else 0)
    if args.scope == "final_holdout":
        models = {"mock_fresh": mock_model}
    elif args.scope == "model_holdout":
        models = {"model_holdout_" + name: family_model(name, expanded, model_seed)
                  for name in ("permuted_leaders", "weak_history", "saturated_calls")}
    else:
        models = {"mock_tuning": mock_model, "mock_heldout": mock_model}
        models.update({name: family_model(name, expanded, model_seed) for name in SCENARIOS})
    model_hashes = {name: model_fingerprint(model) for name, model in models.items()}
    reference_hashes = policy_hashes("v1")
    new_hashes = policy_hashes("new")
    source_signature = {"reference": reference_hashes, "data_and_organizer": source_hashes(), "models": model_hashes}
    cache_prefix = (f"improvement_{args.scope}_reference" if args.scope in {"model_holdout", "final_holdout"}
                    else "improvement_reference")
    cache_meta = REPORTS / f"{cache_prefix}_manifest.json"
    cache_csv = REPORTS / f"{cache_prefix}.csv"
    cached = []
    if cache_meta.exists() and cache_csv.exists():
        if json.loads(cache_meta.read_text(encoding="utf-8")) != source_signature:
            raise RuntimeError("Reference cache differs from data/model/policy source; archive cache before evaluating changed inputs")
        cached = pd.read_csv(cache_csv).to_dict("records")
    cache = {(row["scenario"], int(row["seed"])): row for row in cached}
    metadata = {"python": platform.python_version(), "scope": args.scope,
                "status": "running", "planned_scenario_seed_pairs": len(partition(args.scope)),
                "harness_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                "model_rng_seed": None if args.scope == "final_holdout" else model_seed,
                "agent_seed": 42, "new_options": options,
                "final_policy_revision": {
                    "default_advanced_search": True,
                    "decision_basis": "Initial three-seed development ablation and frozen-posterior diagnostics showed zero advanced-search gain, so it was temporarily disabled. A broader paired comparison then showed material gains on reused mock and shifted-family cases, particularly saturated calls. Advanced search was restored before any fresh-check metrics were communicated to the selection decision; no other parameters changed.",
                    "other_parameter_changes": False,
                    "previous_advanced_reports": "reports/v2_advanced",
                    "temporary_simple_reports": "reports/v2_simple",
                    "reused_evaluation_warning": "Repeated full/model_holdout cases informed the restoration decision and are not fresh independent hold-outs.",
                    "fresh_check": "Final_holdout mock seeds40,41,43,44,45: temporary-simple runs were produced independently before restoration, but their metrics were withheld from the selection decision. Final advanced runs occur after restoration/freeze. The initially proposed interval40..44 accidentally included known standardseed42; it was excluded and replaced by45 for bookkeeping, not outcomes. These seeds change pilot noise/sampling, not true effects. No further tuning follows."},
                "source_hashes": {"v1": reference_hashes, "new": new_hashes},
                "dataset_and_organizer_hashes": source_signature["data_and_organizer"],
                "model_hashes": model_hashes,
                "declared_partitions": {"mock_tuning": list(range(10)), "mock_heldout": list(range(20, 30)),
                                        "shifted_family_seeds": list(range(10, 13)),
                                        "final_holdout_mock_seeds": [40, 41, 43, 44, 45],
                                        "model_holdout": {"model_seed": MODEL_SEED + 1, "environment_seed": 31,
                                                          "families": ["permuted_leaders", "weak_history", "saturated_calls"]}},
                "notes": ["All agents receive only the public environment; true effects are used exclusively by the harness after act().",
                          "Mock seeds change pilot noise and sampling, not true effect family. Separate synthetic families use fresh model RNG 20260924 plus family index.",
                          "Quick checkpoint uses mock seeds 0..2 and family seeds 10..11; its results may guide development, so those subsets are not claimed as unseen afterward.",
                          "Full run repeats mock0..9, mock20..29 and six shifted families10..12 after the temporary removal and evidence-based restoration of advanced search. These cases informed the structural decision and are not fresh independent hold-outs.",
                          "The model_holdout tables from RNG20260925/environment seed31 were new in the initial advanced-search evaluation. Repeated comparisons informed restoration; they are no longer newly unseen.",
                          "Final_holdout uses mock noise/sample seeds40,41,43,44,45 after the final advanced-search freeze, with no further tuning. Temporary-simple metrics for this set were withheld from the selection decision. Standardseed42 is excluded as already known; true mock effects are unchanged.",
                          "p10 from ten runs and especially three family runs is descriptive, not a guarantee. No significance claim is made.",
                          "Reference timing may be reused from cached runs; compare runtimes cautiously under concurrent development load.",
                          "Sign reversal includes magnitude jitter; low conversion uses random factors0.01..0.05; calls use conversion0.90..1.0; near-zero varies delta and conversion."]}
    prefix = "improvement" + ("_" + args.scope if args.scope != "full" else "") + ("_" + args.label if args.label else "")
    rows, started = [], time.perf_counter()
    versions = ["v1", "new"] if args.versions == "both" else [args.versions]
    if "new" in versions:
        from agent import Agent as CurrentAgent
        metadata["resolved_new_options"] = resolved_options(CurrentAgent(**options))
    metadata["resolved_reference_options"] = resolved_options(PreviousAgent())
    for scenario, seed in partition(args.scope):
        # Include existing v1 row even during a new-only run, for paired comparisons.
        if "v1" not in versions and (scenario, seed) in cache:
            rows.append(cache[(scenario, seed)])
        for version in versions:
            if version == "v1" and (scenario, seed) in cache:
                row = cache[(scenario, seed)]
                print(f"cached v1 {scenario}/{seed}", flush=True)
            else:
                agent = PreviousAgent() if version == "v1" else CurrentAgent(**options)
                row = evaluate(agent, profile, tariffs, models[scenario], seed, version, scenario=scenario)
                if policy_hashes(version) != (reference_hashes if version == "v1" else new_hashes):
                    raise RuntimeError(f"Policy files changed during {version} evaluation; freeze code before measuring")
                if version == "v1":
                    cache[(scenario, seed)] = row
                    pd.DataFrame(list(cache.values())).to_csv(cache_csv, index=False)
                    cache_meta.write_text(json.dumps(source_signature, indent=2), encoding="utf-8")
            rows.append(row)
            metadata["elapsed_seconds"] = time.perf_counter() - started
            write_results(prefix, rows, metadata)
    metadata["status"] = "completed"
    metadata["measurement_count"] = len(rows)
    write_results(prefix, rows, metadata)
    print(f"Saved {prefix}: {len(rows)} measurements", flush=True)


if __name__ == "__main__":
    main()
