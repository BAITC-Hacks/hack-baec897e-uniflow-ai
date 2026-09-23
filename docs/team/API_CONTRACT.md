# Общий контракт двух разработчиков — OrbitDuo Campaign Studio, v1

Это действующий контракт HTTP API и frontend. Backend реализует его через FastAPI и Pydantic; frontend использует в HTTP-клиенте и демонстрационных данных. Контракт конкурсного `Agent.act(env)` остаётся отдельным и имеет приоритет над продуктовой оболочкой.

## Ответственность и интеграция

| Владелец | Файлы и результат |
|---|---|
| Разработчик 1, backend | `participant_package/agent.py`, собственные модули агента, тесты и эксперименты в `participant_package/`, `backend/`, корневой README и инструкция общего запуска |
| Разработчик 2, frontend | `frontend/`, включая HTTP-клиент, TypeScript-типы, демонстрационные данные, UI и свой README |
| Общий неизменяемый договор | `docs/team/API_CONTRACT.md`; изменение существующих полей и их смысла требует согласования двух разработчиков |

Разработчики не редактируют файлы друг друга. Конкурсные `environment.py`, `scoring_core.py`, `mock_environment.py`, `local_eval.py`, `make_submission.py`, исходный шаблон и исходные данные не изменяются. Новые обёртки и тестовые среды создаются отдельно.

Frontend: React + TypeScript + Vite. Backend: Python + FastAPI. Ядро агента не зависит от веб-сервера. Два локальных процесса: frontend на `http://localhost:5173`, backend на `http://127.0.0.1:8000`. Frontend обращается к относительному `/api/v1` через Vite proxy; разрешён явный `VITE_API_BASE_URL`.

В MVP используются polling и один вычислительный worker. WebSocket, Redis, Celery, авторизация, реальные рассылки, загрузка произвольных CSV и ручное редактирование исполняемого плана не требуются.

## Правила продукта

- Данные синтетические. Денежная единица — `у.е.`, технический код `CU`; не рубли и не тенге.
- «Прогноз дополнительной выручки за вычетом коммуникаций» — оценка агента. Это не полная прибыль, не подтверждённый доход и не сумма `predicted_arpu`.
- «Результат локальной симуляции» — результат публичного оценщика на mock-модели, отдельно от прогноза и шумных пилотных наблюдений.
- Все показатели портфеля включают пилоты, если явно не указано обратное. Контакты могут повторяться; уникальный охват — отдельный показатель.
- Лимиты конкурсного режима фиксированы: 100 000 у.е., 15 000 контактов, 20 пилотов, 1–10 финальных кампаний, до 5 000 клиентов в кампании. UI не предлагает изменять их.
- Настройки запуска: seed и риск-профиль. `balanced` — стандартный режим Agent(); `conservative` — более сильный штраф за неопределённость, с описанным влиянием на алгоритм.
- `mode: demo` означает демонстрационные данные frontend. `mode: local_simulation` означает реальный запуск кода на локальной синтетической среде. Это видимые разные режимы. Production-отправки не существует.
- Числа, счётчики, объяснения, ограничения и прогнозы предоставляет backend; frontend форматирует, фильтрует и отображает их.
- Неопределённые значения — `null`, не ноль. JSON не содержит `NaN`/`Infinity`. Время — ISO 8601 UTC. Доли передаются как ratio: `0.12` отображается как `12%`.

## HTTP API

Все пути имеют префикс `/api/v1`.

| Метод и путь | Ответ и назначение |
|---|---|
| `GET /health` | `200 {status:"ok", api_version:"1", mode:"local_simulation"}` |
| `GET /overview` | `200 Overview` — аудит, сегменты, тарифы, каналы, лимиты |
| `POST /runs` | `202 RunSnapshot` — поставить новый запуск в очередь; тело `RunConfig`, заголовок `Idempotency-Key` обязателен |
| `GET /runs?limit=20` | `200 {items: RunSummary[]}` — последние запуски, новые первыми; limit 1–100 |
| `GET /runs/{run_id}` | `200 RunSnapshot` — состояние, журнал и частичный/готовый результат |
| `GET /runs/{run_id}/campaigns.csv` | CSV финального плана именно этого завершённого запуска; `Content-Disposition: attachment` |
| `GET /runs/{run_id}/report.json` | JSON сохранённого завершённого RunSnapshot; `Content-Disposition: attachment` |

Повтор POST с тем же ключом и тем же телом возвращает исходный запуск: `202`, если он активен, иначе `200`; новый запуск не создаётся. Тот же ключ с другим телом — `409 IDEMPOTENCY_CONFLICT`. Другой ключ при занятом единственном worker — `409 RUN_ALREADY_ACTIVE` с `details.active_run_id`. Backend ограничивает конкуренцию атомарно, не только кнопкой UI. Новый осознанный запуск использует новый ключ; сетевой повтор старого запроса сохраняет ключ. Ключ, нормализованное тело и run_id сохраняются атомарно вместе с run; правило повторного запроса действует и после рестарта сервера.

