"""One local worker, with durable snapshots and independent evaluation adapter."""
from concurrent.futures import ThreadPoolExecutor
import logging
import math

from .models import RunSnapshot
from .storage import RunStore, event, utc_now

logger = logging.getLogger(__name__)
RESULT_FIELDS = {"resources", "pilots", "campaigns", "forecast", "local_evaluation"}


def finite_json(value):
    """Optional unavailable estimates serialize as null, never JSON NaN/Infinity."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: finite_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [finite_json(v) for v in value]
    return value


def validate_completed(snapshot: RunSnapshot):
    """The adapter validates against scorer; also enforce coherent public totals."""
    resources, evaluation = snapshot.resources, snapshot.local_evaluation
    if evaluation is None or snapshot.forecast is None:
        raise ValueError("Completed calculation needs both forecast and local evaluation")
    if not 1 <= len(snapshot.campaigns) <= resources.final_campaigns_limit:
        raise ValueError("Completed plan must contain 1–10 campaigns")
    if not 1 <= len(snapshot.pilots) <= resources.pilots_limit:
        raise ValueError("Completed plan requires successful pilots")
    if any(c.audience_count <= 0 or c.audience_count > 5000 for c in snapshot.campaigns):
        raise ValueError("Campaign audience outside allowed bounds")
    if [c.execution_order for c in snapshot.campaigns] != list(range(1, len(snapshot.campaigns) + 1)):
        raise ValueError("Campaign execution order must be contiguous")
    if len(snapshot.campaigns) != evaluation.n_final_campaigns or len(snapshot.pilots) != evaluation.n_pilots:
        raise ValueError("Scorer campaign counters disagree with saved plan")
    if resources.final_campaigns_count != len(snapshot.campaigns) or resources.pilots_used != len(snapshot.pilots):
        raise ValueError("Resource counters disagree with saved records")
    for counter, actual in ((resources.budget, evaluation.communication_cost),
                            (resources.contacts, evaluation.total_contacts)):
        if counter.planned_final is None or counter.remaining_after_plan is None:
            raise ValueError("Completed plan lacks resource accounting")
        total = counter.used_by_pilots + counter.planned_final
        if min(counter.used_by_pilots, counter.planned_final, counter.remaining_after_plan) < -1e-6:
            raise ValueError("Negative resource counter")
        if total > counter.limit + 1e-6 or abs(total - actual) > 1e-6:
            raise ValueError("Scorer resources disagree with planned resources")
        if abs(counter.limit - total - counter.remaining_after_plan) > 1e-6:
            raise ValueError("Incorrect remaining resources")
    pilot_contacts = sum(p.actual_customers for p in snapshot.pilots)
    pilot_cost = sum(p.cost for p in snapshot.pilots)
    if any(not 10 <= p.requested_customers <= 200 or not 1 <= p.actual_customers <= p.requested_customers
           for p in snapshot.pilots):
        raise ValueError("Pilot sample sizes outside allowed bounds")
    if abs(pilot_contacts - resources.contacts.used_by_pilots) > 1e-6 or abs(pilot_cost - resources.budget.used_by_pilots) > 1e-6:
        raise ValueError("Pilot resource totals disagree with records")
    if abs(sum(c.audience_count for c in snapshot.campaigns) - resources.contacts.planned_final) > 1e-6:
        raise ValueError("Final audience totals disagree with resources")
    if abs(sum(c.communication_cost for c in snapshot.campaigns) - resources.budget.planned_final) > 1e-6:
        raise ValueError("Final costs disagree with resources")
    if abs(evaluation.gross_gain - evaluation.communication_cost - evaluation.net_arpu_gain) > 1e-6:
        raise ValueError("Scorer gross, cost and net accounting disagree")
    if abs(snapshot.forecast.expected_gross_gain - evaluation.communication_cost - snapshot.forecast.expected_net_gain) > 1e-6:
        raise ValueError("Forecast gross, cost and net accounting disagree")
    maximum_audience = max([p.actual_customers for p in snapshot.pilots] + [c.audience_count for c in snapshot.campaigns])
    if not maximum_audience <= evaluation.unique_customers <= evaluation.total_contacts:
        raise ValueError("Scorer unique reach outside feasible contact bounds")
    reach = snapshot.forecast.expected_unique_reach
    if reach is not None and not maximum_audience - 1e-6 <= reach <= evaluation.total_contacts + 1e-6:
        raise ValueError("Forecast unique reach outside feasible contact bounds")
    for records in (snapshot.pilots, snapshot.campaigns, snapshot.events):
        if len({record.id for record in records}) != len(records):
            raise ValueError("Duplicate record ids")
    if [p.sequence for p in snapshot.pilots] != list(range(1, len(snapshot.pilots) + 1)):
        raise ValueError("Pilot sequence must be contiguous")
    pilot_ids = {p.id for p in snapshot.pilots}
    for campaign in snapshot.campaigns:
        if not set(campaign.supporting_pilot_ids) <= pilot_ids:
            raise ValueError("Campaign refers to an unknown pilot")
        if campaign.evidence == "pilot_supported" and not campaign.supporting_pilot_ids:
            raise ValueError("Pilot-supported campaign needs supporting pilot ids")


class RunWorker:
    def __init__(self, store: RunStore, runner):
        self.store, self.runner = store, runner
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="orbitduo-worker")

    def submit(self, run_id: str):
        try:
            self.executor.submit(self._execute, run_id)
        except Exception:
            logger.exception("Cannot submit run %s", run_id)
            self.store.fail(run_id, "WORKER_UNAVAILABLE", "Не удалось запустить вычислительный worker.")
            raise

    def close(self):
        self.executor.shutdown(wait=True, cancel_futures=False)

    def _execute(self, run_id: str):
        try:
            def start(snapshot):
                snapshot.update(status="running", phase="audit", phase_message="Проверка данных и построение стратегии.")
                snapshot["events"].append(event("audit", snapshot["phase_message"], len(snapshot["events"]) + 1))
                return snapshot
            snapshot = self.store.update(run_id, start)
            if snapshot.status != "running":
                return

            def observe(patch):
                # A progress failure cannot alter the agent's computation.
                try:
                    self._apply(run_id, patch, completed=False)
                except Exception:
                    logger.exception("Cannot publish progress for run %s", run_id)

            result = self.runner(seed=snapshot.config.seed, risk_profile=snapshot.config.risk_profile, observer=observe)
            self._apply(run_id, result, completed=True)
        except Exception as exc:
            logger.exception("Calculation failed for run %s", run_id)
            # Exception details are local scientific-computation diagnostics, not customer data.
            self.store.fail(run_id, "CALCULATION_FAILED", f"Расчёт не завершён: {type(exc).__name__}: {exc}")

    def _apply(self, run_id: str, patch: dict, completed: bool):
        patch = finite_json(patch)

        def change(snapshot):
            if snapshot["status"] in {"completed", "failed"}:
                return snapshot
            for key in RESULT_FIELDS:
                if key in patch:
                    snapshot[key] = patch[key]
            if "warnings" in patch:
                notices = {item["code"]: item for item in snapshot["warnings"]}
                notices.update({item["code"]: item for item in patch["warnings"]})
                snapshot["warnings"] = list(notices.values())
            # Agent callbacks contain a cumulative trace. Preserve server events,
            # stable ids and already-published sequence numbers across polling.
            known_ids = {item["id"] for item in snapshot["events"]}
            appended = False
            for item in patch.get("events", []):
                if item["id"] not in known_ids:
                    snapshot["events"].append({**item, "sequence": len(snapshot["events"]) + 1})
                    known_ids.add(item["id"])
                    appended = True
            if not appended and "phase" in patch and (
                    patch["phase"] != snapshot["phase"] or patch.get("phase_message", snapshot["phase_message"]) != snapshot["phase_message"]):
                snapshot["events"].append(event(patch["phase"], patch.get("phase_message", patch["phase"]),
                                                len(snapshot["events"]) + 1))
            if "phase" in patch:
                snapshot["phase"] = patch["phase"]
            if "phase_message" in patch:
                snapshot["phase_message"] = patch["phase_message"]
            snapshot["forecast_net_gain"] = snapshot["forecast"]["expected_net_gain"] if snapshot["forecast"] else None
            snapshot["local_net_gain"] = snapshot["local_evaluation"]["net_arpu_gain"] if snapshot["local_evaluation"] else None
            if completed:
                snapshot.update(status="completed", phase="completed", completed_at=utc_now(),
                                phase_message="План проверен, локальная оценка и экспорт сохранены.")
                snapshot["events"].append(event("completed", snapshot["phase_message"], len(snapshot["events"]) + 1))
                validate_completed(RunSnapshot.model_validate(snapshot))
            return snapshot
        return self.store.update(run_id, change)
