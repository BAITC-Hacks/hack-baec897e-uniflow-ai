"""Weak historical ranking and normal updates; transition counts are not response rates."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import math
import numpy as np
import pandas as pd

NOISE_STD = 0.804
VARIANCE_FLOOR = 1e-10


def posterior_update(mu: float, variance: float, observation: float,
                     observation_variance: float) -> tuple[float, float]:
    """Stable normal-normal update with an explicit variance floor."""
    values = (mu, variance, observation, observation_variance)
    if not all(math.isfinite(float(x)) for x in values):
        raise ValueError("Posterior inputs must be finite")
    if variance < 0 or observation_variance < 0:
        raise ValueError("Variances cannot be negative")
    variance = max(float(variance), VARIANCE_FLOOR)
    observation_variance = max(float(observation_variance), VARIANCE_FLOOR)
    weight = variance / (variance + observation_variance)
    return float(mu + weight * (observation - mu)), max(
        VARIANCE_FLOOR, float(variance * observation_variance / (variance + observation_variance)))


class HistoryPrior:
    """Capped, smoothed historical ARPU changes, deliberately weak on offer effects.

    No join to target clients, no use of transition frequencies as conversion.
    Prior scale 0.10 is a ranking heuristic, not an estimated response rate.
    """
    def __init__(self, path: Path, enabled: bool = True, strength: float = 1.0):
        self.enabled = enabled
        self.strength = float(strength)
        if not math.isfinite(self.strength) or self.strength < 0:
            raise ValueError("History strength must be finite and nonnegative")
        self.warning = None
        self.exact = {}
        self.pair = {}
        self.target = {}
        if not enabled:
            return
        try:
            frame = pd.read_csv(path)
            before = pd.to_numeric(frame["AVG_ARPU_PREV_3M"], errors="coerce")
            after = pd.to_numeric(frame["AVG_ARPU_NEXT_3M"], errors="coerce")
            valid = (before >= 100) & np.isfinite(before) & np.isfinite(after)
            frame = frame.loc[valid].copy()
            frame["segment"] = pd.cut(before.loc[valid], [-np.inf, 1000, 5000, np.inf],
                                      labels=["LOW", "MID", "HIGH"])
            frame["change"] = ((after.loc[valid] - before.loc[valid]) /
                               before.loc[valid]).clip(-0.8, 1.5)
            for columns, destination in [
                (["tariff_plan_code_from", "tariff_plan_code_to", "segment"], self.exact),
                (["tariff_plan_code_from", "tariff_plan_code_to"], self.pair),
                (["tariff_plan_code_to", "segment"], self.target),
            ]:
                grouped = frame.groupby(columns, observed=True)["change"].agg(["mean", "count"])
                destination.update({key: (float(row["mean"]), int(row["count"]))
                                    for key, row in grouped.iterrows()})
        except (OSError, ValueError, KeyError, pd.errors.ParserError) as exc:
            self.warning = f"History unavailable; neutral prior used: {type(exc).__name__}: {exc}"
            self.enabled = False

    def estimate(self, source: str, segment: str, target: str) -> tuple[float, float]:
        if not self.enabled:
            return 0.0, 0.12 ** 2
        broad, broad_n = self.target.get((target, segment), (0.0, 0))
        broad = broad * broad_n / (broad_n + 40)
        pair, pair_n = self.pair.get((source, target), (broad, 0))
        pair = (pair * pair_n + 25 * broad) / (pair_n + 25)
        exact, exact_n = self.exact.get((source, target, segment), (pair, 0))
        shrunk = (exact * exact_n + 15 * pair) / (exact_n + 15)
        return float(np.clip(0.10 * self.strength * shrunk, -0.08, 0.12)), 0.12 ** 2


@dataclass
class Belief:
    mean: float
    variance: float
    pilot_ids: list[str] = field(default_factory=list)


class PosteriorTable:
    """Shares unsaturated channels in q units; saturated channels are independent."""
    def __init__(self, history: HistoryPrior, channels: dict):
        self.history = history
        self.channels = channels
        self.values: dict[tuple, Belief] = {}

    def normalized(self, channel: str) -> bool:
        multiplier = float(self.channels[channel]["conversion_multiplier"])
        return 0 < multiplier <= 1

    def key(self, group: tuple[str, str], target: str, channel: str) -> tuple:
        return (*group, target, "q" if self.normalized(channel) else channel)

    def get(self, group: tuple[str, str], target: str, channel: str) -> tuple[float, float, list[str]]:
        key = self.key(group, target, channel)
        if key not in self.values:
            mean, variance = self.history.estimate(group[0], group[1], target)
            if not self.normalized(channel):
                # Saturated channels receive a neutral wide independent prior.
                mean, variance = 0.0, 0.18 ** 2
            self.values[key] = Belief(mean, variance)
        belief = self.values[key]
        scale = float(self.channels[channel]["conversion_multiplier"]) if self.normalized(channel) else 1.0
        return belief.mean * scale, belief.variance * scale ** 2, list(belief.pilot_ids)

    def update(self, group: tuple[str, str], target: str, channel: str,
               observed_ratio: float, n_actual: int, pilot_id: str) -> None:
        if n_actual <= 0:
            raise ValueError("A pilot must have a positive actual sample")
        self.get(group, target, channel)
        scale = float(self.channels[channel]["conversion_multiplier"]) if self.normalized(channel) else 1.0
        belief = self.values[self.key(group, target, channel)]
        belief.mean, belief.variance = posterior_update(
            belief.mean, belief.variance, observed_ratio / scale,
            NOISE_STD ** 2 / (n_actual * scale ** 2))
        belief.pilot_ids.append(pilot_id)
