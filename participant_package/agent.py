"""Starter scaffold for the Beeline tariff campaign task.

Implement the decision logic in Agent.act using only the public environment.
The first version intentionally returns an empty plan until the strategy is
implemented and checked against the local evaluator.
"""

from __future__ import annotations

from typing import Any


MAX_FINAL_CAMPAIGNS = 10


class Agent:
    """Agent entry point expected by ``local_eval.py``."""

    def act(self, env: Any) -> list[dict[str, Any]]:
        """Return the final campaign plan.

        Suggested implementation stages:
        1. Inspect the public profile and available resources.
        2. Select informative, affordable pilots with ``env.run_pilot``.
        3. Rank campaign candidates using pilot results and public data.
        4. Return up to ``MAX_FINAL_CAMPAIGNS`` valid campaign dictionaries.
        """
        # TODO: implement the strategy after agreeing on the first baseline.
        return []
