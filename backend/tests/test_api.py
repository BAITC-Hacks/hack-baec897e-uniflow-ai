from concurrent.futures import ThreadPoolExecutor
import csv
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from threading import Event
import time

from fastapi.testclient import TestClient
import pytest

from backend.app import CAMPAIGN_COLUMNS, create_app
from backend.models import Overview, RunConfig, RunSnapshot
from backend.storage import APIError, RunStore, utc_now


@pytest.fixture
def overview():
    return {
        "mode": "local_simulation", "currency": "CU",
        "dataset": {"id": "test-data", "customer_count": 100, "baseline_revenue": 100000,
                    "eligible_customer_count": 100, "excluded_customer_count": 0,
                    "exclusion_reason": "", "notices": []},
        "limits": {"budget": 100000, "contacts": 15000, "pilots": 20,
                   "final_campaigns": 10, "customers_per_campaign": 5000,
                   "pilot_size_min": 10, "pilot_size_max": 200},
        "channels": [{"code": "push", "label": "Push", "cost_per_contact": 0, "conversion_multiplier": .5}],
        "tariffs": [{"code": "tariff_1", "monthly_fee": None, "description": "Test"}],
        "segments": [{"current_tariff": "tariff_1", "arpu_segment": "HIGH", "customer_count": 100,
                      "baseline_revenue": 100000, "average_predicted_arpu": 1000, "eligible": True}],
    }


def result():
    spec = dict(zip(CAMPAIGN_COLUMNS, ["Test, plan", "HIGH", None, None, "tariff_1", "tariff_2", "push"]))
    return {
        "resources": {
            "budget": {"limit": 100000, "used_by_pilots": 0, "planned_final": 0, "remaining_after_plan": 100000},
            "contacts": {"limit": 15000, "used_by_pilots": 10, "planned_final": 100, "remaining_after_plan": 14890},
            "pilots_used": 1, "pilots_limit": 20, "final_campaigns_count": 1, "final_campaigns_limit": 10},
        "pilots": [{"id": "pilot_1", "sequence": 1, "campaign": {**spec, "campaign_name": "pilot_1"},
                    "requested_customers": 10, "actual_customers": 10, "cost": 0,
                    "observed_lift_ratio": .1, "observed_lift_total": 1000,
                    "selection_reason": "Test exploration", "decision_after": "Test update", "completed_at": utc_now()}],
        "campaigns": [{"id": "campaign_1", "execution_order": 1, "spec": spec, "audience_count": 100,
                       "communication_cost": 0, "expected_incremental_net_gain": 10000,
                       "expected_lift_ratio": .1, "evidence": "pilot_supported", "supporting_pilot_ids": ["pilot_1"],
                       "reasons": ["Test result"], "warnings": []}],
        "forecast": {"scope": "pilots_and_final", "expected_gross_gain": 10000, "expected_net_gain": 10000,
                     "net_gain_interval": None, "expected_unique_reach": 100, "overlap_method": "Test complete overlap"},
        "local_evaluation": {"label": "local_simulation", "gross_gain": 10000, "net_arpu_gain": 10000,
                             "communication_cost": 0, "total_contacts": 110, "unique_customers": 100,
                             "n_pilots": 1, "n_final_campaigns": 1, "runtime_seconds": .01}, "warnings": [],
    }


