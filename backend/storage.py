"""SQLite persistence and atomic, process-independent active-run registration."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

from .models import Overview, RunConfig, RunSnapshot, RunSummary


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class APIError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message
        self.details = details or {}


def event(phase: str, message: str, sequence: int, title: str | None = None) -> dict:
    return {"id": uuid4().hex, "sequence": sequence, "created_at": utc_now(),
            "phase": phase, "title": title or phase, "message": message}


def initial_snapshot(config: RunConfig, overview: Overview) -> RunSnapshot:
    now = utc_now()
    limits = overview.limits
    return RunSnapshot.model_validate({
        "id": uuid4().hex, "status": "queued", "phase": "queued", "created_at": now,
        "updated_at": now, "completed_at": None, "config": config.model_dump(),
        "forecast_net_gain": None, "local_net_gain": None, "api_version": "1",
        "mode": "local_simulation", "dataset_id": overview.dataset.id,
        "phase_message": "Запуск зарегистрирован и ожидает вычисления.",
        "resources": {
            "budget": {"limit": limits.budget, "used_by_pilots": 0, "planned_final": None, "remaining_after_plan": None},
            "contacts": {"limit": limits.contacts, "used_by_pilots": 0, "planned_final": None, "remaining_after_plan": None},
            "pilots_used": 0, "pilots_limit": limits.pilots,
            "final_campaigns_count": 0, "final_campaigns_limit": limits.final_campaigns,
        },
        "pilots": [], "campaigns": [], "events": [event("queued", "Задание сохранено.", 1)],
        "forecast": None, "local_evaluation": None,
        "warnings": [n.model_dump() for n in overview.dataset.notices], "failure": None,
    })


class RunStore:
    def __init__(self, path: str | Path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
                    config_json TEXT NOT NULL, created_at TEXT NOT NULL,
                    status TEXT NOT NULL, snapshot_json TEXT NOT NULL,
                    summary_json TEXT, revision INTEGER NOT NULL DEFAULT 0
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_active_run
                    ON runs ((1)) WHERE status IN ('queued', 'running');
                CREATE INDEX IF NOT EXISTS run_creation ON runs(created_at DESC);
            """)
            # Additive migration preserves existing snapshots and idempotency keys.
            columns = {row["name"] for row in conn.execute("PRAGMA table_info(runs)")}
            if "summary_json" not in columns:
                conn.execute("ALTER TABLE runs ADD COLUMN summary_json TEXT")
            if "revision" not in columns:
                conn.execute("ALTER TABLE runs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0")
            for row in conn.execute("SELECT id, snapshot_json FROM runs WHERE summary_json IS NULL").fetchall():
                conn.execute("UPDATE runs SET summary_json=? WHERE id=?",
                             (self.summary_json(self.decode(row)), row["id"]))

    @contextmanager
    def connection(self, write: bool = False):
        conn = sqlite3.connect(str(self.path), timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA busy_timeout=30000")
            if write:
                conn.execute("BEGIN IMMEDIATE")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    @staticmethod
    def decode(row) -> RunSnapshot:
        return RunSnapshot.model_validate_json(row["snapshot_json"])

    @staticmethod
    def summary_json(snapshot: RunSnapshot) -> str:
        return RunSummary.model_validate(snapshot.model_dump(include=set(RunSummary.model_fields))).model_dump_json()

    @staticmethod
    def config_json(config: RunConfig) -> str:
        return json.dumps(config.model_dump(), sort_keys=True, separators=(",", ":"))

    def lookup(self, key: str, config: RunConfig) -> RunSnapshot | None:
        """Resolve retries before opening/auditing the dataset; create rechecks atomically."""
        with self.connection() as conn:
            row = conn.execute("SELECT config_json, snapshot_json FROM runs WHERE idempotency_key=?", (key,)).fetchone()
        if row is None:
            return None
        if row["config_json"] != self.config_json(config):
            raise APIError(409, "IDEMPOTENCY_CONFLICT", "Этот ключ уже использован с другой конфигурацией.")
        return self.decode(row)

    def create(self, key: str, config: RunConfig, overview: Overview) -> tuple[RunSnapshot, bool]:
        body = self.config_json(config)
        with self.connection(write=True) as conn:
            existing = conn.execute("SELECT * FROM runs WHERE idempotency_key=?", (key,)).fetchone()
            if existing:
                if existing["config_json"] != body:
                    raise APIError(409, "IDEMPOTENCY_CONFLICT", "Этот ключ уже использован с другой конфигурацией.")
                return self.decode(existing), False
            active = conn.execute("SELECT id FROM runs WHERE status IN ('queued','running')").fetchone()
            if active:
                raise APIError(409, "RUN_ALREADY_ACTIVE", "Вычислительный worker уже занят.", {"active_run_id": active["id"]})
            snapshot = initial_snapshot(config, overview)
            conn.execute("""INSERT INTO runs
                (id, idempotency_key, config_json, created_at, status, snapshot_json, summary_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)""", (
                snapshot.id, key, body, snapshot.created_at.isoformat(), snapshot.status,
                snapshot.model_dump_json(), self.summary_json(snapshot)))
            return snapshot, True

    def get(self, run_id: str) -> RunSnapshot:
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            raise APIError(404, "RUN_NOT_FOUND", "Запуск не найден.")
        return self.decode(row)

    def list(self, limit: int) -> list[RunSummary]:
        with self.connection() as conn:
            rows = conn.execute("SELECT summary_json FROM runs ORDER BY created_at DESC, rowid DESC LIMIT ?", (limit,)).fetchall()
        return [RunSummary.model_validate_json(row["summary_json"]) for row in rows]

    def get_versioned(self, run_id: str, if_none_match: str | None = None) -> tuple[RunSnapshot | None, str]:
        """Unchanged polling reads only the revision, without parsing a large trace."""
        with self.connection() as conn:
            conn.execute("BEGIN")
            row = conn.execute("SELECT revision FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None:
                raise APIError(404, "RUN_NOT_FOUND", "Запуск не найден.")
            etag = f'W/"{run_id}-{row["revision"]}"'
            tokens = {token.strip().removeprefix("W/") for token in (if_none_match or "").split(",")}
            if "*" in tokens or etag.removeprefix("W/") in tokens:
                return None, etag
            # Same read transaction keeps the revision and snapshot consistent.
            snapshot = conn.execute("SELECT snapshot_json FROM runs WHERE id=?", (run_id,)).fetchone()
        return self.decode(snapshot), etag

    def update(self, run_id: str, transform) -> RunSnapshot:
        with self.connection(write=True) as conn:
            row = conn.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None:
                raise APIError(404, "RUN_NOT_FOUND", "Запуск не найден.")
            current = self.decode(row)
            if current.status in {"completed", "failed"}:
                return current
            updated = transform(current.model_dump(mode="json"))
            updated["updated_at"] = utc_now()
            snapshot = RunSnapshot.model_validate(updated)
            for key in ("id", "config", "created_at", "api_version", "mode", "dataset_id"):
                if getattr(snapshot, key) != getattr(current, key):
                    raise ValueError(f"Run {key} is immutable")
            if current.status == "queued" and snapshot.status not in {"queued", "running", "failed"}:
                raise ValueError("Queued run must start before completion")
            if current.status == "running" and snapshot.status == "queued":
                raise ValueError("Running run cannot return to the queue")
            for resource in ("budget", "contacts"):
                if getattr(snapshot.resources, resource).limit != getattr(current.resources, resource).limit:
                    raise ValueError("Run resource limits are immutable")
            if (snapshot.resources.pilots_limit, snapshot.resources.final_campaigns_limit) != (
                    current.resources.pilots_limit, current.resources.final_campaigns_limit):
                raise ValueError("Run campaign limits are immutable")
            conn.execute("UPDATE runs SET status=?, snapshot_json=?, summary_json=?, revision=revision+1 WHERE id=?",
                         (snapshot.status, snapshot.model_dump_json(), self.summary_json(snapshot), run_id))
            return snapshot

    def fail(self, run_id: str, code: str, message: str, retryable: bool = True):
        def change(snapshot):
            if snapshot["status"] in {"completed", "failed"}:
                return snapshot
            snapshot.update(status="failed", phase="failed", completed_at=utc_now(), phase_message=message,
                            failure={"code": code, "message": message, "retryable": retryable})
            snapshot["events"].append(event("failed", message, len(snapshot["events"]) + 1, code))
            return snapshot
        return self.update(run_id, change)

    def recover_interrupted(self):
        # Lifespan startup precedes accepting requests; only one server process is supported.
        with self.connection() as conn:
            ids = [row[0] for row in conn.execute("SELECT id FROM runs WHERE status IN ('queued','running')")]
        for run_id in ids:
            self.fail(run_id, "SERVER_RESTARTED", "Сервер был перезапущен до завершения расчёта.")
