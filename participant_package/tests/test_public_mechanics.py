"""Tiny numerical fixtures anchor the planner to the unchanged official scorer."""
import numpy as np
import pandas as pd
import pytest

from environment import make_environment
from scoring_core import CHANNELS, apply_filters, score_campaigns


def profile(n=5):
    return pd.DataFrame({"ID_NUMBER": np.arange(n, 0, -1), "current_tariff": "a",
        "arpu_segment": "HIGH", "data_segment": "HEAVY", "call_segment": "HIGH",
        "predicted_arpu": np.arange(n, 0, -1, dtype=float) * 100})


def tariffs():
    return pd.DataFrame({"tariff_plan_code": ["a", "b", "c", "d"], "price_tariff": [10, 20, 30, 40]})


def model(deltas=(0.2, -0.4, 0.1), conversion=1.0):
    return pd.DataFrame({"tariff_plan_code_from": ["a"] * 3, "arpu_segment": ["HIGH"] * 3,
        "tariff_plan_code_to": ["b", "c", "d"], "arpu_change_pct": deltas, "conversion_rate": conversion})


def campaign(target="b", channel="push", **filters):
    return {"campaign_name": target, "target_tariff": target, "channel": channel,
            "filter_current_tariff": "a", **filters}


def zero_fallback(*args):
    return 0.0, 0.0


def score(rows, people=None, effects=None):
    people = profile() if people is None else people
    effects = model() if effects is None else effects
    table = pd.DataFrame(rows)
    for col in ("filter_arpu_segment", "filter_data_segment", "filter_call_segment", "filter_current_tariff", "explicit_ids"):
        if col not in table:
            table[col] = None
    return score_campaigns(table, people, effects, tariffs(), float(people.predicted_arpu.sum()), zero_fallback)


def test_negative_max_stays_negative_and_best_need_not_be_last():
    actual = score([campaign("b"), campaign("c"), campaign("d")], effects=model((-0.2, -0.4, -0.3)))
    assert actual["gross_arpu_lift"] == pytest.approx(-150)
    assert actual["total_contacts"] == 15
    assert actual["unique_customers_targeted"] == 5
    positive = score([campaign("b"), campaign("c"), campaign("d")])
    assert positive["gross_arpu_lift"] == pytest.approx(150)


def test_5001_sorted_ids_and_repeated_filter_is_not_pagination():
    people = profile(5001)
    people.loc[people.ID_NUMBER == 5001, "predicted_arpu"] = 10**12
    actual = score([campaign(), campaign()], people)
    expected = people.loc[people.ID_NUMBER <= 5000, "predicted_arpu"].sum() * 0.1
    assert actual["gross_arpu_lift"] == pytest.approx(expected)
    assert actual["total_contacts"] == 10000
    assert actual["unique_customers_targeted"] == 5000
    assert all(row["capped_at_campaign_limit"] for row in actual["campaigns_detail"])


def test_budget_exhausted_call_and_free_push_still_contacts():
    actual = score([campaign(channel="call"), campaign(channel="call"), campaign(channel="push")], profile(1000))
    assert [row["n_contacts"] for row in actual["campaigns_detail"]] == [625, 0, 1000]
    assert actual["total_cost"] == 100000
    assert actual["total_contacts"] == 1625


def test_contacts_exhausted_and_negative_push_is_not_safe():
    actual = score([campaign()] * 4, profile(5001), model((-0.2, -0.1, -0.3)))
    assert actual["total_contacts"] == 15000
    assert [row["n_contacts"] for row in actual["campaigns_detail"]] == [5000, 5000, 5000, 0]
    assert actual["total_cost"] == 0
    assert actual["net_arpu_gain"] < 0


def test_filters_missing_optional_values_and_empty_audience():
    people = profile(4)
    people.loc[0, "data_segment"] = None
    people.loc[1, "current_tariff"] = "b"
    assert len(apply_filters(people, pd.Series(campaign(filter_current_tariff=" a ; b ")))) == 4
    assert len(apply_filters(people, pd.Series(campaign(filter_current_tariff="a", filter_data_segment="HEAVY")))) == 2
    assert len(apply_filters(people, pd.Series(campaign(filter_current_tariff="a", filter_data_segment=None)))) == 3
    assert score([campaign(filter_arpu_segment="LOW")], people)["total_contacts"] == 0


@pytest.mark.parametrize("remaining,expected", [(15000, 4), (2, 2)])
def test_pilot_actual_size_less_than_requested_and_history_hides_ids(remaining, expected):
    env, organizer = make_environment(profile(4), model(), tariffs(), CHANNELS, 100000, remaining, zero_fallback, seed=12)
    result = env.run_pilot(target_tariff="b", channel="sms", n_customers=200, filter_current_tariff="a")
    assert result["n_customers"] == expected
    assert result["cost"] == expected * 4
    assert env.remaining_contacts == remaining - expected
    assert env.pilots_left == 19
    assert "explicit_ids" not in result
    assert "filter_current_tariff" not in env.pilot_history[0]
    assert len(organizer.executed_pilot_campaigns()[0]["explicit_ids"]) == expected


def test_call_saturation_prevents_linear_push_extrapolation():
    push = score([campaign(channel="push")], effects=model(conversion=0.99))["gross_arpu_lift"]
    call = score([campaign(channel="call")], effects=model(conversion=0.99))["gross_arpu_lift"]
    assert push == pytest.approx(1500 * 0.2 * 0.99 * 0.5)
    assert call == pytest.approx(1500 * 0.2)
    assert call < push * 2.4


def test_pilot_contact_is_scored_before_final_and_every_contact_is_paid():
    pilot = campaign("b", "sms") | {"explicit_ids": [1, 3]}
    actual = score([pilot, campaign("c", "sms")])
    assert actual["total_contacts"] == 7
    assert actual["total_cost"] == 28
    assert actual["gross_arpu_lift"] == pytest.approx((100 + 300) * 0.2 * .65 + (200 + 400 + 500) * -.4 * .65)


def test_public_factory_has_no_truth_attributes():
    env, _ = make_environment(profile(), model(), tariffs(), CHANNELS, 100000, 15000, zero_fallback, seed=42)
    assert set(vars(env)) == {"customer_profile", "tariffs", "channels", "total_budget", "max_total_contacts",
        "remaining_budget", "remaining_contacts", "pilots_left", "pilot_history", "run_pilot"}