def wait_terminal(client, run_id, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/v1/runs/{run_id}")
        assert response.status_code == 200
        snapshot = response.json()
        if snapshot["status"] in {"completed", "failed"}:
            return snapshot
        time.sleep(.01)
    pytest.fail("Worker did not finish")


def submit(client, key="test-key", seed=42):
    return client.post("/api/v1/runs", json={"seed": seed, "risk_profile": "balanced"}, headers={"Idempotency-Key": key})


def test_health_real_overview_and_openapi(tmp_path):
    with TestClient(create_app(db_path=tmp_path / "runs.db")) as client:
        assert client.get("/api/v1/health").json() == {"status": "ok", "api_version": "1", "mode": "local_simulation"}
        response = client.get("/api/v1/overview")
        assert response.status_code == 200, response.text
        parsed = Overview.model_validate(response.json())
        assert parsed.dataset.customer_count == parsed.dataset.eligible_customer_count + parsed.dataset.excluded_customer_count
        assert parsed.dataset.customer_count > 0
        assert parsed.dataset.baseline_revenue > 0
        assert len(parsed.tariffs) > 0
        assert "NaN" not in response.text and "Infinity" not in response.text
        schema = client.get("/openapi.json").json()
        assert sum(len(methods) for path, methods in schema["paths"].items() if path.startswith("/api/v1")) == 7
        assert "RunSnapshot" in schema["components"]["schemas"]


def test_active_idempotency_exports_and_persistence(tmp_path, overview):
    entered, release = Event(), Event()
    calls = []

    def runner(**kwargs):
        calls.append(kwargs["seed"])
        entered.set()
        assert release.wait(5)
        return result()

    path = tmp_path / "runs.db"
    with TestClient(create_app(db_path=path, overview_provider=lambda: overview, runner=runner)) as client:
        try:
            first = submit(client)
            assert first.status_code == 202
            run_id = first.json()["id"]
            assert entered.wait(2)
            again = submit(client)
            assert again.status_code == 202 and again.json()["id"] == run_id
            conflict = submit(client, seed=43)
            assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
            active = submit(client, key="new-key")
            assert active.status_code == 409
            assert active.json()["error"]["details"]["active_run_id"] == run_id
            for suffix in ("campaigns.csv", "report.json"):
                pending = client.get(f"/api/v1/runs/{run_id}/{suffix}")
                assert pending.status_code == 409 and pending.json()["error"]["code"] == "RUN_NOT_READY"
            # Health and reads are served while the calculation waits in a separate thread.
            assert client.get("/api/v1/health").status_code == 200
        finally:
            release.set()
        snapshot = wait_terminal(client, run_id)
        assert snapshot["status"] == "completed", snapshot["failure"]
        assert calls == [42]
        assert submit(client).status_code == 200
        csv_response = client.get(f"/api/v1/runs/{run_id}/campaigns.csv")
        assert "attachment" in csv_response.headers["content-disposition"]
        reader = csv.DictReader(io.StringIO(csv_response.text))
        assert reader.fieldnames == CAMPAIGN_COLUMNS
        assert list(reader) == [{key: "" if value is None else value for key, value in snapshot["campaigns"][0]["spec"].items()}]
        report = client.get(f"/api/v1/runs/{run_id}/report.json")
        assert report.json() == snapshot
        assert client.get("/api/v1/runs?limit=1").json()["items"][0]["id"] == run_id

    with TestClient(create_app(db_path=path, overview_provider=lambda: overview, runner=runner)) as restarted:
        assert submit(restarted).json()["id"] == run_id
        assert submit(restarted).status_code == 200
        assert restarted.get(f"/api/v1/runs/{run_id}/campaigns.csv").text == csv_response.text
        assert calls == [42]


@pytest.mark.parametrize("case", [
    {"method": "get", "path": "/api/v1/runs?limit=0"},
    {"method": "get", "path": "/api/v1/runs?limit=101"},
    {"method": "post", "path": "/api/v1/runs", "json": {"seed": 42, "risk_profile": "balanced"}},
    {"method": "post", "path": "/api/v1/runs", "json": {"seed": -1, "risk_profile": "balanced"}, "headers": {"Idempotency-Key": "x"}},
    {"method": "post", "path": "/api/v1/runs", "json": {"seed": 1.5, "risk_profile": "balanced"}, "headers": {"Idempotency-Key": "x"}},
    {"method": "post", "path": "/api/v1/runs", "json": {"seed": True, "risk_profile": "balanced"}, "headers": {"Idempotency-Key": "x"}},
    {"method": "post", "path": "/api/v1/runs", "json": {"seed": 42, "risk_profile": "bad"}, "headers": {"Idempotency-Key": "x"}},
    {"method": "post", "path": "/api/v1/runs", "json": {"seed": 42, "risk_profile": "balanced", "budget": 100}, "headers": {"Idempotency-Key": "x"}},
])
def test_uniform_validation(tmp_path, overview, case):
    with TestClient(create_app(db_path=tmp_path / "runs.db", overview_provider=lambda: overview)) as client:
        options = dict(case)
        response = client.request(options.pop("method"), options.pop("path"), **options)
        assert response.status_code == 422
        error = response.json()["error"]
        assert set(error) == {"code", "message", "details", "request_id"}
        assert error["code"] == "VALIDATION_ERROR"
        assert response.headers["X-Request-ID"] == error["request_id"]


def test_failure_preserves_progress_and_can_retry(tmp_path, overview):
    def runner(observer, **kwargs):
        partial = result()
        observer({"phase": "pilots", "pilots": partial["pilots"], "resources": partial["resources"]})
        raise RuntimeError("Deliberate adapter failure")

    with TestClient(create_app(db_path=tmp_path / "runs.db", overview_provider=lambda: overview, runner=runner)) as client:
        snapshot = wait_terminal(client, submit(client).json()["id"])
        assert snapshot["status"] == "failed" and snapshot["failure"]["code"] == "CALCULATION_FAILED"
        assert snapshot["pilots"][0]["id"] == "pilot_1"
        assert submit(client).status_code == 200
        assert submit(client, "new-key").status_code == 202
        missing = client.get("/api/v1/runs/does-not-exist")
        assert missing.status_code == 404 and missing.json()["error"]["code"] == "RUN_NOT_FOUND"


def test_restart_fails_interrupted_preserving_idempotency(tmp_path, overview):
    path = tmp_path / "runs.db"
    store = RunStore(path)
    snapshot, _ = store.create("interrupted", RunConfig(seed=42, risk_profile="balanced"), Overview.model_validate(overview))
    with TestClient(create_app(db_path=path, overview_provider=lambda: overview)) as client:
        response = submit(client, "interrupted")
        assert response.status_code == 200 and response.json()["id"] == snapshot.id
        assert response.json()["status"] == "failed"
        assert response.json()["failure"]["code"] == "SERVER_RESTARTED"


def test_atomic_registration_under_concurrent_requests(tmp_path, overview):
    store = RunStore(tmp_path / "runs.db")
    config, dataset = RunConfig(seed=42, risk_profile="balanced"), Overview.model_validate(overview)

    def create(key):
        try:
            return store.create(key, config, dataset)
        except APIError as exc:
            return exc

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(create, [f"key-{i}" for i in range(16)]))
    successes = [r for r in results if isinstance(r, tuple)]
    assert len(successes) == 1
    assert all(r.code == "RUN_ALREADY_ACTIVE" for r in results if isinstance(r, APIError))


