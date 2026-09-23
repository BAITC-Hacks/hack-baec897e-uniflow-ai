# Проверяемая приёмка OrbitDuo

Документ связывает требования с кодом и проверками. Источник требований —
[API-контракт](team/API_CONTRACT.md),
[задание backend](team/BACKEND_PROMPT.md) и публичный контракт организатора.
Наличие теста само по себе не означает успешного прогона: фактические результаты
и границы проверки указаны отдельно.

В Windows пройдены **66 тестов ядра и 36 тестов backend**. В Linux-контейнере
те же **102 теста прошли за 14,73 с**, включая настоящий агент, официальную
локальную оценку, сохранение и экспорт. Frontend прошёл сборку, lint,
**10 unit-тестов, 7 demo E2E и 1 live E2E** через контейнерный API;
результаты и проверенные версии сохранены в
[отчёте frontend](../frontend/reports/acceptance.json).

[Docker-приёмка](../backend/reports/docker_acceptance.json) подтвердила все
**10 проверок**, включая сохранность результата после рестарта и побайтное
совпадение API CSV с независимой официальной генерацией в Linux.
В этом прогоне POST ответил за **0,034 с**, локальный расчёт занял **5,063 с**.
Это измерения конкретного запуска, а не гарантированная задержка.
Схема компонентов и границы доступа к оценщику описаны в
[ARCHITECTURE.md](ARCHITECTURE.md).

## Матрица требований

В таблице пути к тестам указаны относительно корня репозитория. Команды полного
запуска приведены ниже; отдельную проверку можно выбрать через `pytest -k имя`.

