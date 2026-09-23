"""Run from repository root: python -m uvicorn backend.app:app --host 127.0.0.1."""
from contextlib import asynccontextmanager
import csv
from functools import lru_cache
import io
import logging
import os
from pathlib import Path
from uuid import uuid4
from typing import Annotated

from fastapi import FastAPI, Header, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException

from .models import ErrorResponse, Health, Overview, RunConfig, RunList, RunSnapshot
from .locking import ServerLock
from .storage import APIError, RunStore
from .worker import RunWorker, finite_json
from .whatif import WhatIfService
from .whatif_models import WhatIfRequest, WhatIfResult

logger = logging.getLogger(__name__)
CAMPAIGN_COLUMNS = ["campaign_name", "filter_arpu_segment", "filter_data_segment", "filter_call_segment",
                    "filter_current_tariff", "target_tariff", "channel"]


def default_overview():
    from participant_package.orbitduo.service_data import build_overview
    return build_overview()


def default_runner(**kwargs):
    from participant_package.orbitduo.evaluation import run_experiment
    return run_experiment(**kwargs)


def create_app(*, db_path: str | Path | None = None, overview_provider=None, runner=None) -> FastAPI:
    database = db_path or os.environ.get("ORBITDUO_DB_PATH") or os.environ.get("UNIFLOW_DB_PATH") or Path(__file__).parent / "data" / "runs.sqlite3"
    provider = overview_provider or default_overview
    what_if = WhatIfService()

    @lru_cache(maxsize=1)
    def overview() -> Overview:
        result = provider()
        if isinstance(result, Overview):
            return result
        return Overview.model_validate(finite_json(result))

    @asynccontextmanager
    async def lifespan(application):
        owner = ServerLock(database).acquire()
        worker = None
        try:
            store = await run_in_threadpool(RunStore, database)
            await run_in_threadpool(store.recover_interrupted)
            if overview_provider is None:
                try:
                    # Pay the CSV/import audit cost before announcing readiness,
                    # so the first POST only registers and schedules its run.
                    await run_in_threadpool(overview)
                except Exception:
                    # Persisted runs and exports remain useful if the source
                    # dataset is temporarily unavailable after a restart.
                    logger.exception("Input audit unavailable at startup; saved runs remain readable")
            worker = RunWorker(store, runner or default_runner)
            application.state.store = store
            application.state.worker = worker
            yield
        finally:
            try:
                if worker is not None:
                    await run_in_threadpool(worker.close)
            finally:
                owner.close()

    application = FastAPI(title="OrbitDuo Campaign Studio", version="1", lifespan=lifespan,
                          responses={status: {"model": ErrorResponse} for status in (404, 409, 422, 500)})

    @application.middleware("http")
    async def request_id(request: Request, call_next):
        request.state.request_id = uuid4().hex
        try:
            response = await call_next(request)
        except Exception as exc:
            # Turn unexpected application failures into the public envelope
            # inside CORS, so a browser can read the same error as an API client.
            response = await unexpected_error(request, exc)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    def error_response(request, status, code, message, details=None, headers=None):
        identifier = getattr(request.state, "request_id", uuid4().hex)
        return JSONResponse(status_code=status, content={"error": {
            "code": code, "message": message, "details": details or {}, "request_id": identifier,
        }}, headers={**(headers or {}), "X-Request-ID": identifier})

    @application.exception_handler(APIError)
    async def domain_error(request: Request, exc: APIError):
        return error_response(request, exc.status, exc.code, exc.message, exc.details)

    @application.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        issues = [{"location": list(issue["loc"]), "message": issue["msg"], "type": issue["type"]}
                  for issue in exc.errors()]
        return error_response(request, 422, "VALIDATION_ERROR", "Параметры запроса не соответствуют контракту.", {"issues": issues})

    @application.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return error_response(request, exc.status_code, "HTTP_ERROR", str(exc.detail), headers=exc.headers)

    @application.exception_handler(Exception)
    async def unexpected_error(request: Request, exc: Exception):
        logger.error("Unhandled request failure", exc_info=(type(exc), exc, exc.__traceback__))
        return error_response(request, 500, "INTERNAL_ERROR", "Внутренняя ошибка сервера.")

    @application.get("/api/v1/health", response_model=Health)
    async def health():
        return Health()

    @application.get("/api/v1/overview", response_model=Overview)
    async def get_overview():
        return await run_in_threadpool(overview)

    @application.post("/api/v1/runs", response_model=RunSnapshot, status_code=202,
                      responses={200: {"model": RunSnapshot}})
    async def create_run(request: Request, response: Response, config: RunConfig,
                         idempotency_key: Annotated[str, Header(min_length=1, max_length=200)]):
        if not idempotency_key.strip():
            raise APIError(422, "VALIDATION_ERROR", "Idempotency-Key не может быть пустым.")
        snapshot = await run_in_threadpool(request.app.state.store.lookup, idempotency_key, config)
        created = False
        if snapshot is None:
            snapshot, created = await run_in_threadpool(request.app.state.store.create, idempotency_key,
                                                        config, await run_in_threadpool(overview))
        if created:
            request.app.state.worker.submit(snapshot.id)
        response.status_code = 202 if snapshot.status in {"queued", "running"} else 200
        return snapshot

    @application.get("/api/v1/runs", response_model=RunList)
    async def list_runs(request: Request, limit: Annotated[int, Query(ge=1, le=100)] = 20):
        return RunList(items=await run_in_threadpool(request.app.state.store.list, limit))

    @application.get("/api/v1/runs/{run_id}", response_model=RunSnapshot,
                     responses={304: {"description": "Snapshot unchanged (If-None-Match)."}})
    async def get_run(request: Request, response: Response, run_id: str,
                      if_none_match: Annotated[str | None, Header()] = None):
        snapshot, etag = await run_in_threadpool(request.app.state.store.get_versioned, run_id, if_none_match)
        headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
        if snapshot is None:
            return Response(status_code=304, headers=headers)
        response.headers.update(headers)
        return snapshot

    async def completed_run(request: Request, run_id: str):
        snapshot = await run_in_threadpool(request.app.state.store.get, run_id)
        if snapshot.status != "completed":
            raise APIError(409, "RUN_NOT_READY", "Экспорт доступен после успешного завершения расчёта.")
        return snapshot

    @application.post("/api/v1/runs/{run_id}/what-if", response_model=WhatIfResult)
    async def compare_exclusions(request: Request, run_id: str, selection: WhatIfRequest):
        snapshot = await run_in_threadpool(request.app.state.store.get, run_id)
        return await run_in_threadpool(what_if.evaluate, snapshot, selection)

    @application.get("/api/v1/runs/{run_id}/campaigns.csv", response_class=Response,
                     responses={200: {"content": {"text/csv": {"schema": {"type": "string"}}}}})
    async def export_csv(request: Request, run_id: str):
        snapshot = await completed_run(request, run_id)
        output = io.StringIO(newline="")
        # Match pandas.to_csv's platform newline convention in make_submission.py.
        writer = csv.DictWriter(output, fieldnames=CAMPAIGN_COLUMNS, lineterminator=os.linesep)
        writer.writeheader()
        for campaign in snapshot.campaigns:
            writer.writerow(campaign.spec.model_dump())
        return Response(output.getvalue().encode("utf-8"), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="campaigns-{snapshot.id}.csv"'})

    @application.get("/api/v1/runs/{run_id}/report.json", response_class=Response,
                     responses={200: {"model": RunSnapshot}})
    async def export_report(request: Request, run_id: str):
        snapshot = await completed_run(request, run_id)
        return Response(snapshot.model_dump_json(indent=2), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="report-{snapshot.id}.json"'})

    # Added last: outermost user middleware also decorates generated 500
    # responses and exposes their request ids to the separate Vite origin.
    application.add_middleware(CORSMiddleware,
                               allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
                               allow_methods=["GET", "POST"], allow_headers=["Content-Type", "Idempotency-Key", "If-None-Match"],
                               expose_headers=["Content-Disposition", "X-Request-ID", "ETag"])
    return application


app = create_app()
