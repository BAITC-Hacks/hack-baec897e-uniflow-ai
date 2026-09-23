"""Real Docker acceptance: proxy, independent submission, exports and persistence.

Run from the repository root after docker compose up -d --build --wait:
python -m scripts.verify_stack --restart
"""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import subprocess
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

from backend.models import RunSnapshot
from backend.worker import validate_completed

ROOT = Path(__file__).resolve().parents[1]


def fetch(base, path, body=None, key=None, etag=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    if etag:
        headers["If-None-Match"] = etag
    message = Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                      headers=headers)
    start = time.perf_counter()
    try:
        response = urlopen(message, timeout=15)
    except HTTPError as error:
        response = error
    with response:
        raw = response.read()
        payload = json.loads(raw) if raw and "json" in response.headers.get("Content-Type", "") else raw
        return response.status, payload, response.headers, time.perf_counter() - start


def compose(*arguments):
    return subprocess.run(["docker", "compose", *arguments], cwd=ROOT,
                          capture_output=True, text=True, encoding="utf-8", check=True, timeout=330)


def wait_ready(base):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try:
            if fetch(base, "/api/v1/health")[0] == 200:
                return
        except (OSError, URLError):
            pass  # Expected connection refusal while our container restarts.
        time.sleep(.3)
    raise TimeoutError("Docker API did not become ready in 90 seconds")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8080")
    parser.add_argument("--restart", action="store_true", help="Restart only this compose project's backend")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    wait_ready(base)
    code, page, _, _ = fetch(base, "/")
    assert code == 200 and b"OrbitDuo" in page
    code, overview, _, _ = fetch(base, "/api/v1/overview")
    assert code == 200 and overview["mode"] == "local_simulation"
    assert overview["dataset"]["eligible_customer_count"] > 0
    code, invalid, _, _ = fetch(base, "/api/v1/runs", {"seed": -1, "risk_profile": "balanced"}, uuid4().hex)
    assert code == 422 and invalid["error"]["code"] == "VALIDATION_ERROR"
    key = "docker-acceptance-" + uuid4().hex
    config = {"seed": 42, "risk_profile": "balanced"}
    # A person may be using the running UI. Respect that job instead of
    # interrupting it or mistaking the required 409 response for a defect.
    idle_deadline = time.monotonic() + 300
    busy_responses = 0
    while True:
        code, snapshot, _, post_seconds = fetch(base, "/api/v1/runs", config, key)
        if code != 409 or snapshot.get("error", {}).get("code") != "RUN_ALREADY_ACTIVE":
            break
        assert snapshot["error"]["details"].get("active_run_id")
        assert time.monotonic() < idle_deadline, "Existing user job did not finish"
        busy_responses += 1
        time.sleep(.5)
    assert code == 202, (code, snapshot)
    identifier = snapshot["id"]
    path = "/api/v1/runs/" + identifier
    code, retry, _, _ = fetch(base, "/api/v1/runs", config, key)
    assert code in (200, 202) and retry["id"] == identifier
    code, conflict, _, _ = fetch(base, "/api/v1/runs", {**config, "seed": 43}, key)
    assert code == 409 and conflict["error"]["code"] == "IDEMPOTENCY_CONFLICT"

    deadline = time.monotonic() + 300
    etag = None
    polls = 0
    while snapshot["status"] in {"queued", "running"}:
        assert time.monotonic() < deadline, "Calculation timed out"
        code, current, headers, _ = fetch(base, path, etag=etag)
        if code == 200:
            assert current["events"][:len(snapshot["events"])] == snapshot["events"]
            snapshot = current
            etag = headers.get("ETag")
        else:
            assert code == 304 and current == b""
        polls += 1
        time.sleep(.1)
    assert snapshot["status"] == "completed", snapshot.get("failure")
    validate_completed(RunSnapshot.model_validate(snapshot))
    code, unchanged, _, _ = fetch(base, path, etag=etag)
    assert code == 304 and unchanged == b""
    code, exported_csv, headers, _ = fetch(base, path + "/campaigns.csv")
    assert code == 200 and "attachment" in headers.get("Content-Disposition", "")
    rows = list(csv.DictReader(io.StringIO(exported_csv.decode("utf-8"))))
    saved_rows = [{k: "" if v is None else str(v) for k, v in item["spec"].items()}
                  for item in snapshot["campaigns"]]
    assert rows == saved_rows
    with (ROOT / "participant_package/submission.csv").open(encoding="utf-8", newline="") as source:
        local_rows = list(csv.DictReader(source))
    assert rows == local_rows, "Container and local official plans differ"
    code, exported_json, _, _ = fetch(base, path + "/report.json")
    assert code == 200 and exported_json == snapshot
    assert fetch(base, "/runs/" + identifier)[0] == 200, "SPA deep link failed"

    # Generate through the untouched organizer script in a clean Linux directory.
    # Runtime root is read-only; this independent process uses temporary storage.
    generation = """import contextlib,hashlib,io,json,os,pathlib,runpy,shutil,sys,tempfile
with tempfile.TemporaryDirectory(prefix='orbitduo-contest-') as temporary:
    shutil.copytree('/app/participant_package', temporary, dirs_exist_ok=True)
    os.chdir(temporary)
    sys.path.insert(0, temporary)
    with contextlib.redirect_stdout(io.StringIO()):
        runpy.run_path('make_submission.py', run_name='__main__')
    assert 'fastapi' not in sys.modules and 'scoring_core' not in sys.modules
    payload=pathlib.Path('submission.csv').read_bytes()
    print(json.dumps({'sha256':hashlib.sha256(payload).hexdigest(),'bytes':len(payload)}))
"""
    official = json.loads(compose("exec", "-T", "backend", "python", "-c", generation).stdout)
    csv_hash = hashlib.sha256(exported_csv).hexdigest()
    assert csv_hash == official["sha256"], "Linux API export differs from independent official generation"

    if args.restart:
        compose("restart", "backend")
        wait_ready(base)
        assert fetch(base, path)[1] == snapshot
        assert fetch(base, path, etag=etag)[0] == 304
        assert fetch(base, path + "/campaigns.csv")[1] == exported_csv
        assert fetch(base, path + "/report.json")[1] == snapshot
        code, retried, _, _ = fetch(base, "/api/v1/runs", config, key)
        assert code == 200 and retried["id"] == identifier

    containers = compose("ps", "--format", "json").stdout
    container_records = (json.loads(containers) if containers.lstrip().startswith("[") else
                         [json.loads(line) for line in containers.splitlines() if line.strip()])
    report = {
        "verified_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "base_url": base, "run_id": identifier, "config": config,
        "post_response_seconds": post_seconds, "polls": polls,
        "existing_job_busy_responses": busy_responses,
        "dataset_id": overview["dataset"]["id"], "local_evaluation": snapshot["local_evaluation"],
        "csv_sha256_linux": csv_hash, "official_linux_generation": official,
        "csv_platform_note": "CSV rows equal local Windows submission; Linux byte equality uses a fresh official generation in Linux.",
        "checks": {"real_proxy_api": True, "spa_deep_link": True, "validation_envelope": True,
                   "stable_events": True, "conditional_polling": True, "idempotency": True,
                   "saved_exports": True, "official_offline_linux_submission": True,
                   "local_and_container_campaigns_equal": True,
                   "restart_persistence": True if args.restart else None},
        "containers": container_records,
    }
    output = ROOT / "backend/reports/docker_acceptance.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"run_id": identifier, "checks": report["checks"], "csv_sha256_linux": csv_hash}))


if __name__ == "__main__":
    main()
