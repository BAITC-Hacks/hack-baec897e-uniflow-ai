"""Bounded adjacent-order/channel search diagnostic; never changes the Agent default."""
from __future__ import annotations

from dataclasses import replace
import json
import math

import numpy as np
import pandas as pd

from agent import Agent
from environment import make_environment
from mock_environment import _mock_fallback
from scoring_core import CHANNELS, MAX_TOTAL_CONTACTS, TOTAL_BUDGET, score_campaigns
from orbitduo.portfolio import PilotOverlap, best_contacted_effect, describe_portfolio, optimize
from .benchmark import REPORTS, load_inputs


def replay_candidates(candidates, space, budget, contacts):
    result = []
    for candidate in candidates:
        cost = space.channels[candidate.channel]["cost_per_contact"]
        count = min(5000, contacts, len(candidate.audience.indices), int(budget // cost) if cost else contacts)
        if count <= 0:
            return None
        result.append((candidate, candidate.audience.indices[:count], False))
        budget -= count * cost
        contacts -= count
    return result


def objective(agent, chosen):
    overlap = PilotOverlap(agent.space, agent.posterior, agent._pilots, agent.risk_penalty)
    current = overlap.expected.copy()
    best = np.full(len(current), np.nan)
    cost = 0.0
    for candidate, indices, _ in chosen:
        ratio = candidate.mean - agent.risk_penalty * math.sqrt(candidate.variance)
        best[indices] = best_contacted_effect(best[indices], np.full(len(indices), ratio))
        current[indices] = overlap.at(candidate.audience.group, best[indices])
        cost += len(indices) * agent.space.channels[candidate.channel]["cost_per_contact"]
    return float(np.dot(agent.space.baseline, current) - cost)


def main():
    profile, tariffs, model = load_inputs()
    rows = []
    for seed in (0, 1, 42):
        env, scoring_access = make_environment(profile, model, tariffs, CHANNELS, TOTAL_BUDGET,
                                               MAX_TOTAL_CONTACTS, _mock_fallback, seed=seed)
        agent = Agent()
        agent.act(env)
        current = optimize(agent.space, agent.posterior, agent._pilots, env.remaining_budget,
                           env.remaining_contacts, agent.risk_penalty, agent._channels, thorough=True)
        baseline = current
        original_objective = best_objective = objective(agent, current)
        attempts, accepted = 0, 0
        # Two sweeps, at most 64 candidate perturbations; no new experiments.
        for _ in range(2):
            candidates = [row[0] for row in current]
            alternatives = []
            for position in range(len(candidates) - 1):
                proposal = list(candidates)
                proposal[position], proposal[position + 1] = proposal[position + 1], proposal[position]
                alternatives.append(proposal)
            for position, candidate in enumerate(candidates):
                for channel in agent._channels:
                    if channel == candidate.channel:
                        continue
                    mean, variance, evidence = agent.posterior.get(candidate.audience.group, candidate.target, channel)
                    if not agent.posterior.normalized(channel) and not evidence:
                        continue
                    proposal = list(candidates)
                    proposal[position] = replace(candidate, channel=channel, mean=mean, variance=variance, pilot_ids=evidence)
                    alternatives.append(proposal)
            winner = None
            for sequence in alternatives:
                if attempts >= 64:
                    break
                attempts += 1
                proposal = replay_candidates(sequence, agent.space, env.remaining_budget, env.remaining_contacts)
                if proposal is None:
                    continue
                value = objective(agent, proposal)
                if value > best_objective + 1e-8:
                    best_objective, winner = value, proposal
            if winner is None:
                break
            current, accepted = winner, accepted + 1
        # Only after freezing both plans may the evaluator see real sampled pilot IDs.
        pilots = scoring_access.executed_pilot_campaigns()
        def evaluate(chosen):
            views, forecast = describe_portfolio(agent.space, agent.posterior, agent._pilots, chosen,
                                                 TOTAL_BUDGET - env.remaining_budget)
            strategy = pd.DataFrame(pilots + [view["spec"] for view in views])
            result = score_campaigns(strategy, profile, model, tariffs, float(profile.predicted_arpu.sum()), _mock_fallback)
            return result["net_arpu_gain"], forecast["expected_net_gain"], [view["spec"] for view in views]
        before, after = evaluate(baseline), evaluate(current)
        row = {"seed": seed, "attempted_perturbations": attempts, "accepted_sweeps": accepted,
               "risk_objective_before": original_objective, "risk_objective_after": best_objective,
               "official_net_before": before[0], "official_net_after": after[0],
               "official_net_change": after[0] - before[0], "forecast_before": before[1],
               "forecast_after": after[1], "plan_changed": before[2] != after[2]}
        rows.append(row)
        print(json.dumps(row), flush=True)
    result = {"method": "At most two adjacent-order/channel replacement sweeps, 64 perturbations; posterior and pilots frozen. Objective uses same risk penalty and pilot overlap. No truth is fed to selection.",
              "default_changed": False, "runs": rows,
              "limitation": "Three mock seeds are a diagnostic, not a generalization guarantee. Refinement stays experimental unless broader benefit is established."}
    REPORTS.mkdir(exist_ok=True)
    (REPORTS / "portfolio_refinement.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
