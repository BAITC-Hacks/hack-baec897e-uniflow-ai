"""Limited paired v2 component ablations; never alter default policy from test truth."""
from __future__ import annotations

import json

from agent import Agent
from .benchmark import REPORTS, evaluate, load_inputs, write_report


def main():
    profile, tariffs, model = load_inputs()
    variants = [
        ("v2", {}), ("no_history", {"use_history": False}),
        ("fixed_prior", {"calibrate_prior": False}),
        ("fixed_diverse", {"adaptive": False, "diverse_fixed": True}),
        ("no_risk_penalty", {"risk_penalty": 0}),
        ("push_only", {"allowed_channels": ["push"]}),
        ("basic_planner", {"advanced_search": False}),
    ]
    rows = []
    for label, options in variants:
        for seed in (0, 1, 2):
            row = evaluate(Agent(**options), profile, tariffs, model, seed, label)
            row["options"] = json.dumps(options, sort_keys=True)
            rows.append(row)
            write_report("v2_ablation", rows)
    (REPORTS / "v2_ablation_notes.json").write_text(json.dumps({
        "seeds": [0, 1, 2],
        "scope": "Three paired development seeds of one mock; not an independent held-out comparison.",
        "fixed_diverse": "Frozen diverse hypotheses and channels; posterior still updates, total competition resources enforced.",
        "basic_planner": "Disable money prices and local channel/order search. Three development seeds showed no difference, but the broader paired scenario check supported retaining advanced search.",
        "default_selected_from": "Separate improvement_quick and final held-out reports; these ablations describe component sensitivity, not universal superiority."
    }, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
