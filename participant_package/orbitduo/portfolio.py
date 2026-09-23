"""Sequential resource replay, negative-safe maxima and marginal portfolio selection."""
from __future__ import annotations
import math
import numpy as np
from .candidates import FILTER_VALUES, SPEC_FIELDS, filter_audience


def replay_plan(profile, plan, channels, remaining_budget, remaining_contacts, tariffs=None):
    """Validate and execute the final filters; pilot resource use is supplied by caller."""
    if not 1 <= len(plan) <= 10:
        raise ValueError("Final plan must contain 1–10 campaigns")
    money, contacts = float(remaining_budget), int(remaining_contacts)
    result = []
    for spec in plan:
        if set(spec) - set(SPEC_FIELDS):
            raise ValueError("Unexpected final campaign fields")
        if spec.get("channel") not in channels:
            raise ValueError("Unknown channel")
        if tariffs is not None and spec.get("target_tariff") not in set(tariffs):
            raise ValueError("Unknown target tariff")
        for field, allowed in FILTER_VALUES.items():
            value = spec.get("filter_" + field)
            if value is not None and value not in allowed:
                raise ValueError(f"Invalid {field} filter")
        source = spec.get("filter_current_tariff")
        if source is not None:
            tokens = {part.strip() for part in str(source).split(";") if part.strip()}
            if not tokens or (tariffs is not None and tokens - set(tariffs)):
                raise ValueError("Unknown or empty current tariff filter")
        cost = float(channels[spec["channel"]]["cost_per_contact"])
        affordable = min(5000, contacts, int(money // cost) if cost > 0 else contacts)
        frame = filter_audience(profile, spec).iloc[:max(0, affordable)]
        if frame.empty:
            raise ValueError("Final campaign has no executable audience")
        money -= len(frame) * cost
        contacts -= len(frame)
        result.append({"spec": dict(spec), "n_customers": len(frame),
                       "customer_ids": frame["ID_NUMBER"].tolist(),
                       "cost": len(frame) * cost,
                       "remaining_budget": money, "remaining_contacts": contacts})
    return result


def best_contacted_effect(previous: np.ndarray, next_effect: np.ndarray) -> np.ndarray:
    """NaN means never contacted; a contacted negative effect is retained."""
    return np.where(np.isnan(previous), next_effect, np.maximum(previous, next_effect))


class PilotOverlap:
    """Analytic independent uniform pilot inclusion, with posterior means plugged in.

    Pilot IDs are unavailable. For a fixed client in a group, each pilot samples
    it with probability n/group_size, independently across separate pilots.
    Effect uncertainty is shared within a group; no sqrt(final N) reduction.
    """
    method = ("Analytic independent uniform sampling within each pilot filter; "
              "posterior mean effects plugged into client-wise maxima. "
              "Final intersections exact, pilot IDs unknown; uncertainty of maxima is not integrated.")

    def __init__(self, space, posterior, pilots, risk_penalty=0.0):
        self.groups = {}
        self.expected = np.zeros(len(space.profile))
        self.reach_probability = np.zeros(len(space.profile))
        for group, audience in space.groups.items():
            effects = []
            for pilot in pilots:
                if pilot["group"] == group:
                    mean, variance, _ = posterior.get(group, pilot["target"], pilot["channel"])
                    effects.append((mean - risk_penalty * math.sqrt(variance),
                                    min(1.0, pilot["n"] / len(audience.indices))))
            # Distribution of the highest effect among actually contacted pilots.
            survival, weights = 1.0, []
            for effect, probability in sorted(effects, reverse=True):
                weights.append((effect, probability * survival))
                survival *= 1.0 - probability
            initial = sum(effect * weight for effect, weight in weights)
            self.groups[group] = (survival, weights, initial)
            self.expected[audience.indices] = initial
            self.reach_probability[audience.indices] = 1 - survival

    def at(self, group, final_effect):
        survival, weights, _ = self.groups[group]
        total = survival * final_effect
        for effect, weight in weights:
            total = total + weight * np.maximum(effect, final_effect)
        return total


def _compiled_candidates(space, candidates, overlap, risk_penalty):
    """Compile homogeneous effects once and share audience prefix sums.

    max(E[max(P, F)], E[max(P, r)]) == E[max(P, max(F,r)) for
    deterministic F,r and fixed pilot effect distributions: the expectation is
    monotone in its final-effect argument. Never-contacted clients remain a
    separate state so negative first contacts are preserved.
    """
    prefixes = {}
    compiled = []
    for candidate in candidates:
        audience = candidate.audience
        key = id(audience)
        if key not in prefixes:
            indices = audience.indices[:5000]
            baseline = space.baseline[indices]
            prefixes[key] = (indices, baseline, np.cumsum(baseline))
        indices, baseline, prefix = prefixes[key]
        effect = candidate.mean - risk_penalty * math.sqrt(candidate.variance)
        cost = float(space.channels[candidate.channel]["cost_per_contact"])
        value = float(overlap.at(audience.group, effect))
        compiled.append((candidate, indices, baseline, prefix, effect, cost, value))
    return compiled


def _resource_prices(compiled, thorough):
    best_contact = max((row[4] * float(row[3][-1]) / len(row[1]) - row[5]
                        for row in compiled), default=0.0)
    cheapest = {}
    for row in compiled:
        key = (id(row[0].audience), row[0].target)
        if key not in cheapest or row[5] < cheapest[key][5]:
            cheapest[key] = row
    upgrades = []
    for row in compiled:
        other = cheapest[(id(row[0].audience), row[0].target)]
        if row[5] > other[5]:
            gross = float(row[3][-1]) / len(row[1]) * (row[4] - other[4])
            efficiency = gross / (row[5] - other[5]) - 1.0
            if efficiency > 0:
                upgrades.append(efficiency)
    money = [0.0]
    if upgrades:
        money += [float(np.quantile(upgrades, q)) for q in ((0.35, 0.70) if thorough else (0.5,))]
    contacts = [0.0, max(0.0, best_contact) * 0.20, max(0.0, best_contact) * 0.45] if thorough else [0.0]
    return [(contact, price) for contact in contacts for price in money]


def _greedy(space, compiled, overlap, budget, contacts, contact_price, money_price):
    money, remaining = float(budget), int(contacts)
    covered = np.zeros(len(space.profile), dtype=bool)
    current = overlap.expected.copy()
    versions = {group: 0 for group in space.groups}
    cache = {}
    chosen, total_gain = [], 0.0
    for _ in range(10):
        winner, winner_score = None, -np.inf
        for number, row in enumerate(compiled):
            candidate, all_indices, baseline, prefix, effect, cost, value = row
            count = min(remaining, len(all_indices), int(money // cost) if cost > 0 else remaining)
            if count <= 0:
                continue
            group = candidate.audience.group
            version = versions[group]
            if version == 0:
                gain = (value - overlap.groups[group][2]) * prefix[count - 1] - count * cost
            else:
                stored = cache.get(number)
                if stored is None or stored[0] != version:
                    delta = value - current[all_indices]
                    delta = np.where(covered[all_indices], np.maximum(delta, 0.0), delta)
                    gains = np.cumsum(baseline * delta - cost)
                    cache[number] = (version, gains)
                gain = cache[number][1][count - 1]
            score = gain - contact_price * count - money_price * count * cost
            if score > winner_score + 1e-8:
                winner_score = float(score)
                winner = (row, count, float(gain))
        if winner is None or winner[2] <= 1e-8 or (winner_score <= 0 and chosen):
            break
        row, count, gain = winner
        candidate, all_indices, _, _, _, cost, value = row
        indices = all_indices[:count]
        current[indices] = np.where(covered[indices], np.maximum(current[indices], value), value)
        covered[indices] = True
        versions[candidate.audience.group] += 1
        money -= count * cost
        remaining -= count
        total_gain += gain
        chosen.append((candidate, indices, False))
    return total_gain, chosen


def _replay_sequence(space, overlap, sequence, budget, contacts, risk_penalty):
    covered = np.zeros(len(space.profile), dtype=bool)
    current = overlap.expected.copy()
    chosen, cost_sum = [], 0.0
    for candidate in sequence:
        cost = float(space.channels[candidate.channel]["cost_per_contact"])
        count = min(5000, contacts, len(candidate.audience.indices),
                    int(budget // cost) if cost > 0 else contacts)
        if count <= 0:
            return None
        indices = candidate.audience.indices[:count]
        effect = candidate.mean - risk_penalty * math.sqrt(candidate.variance)
        value = float(overlap.at(candidate.audience.group, effect))
        current[indices] = np.where(covered[indices], np.maximum(current[indices], value), value)
        covered[indices] = True
        budget -= count * cost
        contacts -= count
        cost_sum += count * cost
        chosen.append((candidate, indices, False))
    gain = float(np.dot(space.baseline, current - overlap.expected) - cost_sum)
    return gain, chosen


def _refine(space, posterior, overlap, chosen, budget, contacts, risk_penalty, channels):
    """At most two sweeps and 64 exact order/channel perturbations."""
    from dataclasses import replace
    best = _replay_sequence(space, overlap, [c for c, _, _ in chosen], budget, contacts, risk_penalty)
    attempts = 0
    for _ in range(2):
        sequence = [c for c, _, _ in best[1]]
        proposals = []
        for index in range(len(sequence) - 1):
            proposal = list(sequence)
            proposal[index], proposal[index + 1] = proposal[index + 1], proposal[index]
            proposals.append(proposal)
        for index, candidate in enumerate(sequence):
            for channel in channels:
                if channel == candidate.channel:
                    continue
                mean, variance, evidence = posterior.get(candidate.audience.group, candidate.target, channel)
                if not posterior.normalized(channel) and not evidence:
                    continue
                proposal = list(sequence)
                proposal[index] = replace(candidate, channel=channel, mean=mean, variance=variance, pilot_ids=evidence)
                proposals.append(proposal)
        winner = best
        for proposal in proposals:
            if attempts >= 64:
                break
            attempts += 1
            replay = _replay_sequence(space, overlap, proposal, float(budget), int(contacts), risk_penalty)
            if replay is not None and replay[0] > winner[0] + 1e-7:
                winner = replay
        if winner is best:
            break
        best = winner
    return best[1]


def optimize(space, posterior, pilots, budget, contacts, risk_penalty, allowed_channels=None,
             thorough=False, local_search=True, resource_prices=True):
    """Marginal portfolios with money/contact shadow prices and bounded refinement.

    Group-versioned prefix sums avoid recalculating unaffected audiences whenever
    a campaign is selected. All variants use exact sequential ID-ordered caps.
    Selection remains a bounded heuristic, never a claimed global optimum.
    """
    candidates = space.candidates(posterior, allowed_channels)
    overlap = PilotOverlap(space, posterior, pilots, risk_penalty)
    if not candidates:
        raise ValueError("No eligible audience/target/channel for a final campaign")
    compiled = _compiled_candidates(space, candidates, overlap, risk_penalty)
    if resource_prices:
        prices = _resource_prices(compiled, thorough)
    else:
        best_contact = max(row[4] * float(row[3][-1]) / len(row[1]) - row[5] for row in compiled)
        prices = [(factor * max(0.0, best_contact), 0.0) for factor in ((0, .2, .45) if thorough else (0,))]
    portfolios = [_greedy(space, compiled, overlap, budget, contacts, a, b) for a, b in prices]
    chosen = max(portfolios, key=lambda item: item[0])[1]
    if chosen and thorough and local_search:
        channels = sorted(set(allowed_channels or space.channels) & set(space.channels))
        chosen = _refine(space, posterior, overlap, chosen, budget, contacts, risk_penalty, channels)
    if not chosen:
        winner, winner_gain = None, -np.inf
        fallback = space.candidates(posterior, allowed_channels, fallback=True)
        # A required final campaign must not bypass the selected risk profile.
        # If every conservative marginal is negative, choose the least damaging
        # executable slice under that SAME objective, rather than exposing a
        # large audience merely because its uncertain mean happens to be positive.
        for candidate, all_indices, _, prefix, _, cost, value in _compiled_candidates(space, fallback, overlap, risk_penalty):
            count = min(int(contacts), len(all_indices), int(float(budget) // cost) if cost > 0 else int(contacts))
            if count <= 0:
                continue
            gain = (value - overlap.groups[candidate.audience.group][2]) * prefix[count - 1] - cost * count
            if gain > winner_gain + 1e-8:
                winner_gain, winner = float(gain), (candidate, all_indices[:count], True)
        if winner is None:
            raise ValueError("No resources remain for required nonempty final campaign")
        chosen = [winner]
    return chosen


def describe_portfolio(space, posterior, pilots, chosen, pilot_cost):
    overlap = PilotOverlap(space, posterior, pilots)
    current = overlap.expected.copy()
    best_final = np.full(len(space.profile), np.nan)
    reach = overlap.reach_probability.copy()
    views, final_cost = [], 0.0
    for number, (candidate, indices, fallback) in enumerate(chosen, start=1):
        new_best = best_contacted_effect(best_final[indices], np.full(len(indices), candidate.mean))
        values = overlap.at(candidate.audience.group, new_best)
        cost = len(indices) * float(space.channels[candidate.channel]["cost_per_contact"])
        marginal = float(np.dot(space.baseline[indices], values - current[indices]) - cost)
        best_final[indices], current[indices], reach[indices] = new_best, values, 1.0
        final_cost += cost
        spec = candidate.spec(f"orbitduo_{number:02d}_{candidate.audience.group[0]}_{candidate.target}")
        views.append({"id": f"campaign-{number}", "execution_order": number, "spec": spec,
                      "audience_count": len(indices), "communication_cost": cost,
                      "expected_incremental_net_gain": marginal,
                      "expected_lift_ratio": candidate.mean if space.baseline[indices].sum() > 0 else None,
                      "evidence": "fallback" if fallback else ("pilot_supported" if candidate.pilot_ids else "prior_only"),
                      "supporting_pilot_ids": list(candidate.pilot_ids),
                      "reasons": [f"Posterior lift {candidate.mean:.5f}, standard deviation {math.sqrt(candidate.variance):.5f}.",
                                  f"Executable ID-ordered audience: {len(indices)}; marginal expected net: {marginal:.2f} CU.",
                                  "Selection accounts for previous campaigns, estimated pilot overlap, contacts and budget."],
                      "warnings": (["Required nonempty fallback: minimum estimated damage under the selected risk penalty; gain is not guaranteed."]
                                   if fallback else ([] if candidate.pilot_ids else ["Historical prior only; no direct pilot evidence."]))})
    gross = float(np.dot(space.baseline, current))
    forecast = {"scope": "pilots_and_final", "expected_gross_gain": gross,
                "expected_net_gain": gross - final_cost - float(pilot_cost),
                "net_gain_interval": None, "expected_unique_reach": float(reach.sum()),
                "overlap_method": PilotOverlap.method}
    return views, forecast
