"""Behavioral agent checks, using only a public test environment."""
import ast
import json
from pathlib import Path
import pytest

from agent import Agent
from environment import make_environment
from scoring_core import CHANNELS
from uniflow.portfolio import replay_plan
from test_public_mechanics import model, profile, tariffs, zero_fallback


def fresh_environment(seed=42, n=90):
    people = profile(n)
    people["predicted_arpu"] = 5000.0
    return make_environment(people, model(), tariffs(), CHANNELS, 100000, 15000, zero_fallback, seed=seed)[0]


def test_default_entry_point_reports_legal_plan_and_uses_pilot():
    env = fresh_environment()
    agent = Agent()
    result = agent.act(env)
    assert 1 <= len(result) <= 10
    assert env.pilot_history
    assert all(c["target_tariff"] != c["filter_current_tariff"] for c in result)
    replay = replay_plan(env.customer_profile, result, env.channels, env.remaining_budget, env.remaining_contacts, env.tariffs.tariff_plan_code)
    assert all(item["n_customers"] > 0 for item in replay)
    assert agent.report["pilots"]
    assert agent.report["forecast"]["scope"] == "pilots_and_final"
    json.dumps(agent.report, allow_nan=False)


def test_reusing_agent_does_not_retain_posterior_between_acts():
    agent = Agent(use_history=False, max_pilots=4)
    first_env = fresh_environment()
    first = agent.act(first_env)
    first_pilots = [(p["target_tariff"], p["channel"], p["observed_lift_ratio"]) for p in first_env.pilot_history]
    second_env = fresh_environment()
    second = agent.act(second_env)
    second_pilots = [(p["target_tariff"], p["channel"], p["observed_lift_ratio"]) for p in second_env.pilot_history]
    assert first == second
    assert first_pilots == second_pilots
    assert len(agent.report["pilots"]) == len(second_env.pilot_history)


def test_observer_failure_does_not_change_decision():
    def broken_observer(event):
        raise RuntimeError("intentional observer failure")
    normal = Agent(use_history=False, max_pilots=2).act(fresh_environment())
    broken = Agent(use_history=False, max_pilots=2, observer=broken_observer).act(fresh_environment())
    assert normal == broken


def test_different_pilot_answers_change_decision():
    def run(sign):
        env = fresh_environment(n=400)
        original = env.run_pilot
        calls = []

        def pilot(**kwargs):
            result = original(**kwargs)
            # Test-only controlled observations, while public accounting remains real.
            answer = sign * .8 if kwargs["target_tariff"] == "b" else -.2
            result["observed_lift_ratio"] = answer
            result["observed_lift_total"] = answer * result["n_customers"] * 5000
            calls.append((kwargs["target_tariff"], kwargs["channel"], kwargs["n_customers"]))
            return result

        env.run_pilot = pilot
        final = Agent(use_history=False, max_pilots=8, allowed_channels=["push"]).act(env)
        return calls, final
    positive, negative = run(1), run(-1)
    assert positive != negative
    assert positive[1] != negative[1]


def test_pilot_exception_rereads_resources_and_reserves_final_contacts():
    env = fresh_environment()
    original = env.run_pilot
    failures = [True]

    def interrupted_pilot(**kwargs):
        if failures:
            failures.pop()
            raise RuntimeError("transient test failure before execution")
        return original(**kwargs)

    env.run_pilot = interrupted_pilot
    agent = Agent(use_history=False, max_pilots=4)
    result = agent.act(env)
    assert result and env.pilot_history
    assert env.remaining_contacts > 0


@pytest.mark.parametrize("adaptive,contacts", [(True, 50), (False, 250)])
def test_pilots_reserve_nonempty_final_plan_with_low_contact_balance(adaptive, contacts):
    people = profile(400)
    people["predicted_arpu"] = 5000.0
    env, _ = make_environment(people, model(), tariffs(), CHANNELS, 100000,
        contacts, zero_fallback, seed=42)
    result = Agent(use_history=False, adaptive=adaptive, allowed_channels=["push"], max_pilots=4).act(env)
    assert result and env.pilot_history
    assert 1 <= env.remaining_contacts < contacts
    assert all(10 <= p["n_customers"] <= 200 for p in env.pilot_history)
    replay = replay_plan(people, result, CHANNELS, env.remaining_budget, env.remaining_contacts)
    assert sum(p["n_customers"] for p in replay) <= env.remaining_contacts


def test_decision_modules_do_not_import_evaluator_or_hidden_state():
    package = Path(__file__).resolve().parents[1]
    paths = [package / "agent.py"] + [path for path in (package / "uniflow").glob("*.py")
        if path.name not in {"evaluation.py", "service_data.py", "audit.py", "__init__.py"}]
    forbidden_imports = {"mock_environment", "scoring_core", "environment", "gc", "inspect", "evaluation"}
    forbidden_attributes = {"__closure__", "__globals__", "internals", "executed_pilot_campaigns"}
    for path in paths:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                assert not {alias.name.split(".")[0] for alias in node.names} & forbidden_imports, path
            elif isinstance(node, ast.ImportFrom):
                assert not set((node.module or "").split(".")) & forbidden_imports, path
            elif isinstance(node, ast.Attribute):
                assert node.attr not in forbidden_attributes, path
