from types import SimpleNamespace

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend import whatif
from backend.app import create_app
from backend.models import CampaignSpec, CampaignView, RunSnapshot
from backend.storage import APIError, utc_now
from backend.tests.test_api import result
from backend.whatif_models import WhatIfRequest
from participant_package.orbitduo.evaluation import bootstrap_package


def toy_case(monkeypatch, lift=.4):
    bootstrap_package()
    profile = pd.DataFrame({"ID_NUMBER": [1, 2], "current_tariff": ["tariff_1"] * 2,
                            "arpu_segment": ["HIGH"] * 2, "predicted_arpu": [1000.] * 2})
    tariffs = pd.DataFrame({"tariff_plan_code": ["tariff_1", "tariff_2", "tariff_3"], "price_tariff": [1000, 1200, 1400]})
    model = pd.DataFrame({"tariff_plan_code_from": ["tariff_1"] * 2, "tariff_plan_code_to": ["tariff_2", "tariff_3"],
                          "arpu_segment": ["HIGH"] * 2, "arpu_change_pct": [.2, lift], "conversion_rate": [1., 1.]})
    spec = CampaignSpec(campaign_name="original", filter_arpu_segment="HIGH", filter_current_tariff="tariff_1",
                        filter_data_segment=None, filter_call_segment=None, target_tariff="tariff_3", channel="push")
    first = CampaignView(id="first", execution_order=1, spec=spec, audience_count=2, communication_cost=0,
                         expected_incremental_net_gain=999999, expected_lift_ratio=None, evidence="prior_only",
                         supporting_pilot_ids=[], reasons=[], warnings=[])
    second = first.model_copy(deep=True, update={"id": "second", "execution_order": 2,
                                               "spec": spec.model_copy(update={"channel": "sms", "target_tariff": "tariff_2"}),
                                               "communication_cost": 8})
    pilot = {**spec.model_dump(), "target_tariff": "tariff_2", "explicit_ids": [1]}
    replay = whatif.Replay(SimpleNamespace(customer_profile=profile, tariffs=tariffs), [pilot], model,
                          lambda *_: (0., .1))
    values = result()
    values.update(api_version="1", id="toy", mode="local_simulation", dataset_id="toy", status="completed", phase="completed",
                  phase_message="Done", created_at=utc_now(), updated_at=utc_now(), completed_at=utc_now(),
                  config={"seed": 42, "risk_profile": "balanced"}, events=[], failure=None,
                  forecast_net_gain=0, local_net_gain=0, campaigns=[first.model_dump(), second.model_dump()])
    snapshot = RunSnapshot.model_validate(values)
    scored = whatif._score(replay, snapshot.campaigns)
    snapshot.local_evaluation.gross_gain = scored["gross_arpu_lift"]
    snapshot.local_evaluation.net_arpu_gain = scored["net_arpu_gain"]
    snapshot.local_evaluation.communication_cost = scored["total_cost"]
    snapshot.local_evaluation.total_contacts = scored["total_contacts"]
    snapshot.local_evaluation.unique_customers = scored["unique_customers_targeted"]
    monkeypatch.setattr(whatif, "_replay", lambda _: replay)
    return snapshot


def test_overlap_is_rescored_not_subtracted_and_snapshot_immutable(monkeypatch):
    snapshot = toy_case(monkeypatch)
    saved = snapshot.model_dump()
    outcome = whatif.evaluate_what_if(snapshot, WhatIfRequest(excluded_campaign_ids=["first"]))
    assert outcome.original.net_gain == 392
    assert outcome.alternative.net_gain == 252  # 2 × (1000 × .2 × .65) - 2 × 4
    assert outcome.net_gain_difference == -140
    assert outcome.alternative.unique_customers == 2
    assert outcome.alternative.total_contacts == 3  # paid contacts + saved pilot
    assert outcome.campaigns[0].id == "second"
    assert snapshot.model_dump() == saved


def test_negative_effects_keep_best_campaign_and_pilot_costs(monkeypatch):
    snapshot = toy_case(monkeypatch, lift=-.4)
    outcome = whatif.evaluate_what_if(snapshot, WhatIfRequest(excluded_campaign_ids=["second"]))
    assert outcome.alternative.net_gain == -100  # pilot protects only customer 1
    assert outcome.net_gain_difference < 0
    empty = whatif.evaluate_what_if(snapshot, WhatIfRequest(excluded_campaign_ids=["first", "second"]))
    assert not empty.valid_final_plan
    assert empty.alternative.net_gain == 100
    assert empty.alternative.total_contacts == 1


