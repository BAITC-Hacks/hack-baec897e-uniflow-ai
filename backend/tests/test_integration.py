"""Actual CPU agent -> organizer evaluation -> persisted HTTP snapshot and exports."""
import csv
import io
import time

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.models import RunSnapshot
from backend.worker import validate_completed


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
