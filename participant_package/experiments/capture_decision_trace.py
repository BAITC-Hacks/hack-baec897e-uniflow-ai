"""Save one deterministic run's audit, sequential pilots, and final plan."""

from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from agent import Agent
from mock_environment import make_mock_env


REPORT = ROOT / "reports" / "decision_trace.json"


def run(seed: int = 42) -> dict:
    env, _ = make_mock_env(seed=seed, data_dir=str(ROOT / "data"),
                           profile_path=str(ROOT / "customer_profile.csv"))
    agent = Agent()
    campaigns = agent.act(env)
    trace = {"seed": seed, **agent.report, "submission_campaigns": campaigns}
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(trace, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return trace


if __name__ == "__main__":
    result = run()
    print(f"saved {REPORT} | pilots={len(result['pilots'])} | campaigns={len(result['submission_campaigns'])} "
          f"| runtime={result['runtime_seconds']:.2f}s")