def test_nonfinite_optional_estimate_is_null_and_invalid_completion_fails(tmp_path, overview):
    def runner(**kwargs):
        payload = result()
        payload["campaigns"][0]["expected_lift_ratio"] = float("nan")
        return payload

    with TestClient(create_app(db_path=tmp_path / "runs.db", overview_provider=lambda: overview, runner=runner)) as client:
        snapshot = wait_terminal(client, submit(client).json()["id"])
        assert snapshot["status"] == "completed"
        assert snapshot["campaigns"][0]["expected_lift_ratio"] is None
        json.dumps(snapshot, allow_nan=False)

    def invalid(**kwargs):
        payload = result()
        payload["local_evaluation"]["total_contacts"] = 15001
        return payload

    with TestClient(create_app(db_path=tmp_path / "invalid.db", overview_provider=lambda: overview, runner=invalid)) as client:
        snapshot = wait_terminal(client, submit(client).json()["id"])
        assert snapshot["status"] == "failed"
        assert "disagree" in snapshot["failure"]["message"]


def test_unexpected_http_failure_uses_error_envelope(tmp_path):
    def broken_overview():
        raise RuntimeError("Internal diagnostic")

    with TestClient(create_app(db_path=tmp_path / "runs.db", overview_provider=broken_overview),
                    raise_server_exceptions=False) as client:
        response = client.get("/api/v1/overview")
        assert response.status_code == 500
        assert response.json()["error"]["code"] == "INTERNAL_ERROR"
        assert response.json()["error"]["request_id"] == response.headers["X-Request-ID"]
        assert "Internal diagnostic" not in response.text


def test_bad_progress_payload_does_not_change_calculation(tmp_path, overview):
    def runner(observer, **kwargs):
        observer({"phase": "not-a-valid-phase", "forecast": {"invalid": True}})
        return result()

    with TestClient(create_app(db_path=tmp_path / "runs.db", overview_provider=lambda: overview, runner=runner)) as client:
        snapshot = wait_terminal(client, submit(client).json()["id"])
        assert snapshot["status"] == "completed"
        assert snapshot["forecast"]["expected_net_gain"] == 10000


