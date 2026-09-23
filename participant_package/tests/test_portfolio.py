"""Compare public replay and overlap arithmetic against small explicit examples."""
from pathlib import Path

import numpy as np
import pytest

from scoring_core import CHANNELS
from uniflow.candidates import CandidateSpace
from uniflow.portfolio import PilotOverlap, best_contacted_effect, describe_portfolio, optimize, replay_plan
from uniflow.posterior import HistoryPrior, PosteriorTable
from test_public_mechanics import campaign, profile, score, tariffs


def test_replay_matches_official_sorting_caps_and_resources():
    people = profile(5001)
    rows = [campaign(channel="sms"), campaign(channel="push"), campaign(channel="call")]
    replay = replay_plan(people, rows, CHANNELS, 100000, 15000, tariffs().tariff_plan_code)
    official = score(rows, people)
    assert [row["n_customers"] for row in replay] == [row["n_contacts"] for row in official["campaigns_detail"]]
    assert sum(row["cost"] for row in replay) == official["total_cost"]
    assert replay[0]["customer_ids"] == list(range(1, 5001))
    assert replay[1]["customer_ids"] == replay[0]["customer_ids"]
    assert replay[-1]["remaining_budget"] == 0


def test_replay_includes_pilot_resource_consumption():
    rows = [campaign(channel="sms"), campaign(channel="push")]
    replay = replay_plan(profile(5001), rows, CHANNELS, 8, 7, tariffs().tariff_plan_code)
    assert [row["n_customers"] for row in replay] == [2, 5]
    assert replay[-1]["remaining_contacts"] == 0
    assert replay[-1]["remaining_budget"] == 0


@pytest.mark.parametrize("rows,budget,contacts", [([], 100, 10),
    ([campaign(filter_arpu_segment="LOW")], 100, 10),
    ([campaign(channel="call")], 0, 10), ([campaign()], 100, 0),
    ([campaign() | {"explicit_ids": [1]}], 100, 10),
    ([campaign() | {"top_k": 1}], 100, 10)])
def test_replay_rejects_empty_and_forbidden_plans(rows, budget, contacts):
    with pytest.raises(ValueError):
        replay_plan(profile(), rows, CHANNELS, budget, contacts)


@pytest.mark.parametrize("changes", [
    {"filter_current_tariff": "a;unknown"},
    {"filter_arpu_segment": "HGIH"},
    {"filter_data_segment": "HEAVYY"},
    {"filter_call_segment": "MED"},
])
def test_replay_rejects_invalid_filter_values_before_execution(changes):
    with pytest.raises(ValueError):
        replay_plan(profile(), [campaign(**changes)], CHANNELS, 100000, 15000,
                    tariffs().tariff_plan_code)


def test_negative_best_contacted_effect_keeps_first_negative():
    previous = np.array([np.nan, -.2, .3, -.1])
    next_effect = np.array([-.4, -.3, .2, .1])
    np.testing.assert_allclose(best_contacted_effect(previous, next_effect), [-.4, -.2, .3, .1])


class KnownMeans:
    def get(self, group, target, channel):
        return {"b": -.2, "c": .1}[target], .04, [target]


def test_analytic_pilot_overlap_negative_max_and_monte_carlo():
    space = CandidateSpace(profile(5), tariffs(), CHANNELS)
    pilots = [{"group": ("a", "HIGH"), "target": "b", "channel": "push", "n": 2},
              {"group": ("a", "HIGH"), "target": "c", "channel": "push", "n": 1}]
    overlap = PilotOverlap(space, KnownMeans(), pilots)
    # Positive pilot wins with p=.2; negative pilot contributes only when p2 misses.
    assert overlap.expected[0] == pytest.approx(.1 * .2 - .2 * .4 * .8)
    assert overlap.reach_probability[0] == pytest.approx(1 - .6 * .8)
    expected_after_final = -.3 * .6 * .8 + .1 * .2 - .2 * .4 * .8
    assert overlap.at(("a", "HIGH"), -.3) == pytest.approx(expected_after_final)
    rng = np.random.default_rng(8)
    values = []
    for _ in range(10000):
        best = np.full(5, np.nan)
        for effect, size in ((-.2, 2), (.1, 1)):
            indexes = rng.choice(5, size=size, replace=False)
            best[indexes] = best_contacted_effect(best[indexes], np.full(size, effect))
        values.append(np.nan_to_num(best).mean())
    assert np.mean(values) == pytest.approx(overlap.expected[0], abs=.002)


def test_all_negative_posterior_produces_nonempty_marked_fallback():
    people = profile(25)
    people.loc[0, "data_segment"] = "LITE"
    space = CandidateSpace(people, tariffs(), CHANNELS)
    beliefs = PosteriorTable(HistoryPrior(Path("unused"), enabled=False), CHANNELS)
    for target in ("b", "c", "d"):
        beliefs.update(("a", "HIGH"), target, "push", -1.0, 200, "p-" + target)
    chosen = optimize(space, beliefs, [], 100000, 100, .5)
    assert len(chosen) == 1 and chosen[0][2] is True
    views, forecast = describe_portfolio(space, beliefs, [], chosen, 0)
    assert views[0]["evidence"] == "fallback"
    assert views[0]["warnings"]
    assert views[0]["audience_count"] > 0
    assert forecast["expected_net_gain"] < 0
    replay_plan(people, [view["spec"] for view in views], CHANNELS, 100000, 100)