def test_removing_early_campaign_releases_contacts_for_later_campaign(monkeypatch):
    snapshot = toy_case(monkeypatch)
    replay = whatif._replay(snapshot)
    replay.env.customer_profile = pd.DataFrame({"ID_NUMBER": range(1, 6001), "current_tariff": ["tariff_1"] * 6000,
                                               "arpu_segment": ["HIGH"] * 6000, "predicted_arpu": [1000.] * 6000})
    snapshot.campaigns.append(snapshot.campaigns[1].model_copy(deep=True, update={"id": "third", "execution_order": 3}))
    scored = whatif._score(replay, snapshot.campaigns)
    for campaign, detail in zip(snapshot.campaigns, scored["campaigns_detail"][1:], strict=True):
        campaign.audience_count = detail["n_contacts"]
        campaign.communication_cost = detail["cost"]
    evaluation = snapshot.local_evaluation
    evaluation.gross_gain = scored["gross_arpu_lift"]
    evaluation.net_arpu_gain = scored["net_arpu_gain"]
    evaluation.communication_cost = scored["total_cost"]
    evaluation.total_contacts = scored["total_contacts"]
    evaluation.unique_customers = scored["unique_customers_targeted"]
    assert snapshot.campaigns[2].audience_count == 4999
    outcome = whatif.evaluate_what_if(snapshot, WhatIfRequest(excluded_campaign_ids=["first"]))
    assert outcome.campaigns[1].id == "third"
    assert outcome.campaigns[1].audience_count == 5000


@pytest.mark.parametrize("ids", [["unknown"], ["first", "unknown"]])
def test_unknown_ids_rejected_before_replay(monkeypatch, ids):
    snapshot = toy_case(monkeypatch)
    with pytest.raises(APIError) as error:
        whatif.evaluate_what_if(snapshot, WhatIfRequest(excluded_campaign_ids=ids))
    assert error.value.code == "UNKNOWN_CAMPAIGN"


@pytest.mark.parametrize("ids", [["same", "same"], [1], [""] , ["x" * 201], [str(i) for i in range(11)]])
def test_request_rejects_invalid_selection(ids):
    with pytest.raises(ValidationError):
        WhatIfRequest(excluded_campaign_ids=ids)


def test_corrupted_baseline_rejected(monkeypatch):
    snapshot = toy_case(monkeypatch)
    snapshot.local_evaluation.net_arpu_gain += 10
    with pytest.raises(APIError) as error:
        whatif.evaluate_what_if(snapshot, WhatIfRequest(excluded_campaign_ids=[]))
    assert error.value.code == "WHAT_IF_NOT_REPRODUCIBLE"


def test_not_completed_rejected(monkeypatch):
    snapshot = toy_case(monkeypatch)
    snapshot.status = "running"
    with pytest.raises(APIError) as error:
        whatif.evaluate_what_if(snapshot, WhatIfRequest(excluded_campaign_ids=[]))
    assert error.value.code == "RUN_NOT_READY"


def test_saved_input_hash_must_match_current_files(monkeypatch):
    snapshot = toy_case(monkeypatch)
    monkeypatch.undo()
    with pytest.raises(APIError) as error:
        whatif._replay(snapshot)
    assert error.value.code == "WHAT_IF_DATASET_CHANGED"


def test_busy_service_rejects_without_queue(monkeypatch):
    snapshot = toy_case(monkeypatch)
    service = whatif.WhatIfService()
    with service.lock:
        with pytest.raises(APIError) as error:
            service.evaluate(snapshot, WhatIfRequest(excluded_campaign_ids=[]))
    assert error.value.code == "WHAT_IF_BUSY"
    assert service.evaluate(snapshot, WhatIfRequest(excluded_campaign_ids=[])).net_gain_difference == 0


def test_endpoint_validation_and_unknown_run(tmp_path):
    with TestClient(create_app(db_path=tmp_path / "whatif.db")) as client:
        path = "/api/v1/runs/missing/what-if"
        assert client.post(path, json={"excluded_campaign_ids": []}).status_code == 404
        assert client.post(path, json={"excluded_campaign_ids": ["x", "x"]}).status_code == 422
        assert client.post(path, json={"excluded_campaign_ids": [], "change_seed": 1}).status_code == 422