def test_second_server_cannot_fail_live_run(tmp_path, overview):
    entered, release = Event(), Event()

    def runner(**kwargs):
        entered.set()
        assert release.wait(10)
        return result()

    path = tmp_path / "runs.db"
    with TestClient(create_app(db_path=path, overview_provider=lambda: overview, runner=runner)) as first:
        try:
            run_id = submit(first).json()["id"]
            assert entered.wait(2)
            with pytest.raises(RuntimeError, match="Another UniFlow server"):
                with TestClient(create_app(db_path=path, overview_provider=lambda: overview)):
                    pytest.fail("Second server unexpectedly acquired database")
            assert first.get(f"/api/v1/runs/{run_id}").json()["status"] == "running"
        finally:
            release.set()
        assert wait_terminal(first, run_id)["status"] == "completed"
    # The lifetime lock is released during graceful shutdown.
    with TestClient(create_app(db_path=path, overview_provider=lambda: overview)) as restarted:
        assert restarted.get(f"/api/v1/runs/{run_id}").json()["status"] == "completed"


def test_os_lock_released_after_process_termination(tmp_path):
    from backend.locking import ServerLock

    path = tmp_path / "locked.db"
    script = "from backend.locking import ServerLock; import sys; lock = ServerLock(sys.argv[1]).acquire(); print('ready', flush=True); sys.stdin.read()"
    options = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}
    child = subprocess.Popen([sys.executable, "-c", script, str(path)], cwd=Path(__file__).resolve().parents[2],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **options)
    try:
        assert child.stdout.readline().strip() == "ready"
        with pytest.raises(RuntimeError, match="Another UniFlow server"):
            ServerLock(path).acquire()
    finally:
        child.terminate()
        child.communicate(timeout=5)
    owner = ServerLock(path).acquire()
    owner.close()


def test_persisted_retry_does_not_require_dataset(tmp_path, overview):
    path = tmp_path / "runs.db"
    with TestClient(create_app(db_path=path, overview_provider=lambda: overview, runner=lambda **kwargs: result())) as client:
        snapshot = wait_terminal(client, submit(client).json()["id"])
        assert snapshot["status"] == "completed"

    def unavailable():
        pytest.fail("An idempotent retry must not read the input dataset")

    with TestClient(create_app(db_path=path, overview_provider=unavailable)) as client:
        assert submit(client).json() == snapshot
        assert submit(client, seed=43).status_code == 409


def test_conditional_polling_changes_only_after_snapshot_update(tmp_path, overview):
    entered, release = Event(), Event()

    def runner(**kwargs):
        entered.set()
        assert release.wait(5)
        return result()

    with TestClient(create_app(db_path=tmp_path / "runs.db", overview_provider=lambda: overview, runner=runner)) as client:
        try:
            run_id = submit(client).json()["id"]
            assert entered.wait(2)
            first = client.get(f"/api/v1/runs/{run_id}")
            etag = first.headers["etag"]
            for condition in (etag, etag.removeprefix("W/"), f'"other", {etag}', "*"):
                response = client.get(f"/api/v1/runs/{run_id}", headers={"If-None-Match": condition})
                assert response.status_code == 304 and response.content == b""
                assert response.headers["etag"] == etag
            assert client.get(f"/api/v1/runs/{run_id}", headers={"If-None-Match": '"stale"'}).status_code == 200
        finally:
            release.set()
        assert wait_terminal(client, run_id)["status"] == "completed"
        updated = client.get(f"/api/v1/runs/{run_id}", headers={"If-None-Match": etag})
        assert updated.status_code == 200 and updated.headers["etag"] != etag


