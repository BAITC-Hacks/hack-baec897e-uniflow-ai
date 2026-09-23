"""Focused checks for the current public agent primitives."""

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from orbitduo.candidates import Candidate, CandidateSpace, SPEC_FIELDS
from orbitduo.portfolio import PilotOverlap, best_contacted_effect, replay_plan
from orbitduo.posterior import HistoryPrior, PosteriorTable, posterior_update


CHANNELS = {
    "push": {"cost_per_contact": 0, "conversion_multiplier": 0.50},
    "sms": {"cost_per_contact": 4, "conversion_multiplier": 0.65},
    "digital_ads": {"cost_per_contact": 22, "conversion_multiplier": 0.85},
    "call": {"cost_per_contact": 160, "conversion_multiplier": 1.20},
}


def profile(n=80):
    return pd.DataFrame({
        "ID_NUMBER": np.arange(n, 0, -1),
        "current_tariff": ["tariff_1"] * n,
        "arpu_segment": ["HIGH"] * n,
        "data_segment": ["HEAVY"] * n,
        "call_segment": ["MEDIUM"] * n,
        "predicted_arpu": np.linspace(1_000, 2_000, n),
    })


def tariffs():
    return pd.DataFrame({"tariff_plan_code": ["tariff_1", "tariff_2"],
                         "price_tariff": [1_000.0, 2_000.0]})


def neutral_posterior():
    return PosteriorTable(HistoryPrior(Path("missing-history.csv"), enabled=False), CHANNELS)


def test_posterior_uses_actual_sample_size_and_channel_scale():
    table = neutral_posterior()
    group = ("tariff_1", "HIGH")
    mean_before, variance_before, _ = table.get(group, "tariff_2", "sms")
    table.update(group, "tariff_2", "sms", observed_ratio=0.13, n_actual=17, pilot_id="p1")
    mean_after, variance_after, ids = table.get(group, "tariff_2", "sms")
    observation_variance = 0.804 ** 2 / (17 * 0.65 ** 2)
    expected_mean, expected_variance = posterior_update(
        mean_before / 0.65, variance_before / 0.65 ** 2, 0.13 / 0.65,
        observation_variance,
    )
    assert mean_after == pytest.approx(expected_mean * 0.65)
    assert variance_after == pytest.approx(expected_variance * 0.65 ** 2)
    assert ids == ["p1"]


def test_replay_uses_id_order_and_public_fields():
    space = CandidateSpace(profile(5_010), tariffs(), CHANNELS)
    audience = space.groups[("tariff_1", "HIGH")]
    assert space.profile.iloc[audience.indices]["ID_NUMBER"].is_monotonic_increasing
    spec = Candidate(audience, "tariff_2", "push", 0.1, 0.01, []).spec("test")
    assert set(spec) == set(SPEC_FIELDS)
    executed = replay_plan(space.profile, [spec], CHANNELS, 100_000, 15_000,
                           tariffs()["tariff_plan_code"])
    assert executed[0]["n_customers"] == 5_000
    assert executed[0]["customer_ids"] == list(range(1, 5_001))


def test_call_saturation_keeps_a_separate_posterior():
    table = neutral_posterior()
    group = ("tariff_1", "HIGH")
    assert table.normalized("sms")
    assert not table.normalized("call")
    table.update(group, "tariff_2", "sms", observed_ratio=0.13, n_actual=17,
                 pilot_id="sms-1")
    call_mean, _, call_ids = table.get(group, "tariff_2", "call")
    assert call_mean == 0.0
    assert call_ids == []


def test_pilot_overlap_uses_actual_n_without_pilot_ids():
    space = CandidateSpace(profile(100), tariffs(), CHANNELS)
    posterior = neutral_posterior()
    group = ("tariff_1", "HIGH")
    posterior.update(group, "tariff_2", "push", observed_ratio=0.2,
                     n_actual=10, pilot_id="p1")
    overlap = PilotOverlap(space, posterior,
                           [{"group": group, "target": "tariff_2", "channel": "push", "n": 10}])
    assert np.allclose(overlap.reach_probability, 0.1)


def test_negative_first_contact_is_retained():
    previous = np.array([np.nan, -0.2])
    following = np.array([-0.3, -0.4])
    assert np.allclose(best_contacted_effect(previous, following), [-0.3, -0.2])


def test_replay_rejects_internal_ids_and_unknown_tariffs():
    space = CandidateSpace(profile(), tariffs(), CHANNELS)
    spec = Candidate(space.groups[("tariff_1", "HIGH")], "tariff_2", "push",
                     0.1, 0.01, []).spec("test")
    with pytest.raises(ValueError, match="Unexpected"):
        replay_plan(space.profile, [{**spec, "explicit_ids": [1]}], CHANNELS,
                    100_000, 15_000, tariffs()["tariff_plan_code"])
    with pytest.raises(ValueError, match="Unknown target"):
        replay_plan(space.profile, [{**spec, "target_tariff": "missing"}], CHANNELS,
                    100_000, 15_000, tariffs()["tariff_plan_code"])
