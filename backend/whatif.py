"""Independent local scorer; never imported by the decision-making agent.

Replay saved pilots with the original seed, verify their observations and the
complete original score, then score a subset from scratch. This recovers exact
pilot customer IDs without exposing them in snapshots or using approximate
subtraction of campaign contributions. No saved state is mutated.
"""
from dataclasses import dataclass
import hashlib
import json
import math
from threading import Lock

from .models import RunSnapshot
from .storage import APIError
from .whatif_models import WhatIfRequest, WhatIfResult, WhatIfTotals


def _mismatch():
    return APIError(409, "WHAT_IF_NOT_REPRODUCIBLE",
                    "Исходный расчёт не воспроизводится в текущей учебной среде. Создайте новый подбор и повторите проверку.")


def _close(actual, expected):
    return math.isclose(float(actual), float(expected), rel_tol=1e-10, abs_tol=1e-6)


@dataclass
class Replay:
    env: object
    pilots: list[dict]
    model: object
    fallback: object


def _replay(snapshot: RunSnapshot) -> Replay:
    import pandas as pd
    from participant_package.orbitduo.audit import PACKAGE_ROOT, sha256
    from participant_package.orbitduo.evaluation import bootstrap_package
    bootstrap_package()
    from mock_environment import make_mock_env, _mock_impact_model, _mock_fallback

    # Fresh hashes, rather than the overview cache, also detect changed files in
    # a long-running server. Match exactly the public audit fingerprint.
    paths = sorted(PACKAGE_ROOT.glob("*.csv")) + sorted((PACKAGE_ROOT / "data").glob("*.csv"))
    hashes = {path.relative_to(PACKAGE_ROOT).as_posix(): sha256(path)
              for path in paths if path.name != "submission.csv"}
    dataset_id = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()
    if snapshot.dataset_id != dataset_id:
        raise APIError(409, "WHAT_IF_DATASET_CHANGED",
                       "Исходные данные изменились. Для сопоставимой проверки создайте новый подбор.")
    env, internals = make_mock_env(seed=snapshot.config.seed, data_dir=str(PACKAGE_ROOT / "data"),
                                   profile_path=str(PACKAGE_ROOT / "customer_profile.csv"))
    if not _close(env.total_budget, snapshot.resources.budget.limit) or env.max_total_contacts != snapshot.resources.contacts.limit:
        raise _mismatch()
    for pilot in sorted(snapshot.pilots, key=lambda item: item.sequence):
        args = pilot.campaign.model_dump(exclude={"campaign_name"})
        result = env.run_pilot(**args, n_customers=pilot.requested_customers)
        for key, expected in (("n_customers", pilot.actual_customers), ("cost", pilot.cost),
                              ("observed_lift_ratio", pilot.observed_lift_ratio),
                              ("observed_lift_total", pilot.observed_lift_total)):
            if not _close(result[key], expected):
                raise _mismatch()
    return Replay(env, internals.executed_pilot_campaigns(),
                  _mock_impact_model(pd.read_csv(PACKAGE_ROOT / "data" / "change_tariff.csv")), _mock_fallback)


def _score(replay: Replay, campaigns):
    import pandas as pd
    from scoring_core import score_campaigns
    combined = pd.DataFrame(replay.pilots + [campaign.spec.model_dump() for campaign in campaigns])
    for key in ("filter_arpu_segment", "filter_data_segment", "filter_call_segment", "filter_current_tariff", "explicit_ids"):
        if key not in combined:
            combined[key] = None
    return score_campaigns(combined, replay.env.customer_profile, replay.model, replay.env.tariffs,
                           float(replay.env.customer_profile.predicted_arpu.sum()), replay.fallback,
                           team_id="orbitduo_what_if")