| Требование | Реализация | Проверка или артефакт |
|---|---|---|
| `Agent().act(env)` работает без API; финальный результат содержит только допустимые поля | [agent.py](../participant_package/agent.py), [agent_core.py](../participant_package/orbitduo/agent_core.py), независимые модули `orbitduo/` | `participant_package/tests/test_agent_contract.py::test_default_entry_point_reports_legal_plan_and_uses_pilot`; `experiments.verify_delivery` запускает сдачу в отдельном каталоге без backend |
| Агент не обращается к скрытой модели и оценщику | Только публичный `env` в решающем контуре; [evaluation.py](../participant_package/orbitduo/evaluation.py) изолирует организаторский harness | `test_decision_modules_do_not_import_evaluator_or_hidden_state`; `reports/delivery_verification.json` проверяет отсутствие импортов FastAPI и scoring_core при штатной генерации |
| Организаторские скрипты, исходные CSV и метрики сохранены | Проверка файлов относительно Git HEAD; собственные адаптеры находятся отдельно | [verify_delivery.py](../participant_package/experiments/verify_delivery.py), [delivery_verification.json](../participant_package/reports/delivery_verification.json) |
| Аудит ID, пропусков, сегментов, тарифов и baseline; история не соединяется с целевой аудиторией без проверки | [audit.py](../participant_package/orbitduo/audit.py), [service_data.py](../participant_package/orbitduo/service_data.py) | `test_audit_counts_exclusions_and_history_overlap`; [data_audit.json](../participant_package/reports/data_audit.json): 23 441 клиент, 21 тариф, пересечение ID истории и целевой аудитории — 0 |
| Непригодные строки исключаются из адресных кандидатов с объяснением; исходные данные не удаляются | [candidates.py](../participant_package/orbitduo/candidates.py); причины и охват доступны в `/overview` | `test_candidate_exclusion_and_optional_nulls_preserve_source_rows`, `test_filters_missing_optional_values_and_empty_audience`; аудит содержит 100 исключённых строк |
| 1–10 непустых финальных кампаний; до 5 000 клиентов на кампанию; сортировка ID | Публичный replay и проверка итогового плана в [portfolio.py](../participant_package/orbitduo/portfolio.py); независимая сверка с оценщиком | `test_5001_sorted_ids_and_repeated_filter_is_not_pagination`, `test_replay_matches_official_sorting_caps_and_resources`; `python -m orbitduo.evaluation` |
| Бюджет до 100 000 CU и до 15 000 контактов включают пилоты и повторы | Ресурсный replay; агент перечитывает остатки среды; backend проверяет согласованность каждого счётчика | `test_replay_includes_pilot_resource_consumption`, `test_budget_exhausted_call_and_free_push_still_contacts`, `test_optimizer_and_replay_obey_remaining_resources`; `backend/worker.py::validate_completed` |
| Каждый контакт оплачивается; бесплатный push расходует контакты; повтор фильтра не создаёт следующую страницу | Последовательное исполнение по правилам среды и предельный эффект с пересечениями | `test_pilot_contact_is_scored_before_final_and_every_contact_is_paid`, `test_contacts_exhausted_and_negative_push_is_not_safe`, `test_duplicate_contact_adds_only_communication_cost` |
| Для контактированного клиента сохраняется лучший отрицательный эффект; лучший эффект может принадлежать не последней кампании | Явное различение неконтактированного клиента и отрицательного эффекта в расчёте портфеля | `test_negative_max_stays_negative_and_best_need_not_be_last`, `test_negative_first_contact_and_better_earlier_contact_remain_in_forecast` |
| Не менее одного успешного пилота; запрос 10–200; posterior использует фактический размер | Публичный ответ среды сохраняется вместе с запросом; [posterior.py](../participant_package/orbitduo/posterior.py) использует `n_actual` | `test_pilot_actual_size_less_than_requested_and_history_hides_ids`, `test_actual_n_controls_uncertainty_and_unsaturated_transfer`, `test_repeated_observation_precision_uses_actual_sample_and_shared_effect` |
| Разные ответы пилота меняют решение; ошибка наблюдаемости не влияет на стратегию | Observer передаёт факты и перехватывает ошибки отдельно от расчёта; posterior создаётся заново при каждом `act` | `test_different_pilot_answers_change_decision`, `test_observer_failure_does_not_change_decision`, `test_reusing_agent_does_not_retain_posterior_between_acts` |
| Звонки учитывают насыщение; эффект нельзя всегда линейно перенести из push | Отдельное свидетельство для насыщаемых каналов | `test_call_saturation_prevents_linear_push_extrapolation`, `test_call_requires_independent_evidence_and_general_multiplier_check`, `test_global_calibration_preserves_independent_saturated_evidence` |
| При отрицательных оценках остаётся допустимый непустой план с предупреждением | Fallback выбирается по той же риск-цели; сохраняется резерв контактов | `test_all_negative_posterior_produces_nonempty_marked_fallback`, `test_positive_mean_negative_risk_bound_fallback_limits_estimated_harm`, `test_pilots_reserve_nonempty_final_plan_with_low_contact_balance` |
| Ограничение времени и воспроизводимость | Ограниченные циклы, локальный RNG, стабильный порядок; прекращение разведки после 270 с оставляет резерв до внутренней цели 5 минут | Runtime в [benchmark.csv](../participant_package/reports/benchmark.csv); повтор `make_submission.py` и чистая копия; аварийный таймер не является гарантией на произвольном оборудовании |
| Все маршруты и DTO общего API; UTC, единый JSON ошибок, отсутствие NaN/Infinity | [models.py](../backend/models.py), [app.py](../backend/app.py); OpenAPI `/openapi.json` | `test_health_real_overview_and_openapi`, `test_uniform_validation`, `test_nonfinite_optional_estimate_is_null_and_invalid_completion_fails`, `test_unexpected_http_failure_uses_error_envelope`, `test_http_method_error_preserves_allow_header` |
| Один worker; POST быстро регистрирует расчёт; HTTP доступен во время вычисления | Выделенный поток [worker.py](../backend/worker.py); SQLite атомарно регистрирует единственный активный run | `test_atomic_registration_under_concurrent_requests`, `test_active_idempotency_exports_and_persistence`; настоящий TCP-прогон `python -m backend.final_smoke` |
| Идемпотентность переживает конкурирующие запросы, ошибки worker и перезапуск | Уникальный ключ и нормализованная конфигурация сохраняются в той же транзакции, что и запуск | `test_concurrent_http_retries_execute_only_once`, `test_submit_failure_releases_active_slot_and_preserves_idempotency`, `test_persisted_retry_does_not_require_dataset` |
| Второй сервер не портит живой запуск; аварийный и штатный рестарт обработаны | ОС-блокировка [locking.py](../backend/locking.py); незавершённые записи после аварии получают `SERVER_RESTARTED`; штатное выключение ждёт worker | `test_second_server_cannot_fail_live_run`, `test_os_lock_released_after_process_termination`, `test_restart_fails_interrupted_preserving_idempotency`, `test_graceful_shutdown_keeps_database_lock_until_run_finishes` |
| Наблюдения, прогноз и оценка локального harness различаются | `pilots`, `forecast`, `local_evaluation` — разные DTO; нерассчитанный интервал равен `null`; финальные итоги дополнительно проверяются | `test_incoherent_adapter_results_are_never_published_completed`, `test_real_local_run_and_export`; [описание метода](../participant_package/docs/approach.md) |
| Polling сохраняет события; CSV и JSON относятся к выбранному сохранённому run | Стабильные ID событий, ETag/304, неизменяемые terminal snapshots; экспорт не вызывает `make_submission.py` | `test_progress_trace_append_only_and_terminal_snapshot_immutable`, `test_conditional_polling_changes_only_after_snapshot_update`, `test_active_idempotency_exports_and_persistence`; [http_final_smoke.json](../backend/reports/http_final_smoke.json) |
| UI подключается к настоящему API; браузерный экспорт совпадает с API | [клиент](../frontend/src/lib/api/client.ts), явное разделение live/demo; [live-тест](../frontend/tests/live/api-flow.spec.ts) создаёт run, перезагружает страницу, открывает кампанию и скачивает CSV/JSON | `npm run test:e2e:live` из `frontend/` — **пройдено**; сборка, lint, 10 unit, 7 demo E2E и 1 live E2E подтверждены [отчётом frontend](../frontend/reports/acceptance.json) |
| Docker запускает frontend и backend, сохраняет SQLite между перезапусками | [compose.yaml](../compose.yaml), Dockerfiles, nginx `/api/` proxy, именованный том `orbitduo-data`, `ORBITDUO_DB_PATH=/data/runs.sqlite3` | `docker compose up -d --build --wait`, `python -m scripts.verify_stack --restart` — **пройдено**, все 10 проверок успешны; [docker_acceptance.json](../backend/reports/docker_acceptance.json), включая сохранность после рестарта и совпадение байтов официального Linux CSV |
| Качество подтверждается измерениями, включая ухудшения и ablation | Сравнение с исходным шаблоном и замороженной v1; отдельные сценарии меняют истинные эффекты | [improvement_report.md](../participant_package/reports/improvement_report.md), [benchmark.csv](../participant_package/reports/benchmark.csv), [ablation.csv](../participant_package/reports/ablation.csv), [каталог отчётов](../participant_package/reports/README.md) |

