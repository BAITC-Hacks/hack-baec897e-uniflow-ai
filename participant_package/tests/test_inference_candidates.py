from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from scoring_core import CHANNELS, apply_filters
from uniflow.candidates import CandidateSpace, filter_audience
from uniflow.posterior import HistoryPrior, NOISE_STD, PosteriorTable, VARIANCE_FLOOR, posterior_update

from test_public_mechanics import campaign, profile, tariffs


def test_manual_posterior_and_variance_floor():
    mean, variance = posterior_update(0.1, 0.04, 0.3, 0.01)
    assert mean == pytest.approx(0.26)
    assert variance == pytest.approx(0.008)
    assert posterior_update(1, 0, 2, 0)[1] == VARIANCE_FLOOR
    with pytest.raises(ValueError):
        posterior_update(0, -0.1, 0, 1)
    with pytest.raises(ValueError):
        posterior_update(float("nan"), 1, 0, 1)


def test_actual_n_controls_uncertainty_and_unsaturated_transfer():
    beliefs = PosteriorTable(HistoryPrior(Path("unused"), enabled=False), CHANNELS)
    beliefs.update(("a", "HIGH"), "b", "push", 0.1, 4, "p1")
    expected_mean, expected_var = posterior_update(0, 0.12 ** 2, 0.2, NOISE_STD ** 2 / (4 * 0.5 ** 2))
    push_mean, push_var, ids = beliefs.get(("a", "HIGH"), "b", "push")
    sms_mean, sms_var, sms_ids = beliefs.get(("a", "HIGH"), "b", "sms")
    assert push_mean == pytest.approx(expected_mean * .5)
    assert push_var == pytest.approx(expected_var * .5 ** 2)
    assert sms_mean == pytest.approx(push_mean * .65 / .5)
    assert sms_var == pytest.approx(push_var * (.65 / .5) ** 2)
    assert ids == sms_ids == ["p1"]
    precise = PosteriorTable(HistoryPrior(Path("unused"), enabled=False), CHANNELS)
    precise.update(("a", "HIGH"), "b", "push", 0.1, 200, "p1")
    assert precise.get(("a", "HIGH"), "b", "push")[1] < push_var


def test_call_requires_independent_evidence_and_general_multiplier_check():
    beliefs = PosteriorTable(HistoryPrior(Path("unused"), enabled=False), CHANNELS)
    beliefs.update(("a", "HIGH"), "b", "push", .4, 200, "push-1")
    assert beliefs.get(("a", "HIGH"), "b", "call")[2] == []
    beliefs.update(("a", "HIGH"), "b", "call", -.2, 25, "call-1")
    assert beliefs.get(("a", "HIGH"), "b", "call")[0] < 0
    assert beliefs.get(("a", "HIGH"), "b", "push")[0] > 0
    changed = {key: dict(value) for key, value in CHANNELS.items()}
    changed["digital_ads"]["conversion_multiplier"] = 1.05
    table = PosteriorTable(HistoryPrior(Path("unused"), enabled=False), changed)
    table.update(("a", "HIGH"), "b", "sms", .2, 200, "sms-1")
    assert table.get(("a", "HIGH"), "b", "digital_ads")[2] == []


def test_weak_history_handles_small_denominators_outliers_and_fallback(tmp_path):
    history = pd.DataFrame({"ID_NUMBER": [1, 2, 3, 4],
        "tariff_plan_code_from": ["a"] * 4, "tariff_plan_code_to": ["b"] * 4,
        "AVG_ARPU_PREV_3M": [0, 0.001, 200, 1000],
        "AVG_ARPU_NEXT_3M": [1000, 1e9, 1e12, -1e12]})
    path = tmp_path / "history.csv"
    history.to_csv(path, index=False)
    prior = HistoryPrior(path)
    for group in (("a", "LOW", "b"), ("a", "HIGH", "b"), ("c", "HIGH", "d")):
        mean, variance = prior.estimate(*group)
        assert np.isfinite(mean) and -0.08 <= mean <= 0.12
        assert variance >= .01
    assert prior.exact[("a", "b", "LOW")][1] == 2


def test_candidate_exclusion_and_optional_nulls_preserve_source_rows():
    people = profile(6)
    people.loc[0, "current_tariff"] = None
    people.loc[1, "arpu_segment"] = None
    people.loc[2, "current_tariff"] = "unknown"
    people.loc[3, "data_segment"] = None
    people.loc[4, "call_segment"] = None
    original = people.copy(deep=True)
    space = CandidateSpace(people, tariffs(), CHANNELS)
    assert space.excluded == 3
    assert len(space.groups[("a", "HIGH")].indices) == 3
    assert space.optional_missing == {"data_segment": 1, "call_segment": 1}
    assert all(source[0] != target for source, target in space.hypotheses)
    pd.testing.assert_frame_equal(people, original)
    for audience in space.slices[("a", "HIGH")]:
        if audience.data is not None:
            assert space.profile.loc[audience.indices, "data_segment"].notna().all()
        if audience.call is not None:
            assert space.profile.loc[audience.indices, "call_segment"].notna().all()


@pytest.mark.parametrize("filters", [{}, {"filter_data_segment": "HEAVY"},
    {"filter_current_tariff": " a ; b "}, {"filter_arpu_segment": "LOW"},
    {"filter_data_segment": None, "filter_call_segment": "HIGH"}])
def test_agent_filter_matches_official_filter(filters):
    people = profile(9)
    people.loc[0, "data_segment"] = None
    people.loc[1, "call_segment"] = None
    people.loc[2, "current_tariff"] = None
    spec = campaign(**filters)
    expected = apply_filters(people, pd.Series(spec)).sort_values("ID_NUMBER")
    pd.testing.assert_frame_equal(filter_audience(people, spec), expected)


def test_candidate_ids_and_baseline_reject_invalid_inputs():
    people = profile(3)
    people.loc[0, "ID_NUMBER"] = 1
    with pytest.raises(ValueError, match="unique"):
        CandidateSpace(people, tariffs(), CHANNELS)
    people = profile(3)
    people.loc[0, "predicted_arpu"] = np.inf
    with pytest.raises(ValueError, match="finite"):
        CandidateSpace(people, tariffs(), CHANNELS)