def _totals(score, snapshot):
    return WhatIfTotals(gross_gain=score["gross_arpu_lift"], net_gain=score["net_arpu_gain"],
                        communication_cost=score["total_cost"], total_contacts=score["total_contacts"],
                        unique_customers=score["unique_customers_targeted"],
                        remaining_budget=max(0, snapshot.resources.budget.limit - score["total_cost"]),
                        remaining_contacts=max(0, int(snapshot.resources.contacts.limit - score["total_contacts"])))


def evaluate_what_if(snapshot: RunSnapshot, request: WhatIfRequest) -> WhatIfResult:
    if snapshot.status != "completed" or snapshot.local_evaluation is None:
        raise APIError(409, "RUN_NOT_READY", "Проверка вариантов доступна после завершения подбора.")
    if snapshot.mode != "local_simulation":
        raise APIError(409, "WHAT_IF_DEMO_UNAVAILABLE", "Для этой проверки нужен расчёт в подключённой учебной среде.")
    unknown = set(request.excluded_campaign_ids) - {campaign.id for campaign in snapshot.campaigns}
    if unknown:
        raise APIError(422, "UNKNOWN_CAMPAIGN", "В этом плане нет одного из указанных предложений.")
    try:
        replay = _replay(snapshot)
        campaigns = sorted(snapshot.campaigns, key=lambda item: item.execution_order)
        original = _score(replay, campaigns)
        evaluation = snapshot.local_evaluation
        for key, expected in (("gross_arpu_lift", evaluation.gross_gain), ("net_arpu_gain", evaluation.net_arpu_gain),
                              ("total_cost", evaluation.communication_cost), ("total_contacts", evaluation.total_contacts),
                              ("unique_customers_targeted", evaluation.unique_customers)):
            if not _close(original[key], expected):
                raise _mismatch()
        original_details = original["campaigns_detail"][len(replay.pilots):]
        for campaign, detail in zip(campaigns, original_details, strict=True):
            if campaign.audience_count != detail["n_contacts"] or not _close(campaign.communication_cost, detail["cost"]):
                raise _mismatch()
        excluded = set(request.excluded_campaign_ids)
        retained = [campaign for campaign in campaigns if campaign.id not in excluded]
        alternative = _score(replay, retained) if excluded else original
    except APIError:
        raise
    except (ValueError, KeyError, TypeError, RuntimeError, OSError) as exc:
        raise _mismatch() from exc
    details = alternative["campaigns_detail"][len(replay.pilots):]
    return WhatIfResult(run_id=snapshot.id,
                        excluded_campaign_ids=[campaign.id for campaign in campaigns if campaign.id in excluded],
                        retained_campaign_ids=[campaign.id for campaign in retained],
                        original=_totals(original, snapshot), alternative=_totals(alternative, snapshot),
                        net_gain_difference=alternative["net_arpu_gain"] - original["net_arpu_gain"],
                        campaigns=[{"id": campaign.id, "audience_count": detail["n_contacts"], "communication_cost": detail["cost"]}
                                   for campaign, detail in zip(retained, details, strict=True)],
                        valid_final_plan=bool(retained) and all(detail["n_contacts"] > 0 for detail in details),
                        explanation="Учебная проверка: сохранённые пробные проверки повторены с тем же номером сценария. "
                        "Оставшиеся предложения пересчитаны в исходном порядке с лимитами бюджета и контактов; "
                        "эффект каждого человека учтён один раз по лучшему предложению. "
                        "Это результат учебной модели, а не прогноз агента или фактическая прибыль. Исходный план не изменён.")


class WhatIfService:
    """Bound expensive requests without blocking HTTP reads or building a queue."""
    def __init__(self):
        self.lock = Lock()

    def evaluate(self, snapshot, request):
        if not self.lock.acquire(blocking=False):
            raise APIError(409, "WHAT_IF_BUSY", "Другая проверка вариантов ещё выполняется. Повторите через несколько секунд.")
        try:
            return evaluate_what_if(snapshot, request)
        finally:
            self.lock.release()