Неизвестный run — `404 RUN_NOT_FOUND`; экспорт неготового результата — `409 RUN_NOT_READY`; невалидные параметры — `422 VALIDATION_ERROR`. Все ошибки, включая ошибки валидации FastAPI, имеют один формат:

```json
{
  "error": {
    "code": "RUN_NOT_READY",
    "message": "План ещё рассчитывается.",
    "details": {},
    "request_id": "server-generated-id"
  }
}
```

В обычных HTTP-ответах вычислительного запуска ошибка выполнения передаётся как `RunSnapshot.status = "failed"` и `failure`; чтение существующего failed run возвращает `200`.

## Типы данных

Ниже схема DTO, а не требование добавить TypeScript-зависимость в backend. Backend создаёт эквивалентные Pydantic-модели и OpenAPI; frontend — соответствующие типы. Необязательность допускается только там, где явно указана.

```ts
type Channel = "push" | "sms" | "digital_ads" | "call";
type RiskProfile = "balanced" | "conservative";
type RunStatus = "queued" | "running" | "completed" | "failed";
type Phase = "queued" | "audit" | "candidates" | "pilots" |
  "planning" | "evaluation" | "completed" | "failed";

interface RunConfig {
  seed: number; // целое 0..2147483647; UI по умолчанию 42
  risk_profile: RiskProfile;
}

interface Limits {
  budget: number;
  contacts: number;
  pilots: number;
  final_campaigns: number;
  customers_per_campaign: number;
  pilot_size_min: number;
  pilot_size_max: number;
}

interface Notice {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  affected_count: number | null;
}

interface Overview {
  mode: "local_simulation" | "demo";
  currency: "CU";
  dataset: {
    id: string; // устойчивый fingerprint используемых данных
    customer_count: number;
    baseline_revenue: number; // сумма predicted_arpu всей аудитории
    eligible_customer_count: number; // допущено в адресные кандидаты
    excluded_customer_count: number;
    exclusion_reason: string;
    notices: Notice[];
  };
  limits: Limits;
  channels: Array<{
    code: Channel;
    label: string;
    cost_per_contact: number;
    conversion_multiplier: number;
  }>;
  tariffs: Array<{
    code: string;
    monthly_fee: number | null;
    description: string;
  }>;
  segments: Array<{
    current_tariff: string | null;
    arpu_segment: string | null;
    customer_count: number;
    baseline_revenue: number;
    average_predicted_arpu: number;
    eligible: boolean;
  }>;
}

interface CampaignSpec {
  campaign_name: string;
  filter_arpu_segment: string | null;
  filter_data_segment: string | null;
  filter_call_segment: string | null;
  filter_current_tariff: string | null; // несколько кодов через ;
  target_tariff: string;
  channel: Channel;
}

interface EstimateInterval {
  low: number;
  high: number;
  level: number; // например 0.9; только если интервал действительно рассчитан
  method: string; // описание метода и допущений
}

interface ResourceCounter {
  limit: number;
  used_by_pilots: number;
  planned_final: number | null;
  remaining_after_plan: number | null;
}

interface Resources {
  budget: ResourceCounter;
  contacts: ResourceCounter;
  pilots_used: number;
  pilots_limit: number;
  final_campaigns_count: number;
  final_campaigns_limit: number;
}

interface PilotRecord {
  id: string;
  sequence: number;
  campaign: CampaignSpec;
  requested_customers: number;
  actual_customers: number;
  cost: number;
  observed_lift_ratio: number;
  observed_lift_total: number;
  selection_reason: string;
  decision_after: string;
  completed_at: string;
}

interface CampaignView {
  id: string;
  execution_order: number; // 1-based; сортировка UI его не меняет
  spec: CampaignSpec;
  audience_count: number; // фактическая аудитория после ограничений исполнения
  communication_cost: number;
  expected_incremental_net_gain: number | null;
  // Предельный вклад при добавлении к предыдущим кампаниям и пилотам.
  // Не суммировать с общим прогнозом или выдавать за независимый эффект.
  expected_lift_ratio: number | null;
  // ARPU-взвешенный эффект: прогноз gross этой кампании до дедупликации
  // с другими кампаниями / сумма baseline её фактической аудитории.
  // При нулевом знаменателе null; не среднее шумных ratio пилотов.
  evidence: "pilot_supported" | "prior_only" | "fallback";
  supporting_pilot_ids: string[];
  reasons: string[];
  warnings: string[];
}

interface Forecast {
  scope: "pilots_and_final";
  expected_gross_gain: number;
  expected_net_gain: number;
  net_gain_interval: EstimateInterval | null;
  expected_unique_reach: number | null;
  overlap_method: string; // неизвестное пересечение с пилотами оценивается
}

interface LocalEvaluation {
  label: "local_simulation";
  gross_gain: number;
  net_arpu_gain: number;
  communication_cost: number;
  total_contacts: number;
  unique_customers: number;
  n_pilots: number;
  n_final_campaigns: number;
  runtime_seconds: number;
}

interface DecisionEvent {
  id: string;
  sequence: number;
  created_at: string;
  phase: Phase;
  title: string;
  message: string;
  // Краткое объяснение фактического решения, не скрытая цепочка рассуждений.
}

interface RunSummary {
  id: string;
  status: RunStatus;
  phase: Phase;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  config: RunConfig;
  forecast_net_gain: number | null;
  local_net_gain: number | null;
}

interface RunSnapshot extends RunSummary {
  api_version: "1";
  mode: "local_simulation" | "demo";
  dataset_id: string;
  phase_message: string;
  resources: Resources;
  pilots: PilotRecord[];
  campaigns: CampaignView[];
  events: DecisionEvent[];
  forecast: Forecast | null;
  local_evaluation: LocalEvaluation | null;
  warnings: Notice[];
  failure: {code: string; message: string; retryable: boolean} | null;
}
```