## Команды повторной проверки

PowerShell, установленное окружение из корневого README:

```powershell
$env:PYTHONUTF8 = '1'
.\.venv\Scripts\python.exe -m pytest participant_package/tests backend/tests -q
.\.venv\Scripts\python.exe -m backend.final_smoke
```

Официальные скрипты читают файлы относительно рабочего каталога, поэтому для
конкурсной проверки нужен переход в `participant_package/`:

```powershell
Set-Location participant_package
..\.venv\Scripts\python.exe local_eval.py
..\.venv\Scripts\python.exe local_eval.py --runs 10
..\.venv\Scripts\python.exe make_submission.py
$firstHash = (Get-FileHash -LiteralPath submission.csv -Algorithm SHA256).Hash
..\.venv\Scripts\python.exe make_submission.py
if ((Get-FileHash -LiteralPath submission.csv -Algorithm SHA256).Hash -ne $firstHash) {
    throw 'Повторная генерация submission.csv не совпала'
}
..\.venv\Scripts\python.exe -m orbitduo.evaluation
..\.venv\Scripts\python.exe -m experiments.verify_delivery
Set-Location ..
```

`local_eval.py` может перехватить ошибку агента, поэтому для приёмки нужны также
строгий adapter, смысловые тесты и проверка фактических финальных кампаний.

Проверка стека создаёт настоящий новый локальный run; `--restart` перезапускает
backend данного Compose-проекта и проверяет сохранность результата:

```powershell
docker compose up -d --build --wait
.\.venv\Scripts\python.exe -m scripts.verify_stack --restart
Set-Location frontend
$env:ORBITDUO_BASE_URL = 'http://127.0.0.1:8080'
npm run build
npm run lint
npm run test
npm run test:e2e
npm run test:e2e:live
```

Для Playwright нужен установленный Chromium либо настроенный канал локального
Chrome/Edge; подробности в [frontend/README.md](../frontend/README.md).
Linux и Windows используют разные переводы строк в штатном CSV. Проверка стека
сравнивает строки с локальной сдачей и отдельно сверяет **байты** экспорта с
независимой официальной генерацией внутри Linux.

## Границы подтверждённого результата

`net_arpu_gain` — дополнительная выручка минус стоимость контактов. Это не полная
прибыль оператора. У пилотов есть шум; точные ID их выборки агенту неизвестны,
поэтому пересечение пилотов оценивается приближённо. Финальные пересечения и
ограничения исполняемого плана вычисляются по публичным правилам.

Разные seed одной mock-модели проверяют шум и выборки, а не универсальное качество
на неизвестных эффектах. В отчётах есть отрицательные результаты и ухудшения.
Режим `conservative` и малый p10 не дают гарантии прибыли. Результаты старых
измерений и хэши их исходников относятся к соответствующим архивным версиям;
переименование бренда не превращает их в новый эксперимент.

Локальное приложение рассчитано на один серверный процесс и синтетические
данные. Аутентификация, распределённая очередь и реальные маркетинговые отправки
не входят в согласованный MVP.
