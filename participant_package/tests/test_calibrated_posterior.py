"""Hierarchical inference checks against explicit Bayes calculations."""
from pathlib import Path

import numpy as np
import pytest

from scoring_core import CHANNELS
from orbitduo.posterior import HistoryPrior, NOISE_STD, PosteriorTable


def neutral_table():
    return PosteriorTable(HistoryPrior(Path("unused"), enabled=False), CHANNELS, calibrate=True)


def test_single_observation_mixture_uses_likelihood_exactly_once():
    table = neutral_table()
    group, observed, count, scale = ("a", "HIGH"), 0.12, 100, 0.65
    prior_variances = table._variances.copy()
    prior_weights = np.exp(table._log_prior)
    observation, noise_variance = observed / scale, NOISE_STD ** 2 / (count * scale ** 2)
    likelihood = np.exp(-0.5 * observation ** 2 / (prior_variances + noise_variance)) / np.sqrt(prior_variances + noise_variance)
    weights = prior_weights * likelihood
    weights /= weights.sum()
    variances = prior_variances * noise_variance / (prior_variances + noise_variance)
    means = prior_variances / (prior_variances + noise_variance) * observation
    expected_mean = np.dot(weights, means)
    expected_variance = np.dot(weights, variances + (means - expected_mean) ** 2)
    table.update(group, "b", "sms", observed, count, "p1")
    mean, variance, ids = table.get(group, "b", "sms")
    assert mean == pytest.approx(expected_mean * scale)
    assert variance == pytest.approx(expected_variance * scale ** 2)
    assert ids == ["p1"]


def test_zero_pilots_reduce_prior_spread_but_keep_common_effect_uncertainty():
    table = neutral_table()
    before = table.get(("unseen", "MID"), "b", "push")[1]
    for number in range(8):
        table.update((f"source{number}", "HIGH"), "b", "digital_ads", 0.0, 200, f"p{number}")
    mean, variance, ids = table.get(("unseen", "MID"), "b", "push")
    assert mean == 0 and ids == []
    assert 0.01 ** 2 * 0.5 ** 2 < variance < before
    assert table.calibration_summary()["observed_hypotheses"] == 8


def test_global_calibration_preserves_independent_saturated_evidence():
    table = neutral_table()
    table.update(("a", "HIGH"), "b", "call", -0.2, 100, "call1")
    before = table.get(("a", "HIGH"), "b", "call")
    table.update(("a", "HIGH"), "b", "push", 0.4, 200, "push1")
    assert table.get(("a", "HIGH"), "b", "call") == before
    assert table.get(("a", "HIGH"), "b", "sms")[2] == ["push1"]


def test_repeated_observation_precision_uses_actual_sample_and_shared_effect():
    first, second = neutral_table(), neutral_table()
    first.update(("a", "HIGH"), "b", "sms", 0.1, 12, "p1")
    first.update(("a", "HIGH"), "b", "sms", 0.1, 8, "p2")
    second.update(("a", "HIGH"), "b", "sms", 0.1, 20, "combined")
    assert first.get(("a", "HIGH"), "b", "push")[:2] == pytest.approx(second.get(("a", "HIGH"), "b", "push")[:2])
    assert first.calibration_summary()["observed_hypotheses"] == 1


@pytest.mark.parametrize("observation", [float("nan"), float("inf"), -float("inf")])
def test_invalid_pilot_does_not_poison_global_calibration(observation):
    table = neutral_table()
    with pytest.raises(ValueError, match="finite"):
        table.update(("a", "HIGH"), "b", "push", observation, 100, "bad")
    assert table.calibration_summary()["observed_hypotheses"] == 0
