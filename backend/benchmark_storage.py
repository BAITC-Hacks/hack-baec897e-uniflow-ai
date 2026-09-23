"""Reproducible storage microbenchmark using a real, saved completed snapshot.

Run from repository root: python -m backend.benchmark_storage
Creates only a temporary database; never mutates the server's saved runs.
"""
import argparse
import json
from pathlib import Path
import platform
from statistics import median
from tempfile import TemporaryDirectory
from time import perf_counter

from .models import RunSnapshot, RunSummary
from .storage import RunStore


def timed(operation, repetitions=9):
    samples = []
    for _ in range(repetitions):
        started = perf_counter()
        operation()
        samples.append((perf_counter() - started) * 1000)
    return median(samples)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--snapshot", type=Path, default=Path(__file__).parent / "reports" / "http_smoke.json")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "reports" / "storage_benchmark.json")
    args = parser.parse_args()
    source = json.loads(args.snapshot.read_text(encoding="utf-8"))
    snapshot = RunSnapshot.model_validate(source.get("completed_snapshot", source))
    if snapshot.status not in {"completed", "failed"}:
        raise ValueError("Benchmark needs a saved terminal snapshot")

    with TemporaryDirectory(prefix="uniflow-storage-") as directory:
        store = RunStore(Path(directory) / "benchmark.db")
        with store.connection(write=True) as conn:
            for index in range(100):
                copy = snapshot.model_copy(update={"id": f"benchmark-{index:03d}"})
                conn.execute("""INSERT INTO runs (id, idempotency_key, config_json, created_at, status, snapshot_json, summary_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)""", (copy.id, copy.id, store.config_json(copy.config),
                    copy.created_at.isoformat(), copy.status, copy.model_dump_json(), store.summary_json(copy)))

        def previous_list():
            with store.connection() as conn:
                rows = conn.execute("SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 100").fetchall()
            return [RunSummary.model_validate({k: v for k, v in store.decode(row).model_dump().items()
                                              if k in RunSummary.model_fields}) for row in rows]

        assert previous_list() == store.list(100)
        run_id = "benchmark-000"
        etag = store.get_versioned(run_id)[1]
        before = timed(previous_list)
        after = timed(lambda: store.list(100))
        polling_before = timed(lambda: store.get(run_id))
        polling_after = timed(lambda: store.get_versioned(run_id, etag))
        output = {
            "python": platform.python_version(), "platform": platform.system(),
            "method": "median of 9 warm local reads; 100 copies of a real saved snapshot in a temporary SQLite database",
            "runs": 100, "snapshot_bytes": len(snapshot.model_dump_json().encode()),
            "summary_bytes": len(store.summary_json(snapshot).encode()),
            "list_100_previous_ms": before, "list_100_projection_ms": after,
            "list_speedup": before / after,
            "polling_full_snapshot_ms": polling_before, "polling_unchanged_revision_ms": polling_after,
            "polling_speedup": polling_before / polling_after,
            "same_summary_values": True,
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
