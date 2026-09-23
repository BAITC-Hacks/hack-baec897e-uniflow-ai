"""Реальная HTTP-проверка финальной сдачи, перезапуска и сохранённого экспорта.

Из корня репозитория: python -m backend.final_smoke
Создаёт отдельный сервер, временную SQLite-базу и отчёт с SHA-256 исходников.
"""
import argparse
from contextlib import contextmanager
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4

from .models import RunSnapshot
from .worker import validate_completed

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fingerprints():
    package = ROOT / "participant_package"
    sources = list((ROOT / "backend").glob("*.py")) + list(package.glob("*.py")) + list((package / "uniflow").glob("*.py"))
    inputs = [path for path in package.glob("*.csv") if path.name != "submission.csv"] + list((package / "data").glob("*.csv"))
    return {
        label: {path.relative_to(ROOT).as_posix(): digest(path) for path in sorted(paths)}
        for label, paths in (("source_sha256", sources), ("input_sha256", inputs))
    }


def request(base, path, body=None, key=None, etag=None):
    headers = {"Content-Type": "application/json"}
    if key is not None:
        headers["Idempotency-Key"] = key
    if etag is not None:
        headers["If-None-Match"] = etag
    message = Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    started = time.perf_counter()
    try:
        response = urlopen(message, timeout=10)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        parsed = json.loads(raw) if raw and "json" in response.headers.get("Content-Type", "") else raw
        return response.status, parsed, dict(response.headers), time.perf_counter() - started


@contextmanager
def server(database):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base = f"http://127.0.0.1:{port}/api/v1"
    environment = dict(os.environ, UNIFLOW_DB_PATH=str(database))
    started = time.perf_counter()
    process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("HTTP server exited: " + process.communicate(timeout=5)[0])
            try:
                if request(base, "/health")[0] == 200:
                    break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError("HTTP server did not become ready")
        yield base, time.perf_counter() - started
    finally:
        if process.poll() is None:
            process.terminate()
        # Also wait for pipe EOF: on Windows a venv launcher may have a child.
        # This prevents temporary database cleanup racing an inherited handle.
        process.communicate(timeout=15)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "backend" / "reports" / "http_final_smoke.json")
    args = parser.parse_args(argv)
    expected_csv = (ROOT / "participant_package" / "submission.csv").read_bytes()
    submission_sha = hashlib.sha256(expected_csv).hexdigest()
    sources = fingerprints()
    config = {"seed": 42, "risk_profile": "balanced"}
    key = "final-http-" + uuid4().hex
    health_latencies, poll_latencies = [], []
    unchanged_polls, prefix_checks = 0, 0

    with TemporaryDirectory(prefix="uniflow-final-http-") as directory:
        database = Path(directory).resolve() / "runs.sqlite3"
        with server(database) as (base, startup_seconds):
            status, snapshot, _, post_seconds = request(base, "/runs", config, key)
            assert status == 202, (status, snapshot)
            run_id = snapshot["id"]
            path = "/runs/" + run_id
            status, repeated, _, _ = request(base, "/runs", config, key)
            assert status in (200, 202) and repeated["id"] == run_id
            status, conflict, _, _ = request(base, "/runs", {**config, "seed": 43}, key)
            assert status == 409 and conflict["error"]["code"] == "IDEMPOTENCY_CONFLICT"
            status, busy, _, _ = request(base, "/runs", config, key + "-other")
            assert status == 409 and busy["error"]["code"] == "RUN_ALREADY_ACTIVE"
            assert busy["error"]["details"]["active_run_id"] == run_id
            etag = None
            deadline = time.monotonic() + 300
            while snapshot["status"] in {"queued", "running"} and time.monotonic() < deadline:
                code, current, headers, elapsed = request(base, path, etag=etag)
                poll_latencies.append(elapsed)
                if code == 304:
                    assert current == b""
                    unchanged_polls += 1
                else:
                    assert code == 200, (code, current)
                    previous = snapshot["events"]
                    assert current["events"][:len(previous)] == previous
                    snapshot = current
                    etag = next(value for name, value in headers.items() if name.lower() == "etag")
                    prefix_checks += 1
                code, _, _, health_seconds = request(base, "/health")
                assert code == 200
                health_latencies.append(health_seconds)
                if snapshot["status"] in {"queued", "running"}:
                    time.sleep(.1)
            assert snapshot["status"] == "completed", snapshot.get("failure")
            validate_completed(RunSnapshot.model_validate(snapshot))
            code, exported_csv, _, _ = request(base, path + "/campaigns.csv")
            assert code == 200 and exported_csv == expected_csv, "HTTP CSV differs from the official submission bytes"
            rows = list(csv.DictReader(io.StringIO(exported_csv.decode("utf-8"))))
            assert rows == [{name: "" if value is None else str(value) for name, value in campaign["spec"].items()}
                            for campaign in snapshot["campaigns"]]
            code, report, _, _ = request(base, path + "/report.json")
            assert code == 200 and report == snapshot
            code, cached, _, _ = request(base, path, etag=etag)
            assert code == 304 and cached == b""
            code, completed_repeat, _, _ = request(base, "/runs", config, key)
            assert code == 200 and completed_repeat == snapshot

        # Restart a separate OS process against the same temporary database.
        with server(database) as (base, restart_seconds):
            code, recovered, _, retry_seconds = request(base, "/runs", config, key)
            assert code == 200 and recovered == snapshot
            code, conflict, _, _ = request(base, "/runs", {**config, "seed": 43}, key)
            assert code == 409 and conflict["error"]["code"] == "IDEMPOTENCY_CONFLICT"
            code, cached, _, _ = request(base, path, etag=etag)
            assert code == 304 and cached == b"", "ETag changed after restart without a snapshot change"
            code, restarted_csv, _, _ = request(base, path + "/campaigns.csv")
            assert code == 200 and restarted_csv == expected_csv
            code, recovered_report, _, _ = request(base, path + "/report.json")
            assert code == 200 and recovered_report == snapshot
            code, listed, _, _ = request(base, "/runs?limit=100")
            assert code == 200 and [item["id"] for item in listed["items"]] == [run_id]

    assert fingerprints() == sources, "Sources or input files changed during verification"
    assert digest(ROOT / "participant_package" / "submission.csv") == submission_sha
    report = {
        "verified_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "python": platform.python_version(), "platform": platform.system(), "config": config,
        "run_id": run_id, "submission_sha256": submission_sha, "submission_bytes": len(expected_csv),
        **sources,
        "checks": {"csv_matches_official_submission_bytes": True, "csv_matches_saved_plan": True,
                   "report_matches_saved_snapshot": True, "idempotency_and_active_conflicts": True,
                   "restart_preserves_snapshot_export_and_idempotency": True,
                   "conditional_polling_before_and_after_restart": True,
                   "single_saved_run_after_restart": True, "sources_unchanged_during_check": True},
        "metrics": {"startup_seconds": startup_seconds, "restart_seconds": restart_seconds,
                    "post_response_seconds": post_seconds, "persisted_retry_seconds": retry_seconds,
                    "maximum_health_latency_seconds": max(health_latencies),
                    "maximum_poll_latency_seconds": max(poll_latencies),
                    "event_prefix_checks": prefix_checks, "unchanged_polls": unchanged_polls},
        "completed_snapshot": snapshot,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"submission_sha256": submission_sha, "checks": report["checks"],
                      "metrics": report["metrics"], "local_evaluation": snapshot["local_evaluation"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