## Семантика выполнения

`queued → running → completed | failed`. Фазы `pilots` и `planning` могут чередоваться: агент обновляет план после наблюдений. Не рисовать выдуманный процент завершения. Можно показывать фактический счётчик пилотов и прошедшее время; 20 — предел, а не план обязательно выполнить все 20.

Backend публикует согласованные snapshots после важных событий. `campaigns` до завершения могут быть пустыми или содержать текущий предварительный план; UI обозначает его как предварительный и запрещает экспорт. `forecast` остаётся `null`, пока расчёта нет. `local_evaluation` появляется только после независимой локальной оценки завершённого плана, её нет в решающем контуре агента.

`config.seed` используется фабрикой локальной среды и явно передаётся в собственный RNG агента; агент не извлекает скрытый seed из env. Стандартный `Agent()` использует собственный seed 42 и balanced-политику. При одинаковых данных UI-запуск balanced/42 и штатная генерация submission должны давать одинаковый финальный план; timestamps журналов в это сравнение не входят.

`completed` допускается только после валидации непустого плана, проверки лимитов, локальной оценки и сохранения экспортируемого результата. Если оценка/валидация не удалась, статус `failed`, доступные пилоты и журнал сохраняются. Предупреждение о низкой ожидаемой выгоде само по себе не делает технически корректный запуск failed.

Расходы пилотов берутся из публичного ответа среды. Плановые расходы — из последовательного проигрывания финальных фильтров с оставшимися ресурсами. При завершении они сверяются с оценщиком. Не вычислять остаток после финальных кампаний как `env.remaining_budget` сразу после `act`: это остаток только после пилотов.

История запусков, конфигурация, snapshots и результат хранятся в SQLite и/или локальных артефактах backend; запись snapshots атомарная. После перезапуска сервиса незавершённые задания получают `failed` с причиной `SERVER_RESTARTED`, а не остаются навсегда running. Завершённые результаты и экспорт доступны после обновления страницы и рестарта backend.

Frontend опрашивает активный run примерно раз в секунду, прекращает polling после terminal status, отменяет ненужные HTTP-запросы при смене страницы, после сетевой ошибки позволяет продолжить наблюдение того же `run_id`. Автоматически повторять создание нового run с новым ключом нельзя.

## Экспорт

`campaigns.csv` содержит только семь колонок `CampaignSpec` в порядке из `participant_package/make_submission.py`; `null` записывается пустой ячейкой. CSV строится из сохранённых кампаний указанного run, без повторного `act` и без метрик/UI-полей.

Это «План текущего запуска», не автоматически конкурсный `submission.csv`. Официальный `participant_package/submission.csv` отдельно создаётся штатным `python make_submission.py`, который запускает стандартный `Agent()` на среде с seed 42. Два запуска штатной команды должны дать одинаковые байты. Seed среды не означает право агента извлекать скрытый RNG среды.

## Совместная приёмка

1. Frontend реализует состояния `empty / running / completed / negative forecast / failed / network unavailable` на fixtures с теми же DTO и видимой меткой «Демо».
2. Backend реализует схемы и методы без переименования полей; проверяет сериализацию, ошибки, идемпотентность и сохранение результатов.
3. Выключить demo, запустить оба процесса, открыть overview, выполнить реальный локальный запуск, увидеть пилоты и результат.
4. Обновить страницу активного run и снова увидеть его; двойной клик и сетевой повтор POST не создают двойной расчёт.
5. Скачать CSV и JSON завершённого run и сверить с отображаемым планом. Прогноз и локальный результат ясно различаются.
6. Тест конкурсного `Agent.act(env)` и генерация `submission.csv` проходят независимо от frontend и FastAPI.