def test_progress_trace_append_only_and_terminal_snapshot_immutable(tmp_path, overview):
    overview["dataset"]["notices"] = [{"code": "AUDIT", "severity": "info", "message": "Source audit", "affected_count": None}]
    steps = []

    def runner(observer, **kwargs):
        trace = [{"id": "agent-1", "sequence": 1, "created_at": utc_now(), "phase": "pilots", "title": "Pilot", "message": "Sample received"}]
        observer({"events": trace, "warnings": [], "phase": "pilots"})
        steps.append(client.get(f"/api/v1/runs/{run_id}").json())
        trace.append({"id": "agent-2", "sequence": 2, "created_at": utc_now(), "phase": "planning", "title": "Plan", "message": "Plan updated"})
        observer({"events": trace, "phase": "planning"})
        steps.append(client.get(f"/api/v1/runs/{run_id}").json())
        return {**result(), "events": trace}

    # Set the id before letting the injected worker emit its first callback.
    release = Event()

    def delayed(**kwargs):
        assert release.wait(5)
        return runner(**kwargs)

    path = tmp_path / "runs.db"
    with TestClient(create_app(db_path=path, overview_provider=lambda: overview, runner=delayed)) as client:
        run_id = submit(client).json()["id"]
        release.set()
        final = wait_terminal(client, run_id)
        assert final["status"] == "completed", final["failure"]
        assert final["events"][0]["phase"] == "queued"
        assert final["events"][-1]["phase"] == "completed"
        assert [e["sequence"] for e in final["events"]] == list(range(1, len(final["events"]) + 1))
        for partial in steps:
            assert final["events"][:len(partial["events"])] == partial["events"]
            assert partial["warnings"][0]["code"] == "AUDIT"
        store = client.app.state.store
        before, etag = store.get_versioned(run_id)
        store.fail(run_id, "STALE_FAILURE", "Late callback")
        client.app.state.worker._apply(run_id, {"phase": "pilots"}, completed=False)
        assert store.get_versioned(run_id)[1] == etag
        assert store.get(run_id) == before


def test_old_database_migration_and_projection_reads(tmp_path, overview, monkeypatch):
    source = RunStore(tmp_path / "source.db")
    snapshot, _ = source.create("old-key", RunConfig(seed=42, risk_profile="balanced"), Overview.model_validate(overview))
    source.fail(snapshot.id, "TEST", "Preserved failure")
    with source.connection() as conn:
        row = conn.execute("SELECT id, idempotency_key, config_json, created_at, status, snapshot_json FROM runs").fetchone()
    legacy_path = tmp_path / "old.db"
    with sqlite3.connect(legacy_path) as conn:
        conn.execute("CREATE TABLE runs (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL, snapshot_json TEXT NOT NULL)")
        conn.execute("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)", tuple(row))
    upgraded = RunStore(legacy_path)
    assert upgraded.get(snapshot.id) == source.get(snapshot.id)
    assert upgraded.lookup("old-key", snapshot.config) == source.get(snapshot.id)
    etag = upgraded.get_versioned(snapshot.id)[1]

    def forbidden(*args):
        pytest.fail("Summary or unchanged polling decoded a full snapshot")

    monkeypatch.setattr(upgraded, "decode", forbidden)
    assert upgraded.list(20)[0].id == snapshot.id
    assert upgraded.get_versioned(snapshot.id, etag) == (None, etag)


@pytest.mark.parametrize("mutation", [
    lambda p: p["forecast"].update(expected_net_gain=9999),
    lambda p: p["local_evaluation"].update(net_arpu_gain=9999),
    lambda p: p["local_evaluation"].update(unique_customers=111),
    lambda p: p["forecast"].update(expected_unique_reach=99),
    lambda p: p["campaigns"][0].update(supporting_pilot_ids=["unknown"]),
    lambda p: p["campaigns"][0].update(supporting_pilot_ids=[]),
    lambda p: p["forecast"].update(net_gain_interval={"low": 2, "high": 1, "level": .9, "method": "Invalid test"}),
    lambda p: p["resources"]["budget"].update(limit=100001, remaining_after_plan=100001),
])
def test_incoherent_adapter_results_are_never_published_completed(tmp_path, overview, mutation):
    def invalid(**kwargs):
        payload = result()
        mutation(payload)
        return payload

    with TestClient(create_app(db_path=tmp_path / "runs.db", overview_provider=lambda: overview, runner=invalid)) as client:
        snapshot = wait_terminal(client, submit(client).json()["id"])
        assert snapshot["status"] == "failed"
        assert snapshot["failure"]["code"] == "CALCULATION_FAILED"
        assert client.get(f'/api/v1/runs/{snapshot["id"]}/campaigns.csv').status_code == 409
