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
    def __init__(self, history: HistoryPrior, channels: dict, calibrate=False):
        self.history = history
        self.channels = channels
        self.values: dict[tuple, Belief] = {}
        self.calibrate = bool(calibrate)
        self.observations = {}
        # A finite hierarchical normal mixture learns whether historical ranking
        # transfers and whether campaign effects are large enough to deploy.
        # The component spread is group-effect uncertainty, never divided by
        # the size of a final audience. Hyperparameter uncertainty is retained.
        self._alphas = np.repeat([0.0, 0.5, 1.0], 5)
        self._variances = np.tile(np.square([0.01, 0.03, 0.06, 0.12, 0.24]), 3)
        self._log_prior = np.log(np.repeat([0.4, 0.3, 0.3], 5) *
                                 np.tile([0.1, 0.2, 0.25, 0.35, 0.1], 3))
        self._weights = np.exp(self._log_prior)

    def _calibrate(self):
        log_weights = self._log_prior.copy()
        for key, observation in self.observations.items():
            if key[-1] != "q":
                continue
            prior_mean, _ = self.history.estimate(key[0], key[1], key[2])
            precision, weighted_sum, _ = observation
            variance = self._variances + 1.0 / precision
            residual = weighted_sum / precision - self._alphas * prior_mean
            log_weights -= 0.5 * (np.log(variance) + residual ** 2 / variance)
        weights = np.exp(log_weights - np.max(log_weights))
        self._weights = weights / weights.sum()
        self.values = {key: belief for key, belief in self.values.items() if key[-1] != "q"}

    def _mixture(self, key):
        mean, _ = self.history.estimate(key[0], key[1], key[2])
        means, variances = self._alphas * mean, self._variances.copy()
        precision, weighted_sum, ids = self.observations.get(key, (0.0, 0.0, []))
        if precision:
            variances = 1.0 / (1.0 / variances + precision)
            means = variances * (means / self._variances + weighted_sum)
        mixture_mean = float(np.dot(self._weights, means))
        mixture_variance = float(np.dot(self._weights, variances + (means - mixture_mean) ** 2))
        return Belief(mixture_mean, max(VARIANCE_FLOOR, mixture_variance), list(ids))

    def calibration_summary(self):
        return {"method": "finite hierarchical normal mixture" if self.calibrate else "fixed normal prior",
                "observed_hypotheses": len(self.observations),
                "expected_history_weight": float(np.dot(self._weights, self._alphas)) if self.calibrate else 1.0,
                "expected_effect_variance": float(np.dot(self._weights, self._variances)) if self.calibrate else 0.12 ** 2}

    def normalized(self, channel: str) -> bool:
        multiplier = float(self.channels[channel]["conversion_multiplier"])
        return 0 < multiplier <= 1

    def key(self, group: tuple[str, str], target: str, channel: str) -> tuple:
        return (*group, target, "q" if self.normalized(channel) else channel)

    def get(self, group: tuple[str, str], target: str, channel: str) -> tuple[float, float, list[str]]:
        key = self.key(group, target, channel)
        if key not in self.values:
            if self.calibrate and self.normalized(channel):
                self.values[key] = self._mixture(key)
            else:
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
        if not math.isfinite(float(observed_ratio)):
            raise ValueError("A pilot observation must be finite")
        self.get(group, target, channel)
        scale = float(self.channels[channel]["conversion_multiplier"]) if self.normalized(channel) else 1.0
        if self.calibrate and self.normalized(channel):
            key = self.key(group, target, channel)
            precision, weighted_sum, ids = self.observations.get(key, (0.0, 0.0, []))
            observation_precision = n_actual * scale ** 2 / NOISE_STD ** 2
            self.observations[key] = (precision + observation_precision,
                weighted_sum + observed_ratio / scale * observation_precision, [*ids, pilot_id])
            self._calibrate()
            return
        belief = self.values[self.key(group, target, channel)]
        belief.mean, belief.variance = posterior_update(
            belief.mean, belief.variance, observed_ratio / scale,
            NOISE_STD ** 2 / (n_actual * scale ** 2))
        belief.pilot_ids.append(pilot_id)
