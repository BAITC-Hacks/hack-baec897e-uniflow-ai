"""Exercise an already-running local HTTP server and save a real completed run.

Run from repository root: python -m backend.smoke
"""
import argparse
import csv
import io
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000/api/v1")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--risk-profile", choices=("balanced", "conservative"), default="conservative")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "reports" / "http_smoke.json")
    args = parser.parse_args(argv)
    base = args.base_url.rstrip("/")
    key = "smoke-" + uuid4().hex

    def request(path, body=None, token=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Idempotency-Key"] = token
        req = Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            response = urlopen(req, timeout=10)
        except HTTPError as error:
            response = error
        with response:
            raw = response.read()
            value = json.loads(raw) if "json" in response.headers.get("Content-Type", "") else raw
            return response.status, value

    config = {"seed": args.seed, "risk_profile": args.risk_profile}
    start = time.perf_counter()
    code, snapshot = request("/runs", config, key)
    latency = time.perf_counter() - start
    assert code == 202, (code, snapshot)
    identifier = snapshot["id"]
    code, repeat = request("/runs", config, key)
    assert code in (200, 202) and repeat["id"] == identifier
    code, conflict = request("/runs", {**config, "seed": (args.seed + 1) % 2147483648}, key)
    assert code == 409 and conflict["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    code, busy = request("/runs", config, key + "-other")
    assert code == 409 and busy["error"]["code"] == "RUN_ALREADY_ACTIVE"
    assert request("/health")[0] == 200
    deadline = time.monotonic() + 300
    event_prefix_checks = 0
    health_latencies = []
    while snapshot["status"] in ("queued", "running") and time.monotonic() < deadline:
        time.sleep(0.5)
        previous_events = snapshot["events"]
        code, snapshot = request("/runs/" + identifier)
        assert code == 200
        assert snapshot["events"][:len(previous_events)] == previous_events
        event_prefix_checks += 1
        health_started = time.perf_counter()
        assert request("/health")[0] == 200
        health_latencies.append(time.perf_counter() - health_started)
    assert snapshot["status"] == "completed", snapshot.get("failure")
    code, output = request(f"/runs/{identifier}/campaigns.csv")
    assert code == 200
    rows = list(csv.DictReader(io.StringIO(output.decode("utf-8"))))
    assert rows == [{k: "" if v is None else str(v) for k, v in campaign["spec"].items()}
                    for campaign in snapshot["campaigns"]]
    code, exported = request(f"/runs/{identifier}/report.json")
    assert code == 200 and exported == snapshot
    code, repeated_completed = request("/runs", config, key)
    assert code == 200 and repeated_completed["id"] == identifier
    with urlopen(base + "/runs/" + identifier, timeout=10) as full:
        etag = full.headers["ETag"]
    try:
        cached = urlopen(Request(base + "/runs/" + identifier, headers={"If-None-Match": etag}), timeout=10)
    except HTTPError as error:
        cached = error
    with cached:
        assert cached.status == 304 and cached.read() == b""
    result = {"run_id": identifier, "config": config, "post_response_seconds": latency,
              "completed_snapshot": snapshot, "csv_matches_saved_plan": True,
              "idempotency_and_active_conflicts_verified": True,
              "conditional_polling_verified": True, "event_prefix_checks": event_prefix_checks,
              "maximum_health_latency_seconds": max(health_latencies, default=None)}
    report = args.output
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"run_id": identifier, "post_response_seconds": latency,
                      "local_evaluation": snapshot["local_evaluation"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
