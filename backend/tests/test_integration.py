"""Actual CPU agent -> organizer evaluation -> persisted HTTP snapshot and exports."""
import csv
import io
import time
import pytest

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.models import RunSnapshot
from backend.worker import validate_completed
from backend.whatif import _replay
from backend.storage import APIError


def test_real_local_run_and_export(tmp_path):
    with TestClient(create_app(db_path=tmp_path / "real-runs.db")) as client:
        started = time.monotonic()
        response = client.post("/api/v1/runs", json={"seed": 42, "risk_profile": "balanced"},
                               headers={"Idempotency-Key": "real-seed-42"})
        assert response.status_code == 202, response.text
        run_id = response.json()["id"]
        deadline = started + 300
        while time.monotonic() < deadline:
            response = client.get(f"/api/v1/runs/{run_id}")
            snapshot = RunSnapshot.model_validate(response.json())
            assert client.get("/api/v1/health").status_code == 200
            if snapshot.status in {"completed", "failed"}:
                break
            time.sleep(.05)
        assert snapshot.status == "completed", snapshot.failure
        validate_completed(snapshot)
        assert snapshot.local_evaluation.runtime_seconds < 300
        assert snapshot.local_evaluation.n_pilots > 0
        assert snapshot.events
        assert all(p.completed_at.utcoffset().total_seconds() == 0 for p in snapshot.pilots)
        exported = client.get(f"/api/v1/runs/{run_id}/campaigns.csv")
        rows = list(csv.DictReader(io.StringIO(exported.text)))
        assert rows == [{key: "" if value is None else value for key, value in c.spec.model_dump().items()}
                        for c in snapshot.campaigns]
        report = client.get(f"/api/v1/runs/{run_id}/report.json")
        assert report.json() == snapshot.model_dump(mode="json")
        assert snapshot.forecast_net_gain == snapshot.forecast.expected_net_gain
        assert snapshot.local_net_gain == snapshot.local_evaluation.net_arpu_gain
        # Subset rescoring preserves the original snapshot and both exports.
        original_json = response.json()
        baseline = client.post(f"/api/v1/runs/{run_id}/what-if", json={"excluded_campaign_ids": []})
        assert baseline.status_code == 200, baseline.text
        assert baseline.json()["net_gain_difference"] == 0
        assert baseline.json()["original"] == baseline.json()["alternative"]
        subset = client.post(f"/api/v1/runs/{run_id}/what-if", json={"excluded_campaign_ids": [snapshot.campaigns[0].id]})
        assert subset.status_code == 200, subset.text
        assert subset.json()["retained_campaign_ids"] == [campaign.id for campaign in snapshot.campaigns[1:]]
        empty = client.post(f"/api/v1/runs/{run_id}/what-if", json={"excluded_campaign_ids": [campaign.id for campaign in snapshot.campaigns]})
        assert empty.status_code == 200, empty.text
        assert empty.json()["valid_final_plan"] is False
        assert empty.json()["alternative"]["total_contacts"] == snapshot.resources.contacts.used_by_pilots
        assert client.get(f"/api/v1/runs/{run_id}").json() == original_json
        assert client.get(f"/api/v1/runs/{run_id}/campaigns.csv").content == exported.content
        assert client.get(f"/api/v1/runs/{run_id}/report.json").content == report.content
        # Physical array order is irrelevant; the saved sequence determines RNG order.
        reordered = snapshot.model_copy(deep=True)
        reordered.pilots.reverse()
        assert len(_replay(reordered).pilots) == len(snapshot.pilots)
        corrupted = snapshot.model_copy(deep=True)
        corrupted.pilots[0].observed_lift_total += 1
        with pytest.raises(APIError) as mismatch:
            _replay(corrupted)
        assert mismatch.value.code == "WHAT_IF_NOT_REPRODUCIBLE"
