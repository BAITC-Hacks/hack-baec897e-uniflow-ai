"""Independent arithmetic regressions for revised portfolio code, no hidden models."""
from itertools import combinations, product

import numpy as np
import pandas as pd
import pytest

from orbitduo.candidates import Candidate, CandidateSpace
from orbitduo.portfolio import PilotOverlap, describe_portfolio, optimize, replay_plan


CHANNELS = {"push": {"cost_per_contact": 0, "conversion_multiplier": .5},
            "sms": {"cost_per_contact": 4, "conversion_multiplier": .65},
            "digital_ads": {"cost_per_contact": 22, "conversion_multiplier": .85},
            "call": {"cost_per_contact": 160, "conversion_multiplier": 1.2}}


def space(count=4):
    people = pd.DataFrame({"ID_NUMBER": np.arange(count, 0, -1), "current_tariff": "a",
                           "arpu_segment": "HIGH", "data_segment": "HEAVY", "call_segment": "HIGH",
                           "predicted_arpu": np.arange(1, count + 1) * 100.})
    return CandidateSpace(people, pd.DataFrame({"tariff_plan_code": ["a", "b", "c"]}), CHANNELS)


class FixedPosterior:
    def __init__(self, means):
        self.means = means

    def get(self, group, target, channel):
        return self.means.get((target, channel), -.3), .0001, [f"fixed-{target}-{channel}"]

    def normalized(self, channel):
        return channel != "call"


def candidate(audience, target, channel, posterior):
    mean, variance, ids = posterior.get(audience.group, target, channel)
    return Candidate(audience, target, channel, mean, variance, ids)


@pytest.mark.parametrize("channel,cost", [("push", 0), ("sms", 4)])
def test_duplicate_contact_adds_only_communication_cost(channel, cost):
    data = space()
    beliefs = FixedPosterior({("b", channel): .2})
    audience = data.groups[("a", "HIGH")]
    chosen = (candidate(audience, "b", channel, beliefs), audience.indices, False)
    views, forecast = describe_portfolio(data, beliefs, [], [chosen, chosen], 0)
    assert views[0]["expected_incremental_net_gain"] == pytest.approx(data.baseline.sum() * .2 - 4 * cost)
    assert views[1]["expected_incremental_net_gain"] == pytest.approx(-4 * cost)
    assert forecast["expected_gross_gain"] == pytest.approx(data.baseline.sum() * .2)
    assert forecast["expected_net_gain"] == pytest.approx(data.baseline.sum() * .2 - 8 * cost)
    assert forecast["expected_unique_reach"] == 4


def test_negative_first_contact_and_better_earlier_contact_remain_in_forecast():
    data = space()
    beliefs = FixedPosterior({("b", "push"): -.2, ("c", "push"): -.4})
    audience = data.groups[("a", "HIGH")]
    first = (candidate(audience, "b", "push", beliefs), audience.indices, True)
    second = (candidate(audience, "c", "push", beliefs), audience.indices, True)
    views, forecast = describe_portfolio(data, beliefs, [], [first, second], 0)
    assert views[0]["expected_incremental_net_gain"] == pytest.approx(-.2 * data.baseline.sum())
    assert views[1]["expected_incremental_net_gain"] == 0
    assert forecast["expected_gross_gain"] == pytest.approx(-.2 * data.baseline.sum())
    assert forecast["expected_unique_reach"] == 4


def test_pilot_overlap_matches_complete_enumeration_for_fixed_posterior():
    data = space()
    beliefs = FixedPosterior({("b", "push"): -.2, ("c", "push"): .1, ("b", "sms"): -.3})
    audience = data.groups[("a", "HIGH")]
    pilots = [{"group": audience.group, "target": "b", "channel": "push", "n": 2},
              {"group": audience.group, "target": "c", "channel": "push", "n": 1}]
    chosen = [(candidate(audience, "b", "sms", beliefs), audience.indices[:2], False)]
    _, forecast = describe_portfolio(data, beliefs, pilots, chosen, 0)
    gross, reaches = [], []
    for negative_pick, positive_pick in product(combinations(range(4), 2), combinations(range(4), 1)):
        best = np.full(4, np.nan)
        best[list(negative_pick)] = -.2
        best[list(positive_pick)] = np.fmax(best[list(positive_pick)], .1)
        best[:2] = np.fmax(best[:2], -.3)
        gross.append(float(np.dot(data.baseline, np.nan_to_num(best))))
        reaches.append(int(np.isfinite(best).sum()))
    assert forecast["expected_gross_gain"] == pytest.approx(np.mean(gross), abs=1e-12)
    assert forecast["expected_unique_reach"] == pytest.approx(np.mean(reaches), abs=1e-12)
    # Caller metadata order does not change the analytic distribution of best effect.
    forward = PilotOverlap(data, beliefs, pilots)
    reverse = PilotOverlap(data, beliefs, pilots[::-1])
    np.testing.assert_allclose(forward.expected, reverse.expected, rtol=0, atol=1e-15)
    np.testing.assert_allclose(forward.reach_probability, reverse.reach_probability, rtol=0, atol=1e-15)


def test_optimizer_is_deterministic_for_fixed_posterior_and_pilot_overlap():
    data = space(30)
    beliefs = FixedPosterior({("b", "push"): .2, ("c", "push"): .1})
    pilots = [{"group": ("a", "HIGH"), "target": "c", "channel": "push", "n": 10}]

    def run():
        chosen = optimize(data, beliefs, pilots, 0, 50, .5, ["push"], thorough=True)
        views, forecast = describe_portfolio(data, beliefs, pilots, chosen, 0)
        return views, forecast

    first, second = run(), run()
    assert first == second
    assert len(first[0]) == 1  # An identical free repeat adds no gain and must not waste a slot.
    assert first[0][0]["spec"]["target_tariff"] == "b"


@pytest.mark.parametrize("budget,contacts", [(0, 17), (4, 17), (160, 17), (100000, 5001)])
def test_optimizer_and_replay_obey_remaining_resources(budget, contacts):
    data = space(5001)
    beliefs = FixedPosterior({("b", "push"): .1, ("b", "sms"): .13,
                             ("b", "digital_ads"): .17, ("b", "call"): .2})
    chosen = optimize(data, beliefs, [], budget, contacts, .5, thorough=True)
    views, _ = describe_portfolio(data, beliefs, [], chosen, 0)
    replay = replay_plan(data.profile, [view["spec"] for view in views], data.channels,
                         budget, contacts, data.tariffs)
    assert all(0 < row["n_customers"] <= 5000 for row in replay)
    assert sum(row["n_customers"] for row in replay) <= contacts
    assert sum(row["cost"] for row in replay) <= budget
    assert [len(indices) for _, indices, _ in chosen] == [row["n_customers"] for row in replay]
    assert replay[-1]["remaining_budget"] >= 0 and replay[-1]["remaining_contacts"] >= 0


@pytest.mark.parametrize("budget,contacts,contact_price,money_price", [(0, 31, 0, 0), (40, 31, 5, .2), (500, 19, 0, 1)])
def test_compiled_cache_matches_independent_customerwise_greedy(budget, contacts, contact_price, money_price):
    from orbitduo.portfolio import _compiled_candidates, _greedy
    people = space(24).profile.copy()
    people.loc[12:, "arpu_segment"] = "MID"
    people.loc[people.index % 2 == 0, "data_segment"] = "LITE"
    data = CandidateSpace(people, pd.DataFrame({"tariff_plan_code": ["a", "b", "c"]}), CHANNELS)
    beliefs = FixedPosterior({("b", "push"): .18, ("b", "sms"): .24,
                             ("c", "push"): -.12, ("c", "sms"): .36,
                             ("c", "digital_ads"): .41, ("b", "call"): .5})
    pilots = [{"group": group, "target": target, "channel": channel, "n": 3}
              for group in data.groups for target, channel in [("c", "push"), ("b", "sms")]]
    risk = .2
    overlap = PilotOverlap(data, beliefs, pilots, risk)
    candidates = [candidate(audience, target, channel, beliefs)
                  for group in data.groups for audience in data.slices[group]
                  for target in ("b", "c") for channel in CHANNELS]
    compiled = _compiled_candidates(data, candidates, overlap, risk)
    cached_gain, cached = _greedy(data, compiled, overlap, budget, contacts, contact_price, money_price)

    # Independently recompute every customer contribution each iteration. No
    # prefix, monotonic-max shortcut, cache version, or compiled candidate used.
    previous_final = np.full(len(data.profile), np.nan)
    previous_expected = overlap.expected.copy()
    remaining_money, remaining_contacts = budget, contacts
    brute, brute_gain = [], 0.0
    for _ in range(10):
        winner, best_score = None, -np.inf
        for entry in candidates:
            cost = CHANNELS[entry.channel]["cost_per_contact"]
            count = min(5000, remaining_contacts, len(entry.audience.indices),
                        int(remaining_money // cost) if cost else remaining_contacts)
            if count <= 0:
                continue
            indices = entry.audience.indices[:count]
            effect = entry.mean - risk * np.sqrt(entry.variance)
            final_effect = np.fmax(previous_final[indices], effect)
            expected = np.asarray([overlap.at(entry.audience.group, float(value)) for value in final_effect])
            gain = float(np.sum(data.baseline[indices] * (expected - previous_expected[indices])) - count * cost)
            score = gain - contact_price * count - money_price * count * cost
            if score > best_score + 1e-8:
                best_score, winner = score, (entry, indices, gain, final_effect, expected, count * cost)
        if winner is None or winner[2] <= 1e-8 or (best_score <= 0 and brute):
            break
        entry, indices, gain, final_effect, expected, cost = winner
        previous_final[indices], previous_expected[indices] = final_effect, expected
        remaining_contacts -= len(indices)
        remaining_money -= cost
        brute_gain += gain
        brute.append((entry, indices))
    assert cached_gain == pytest.approx(brute_gain, rel=1e-12, abs=1e-8)
    assert len(cached) == len(brute)
    for (actual, indices, _), (expected, expected_indices) in zip(cached, brute):
        assert actual is expected
        np.testing.assert_array_equal(indices, expected_indices)


def test_positive_mean_negative_risk_bound_fallback_limits_estimated_harm():
    people = space(100).profile.copy()
    people.loc[people["predicted_arpu"].idxmin(), "data_segment"] = "LITE"
    data = CandidateSpace(people, pd.DataFrame({"tariff_plan_code": ["a", "b", "c"]}), CHANNELS)
    # Mean .001 is positive, but .55 * sd(.0001) gives a negative risk bound.
    # The mandatory fallback must retain that decision objective and prefer the
    # legal one-person slice over exposing the entire group to estimated harm.
    beliefs = FixedPosterior({("b", "push"): .001})
    chosen = optimize(data, beliefs, [], 0, 100, .55, ["push"], thorough=True)
    assert len(chosen) == 1
    entry, indices, fallback = chosen[0]
    assert fallback is True
    assert entry.target == "b"
    assert len(indices) == 1
    assert data.baseline[indices].sum() == people["predicted_arpu"].min()
