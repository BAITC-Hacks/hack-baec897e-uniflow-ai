# OrbitDuo Campaign Studio

Офлайн-агент и локальный backend для Beeline Tariff Marketing Campaigns.
Метрика `net_arpu_gain` — дополнительная выручка за вычетом контактов, а не полная
прибыль оператора. Результаты локального mock не гарантируют результат скрытой модели.

## Запуск всего приложения через Docker

Из корня проекта, при запущенном Docker Desktop с Linux-контейнерами:

```powershell
docker compose up -d --build --wait
```

- Приложение OrbitDuo: <http://localhost:8080>.
- Документация API: <http://localhost:8000/docs>.
- Проверка состояния: `docker compose ps`.
- Журнал: `docker compose logs --tail=100 backend frontend`.
- Остановка с сохранением запусков: `docker compose down`.

Frontend работает с настоящим API; демонстрационный режим выключен. Nginx
раздаёт сборку и передаёт `/api/v1` backend. SQLite хранится в отдельном Docker
volume и переживает перезапуск/пересоздание контейнеров. `docker compose down -v`
удаляет этот volume и историю: для обычной остановки флаг `-v` не нужен.
Порты доступны только на локальной машине. При занятых портах задайте
`ORBITDUO_WEB_PORT` и `ORBITDUO_API_PORT` перед запуском, например 8081 и 8001.

Образы Python, Node и Nginx зафиксированы по digest. Оба сервиса выполняются
без root с доступом к записи только во временные каталоги и volume базы.
На первой сборке интернет нужен для загрузки образов и зависимостей;
готовому агенту и приложению внешние сервисы или API-ключи не нужны.

Сквозная проверка Docker из подготовленного Python-окружения:

```powershell
.\.venv\Scripts\python.exe -m scripts.verify_stack --restart
```

Она проверяет настоящий API через Nginx, исполнение плана, экспорт, повторный
POST, ETag, SPA-маршруты и сохранность результата после перезапуска backend.
Штатный `make_submission.py` отдельно запускается в чистом каталоге внутри
Linux-контейнера; его CSV сравнивается с экспортом API побайтно. С локальным
Windows-файлом сравниваются строки CSV: окончания строк платформ различаются.

## Установка

PowerShell, из корня репозитория. Проверенная здесь среда: Python 3.14.4,
NumPy 2.5.3, pandas 3.0.6, pytest 9.1.1, FastAPI 0.141.1,
Pydantic 2.13.5, Starlette 1.7.0, Uvicorn 0.53.0, httpx 0.28.1.

```powershell
$env:PYTHONUTF8 = '1'
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r participant_package/requirements.txt -r backend/requirements.txt
.\.venv\Scripts\python.exe -m pip check
```

Для конкурсной части достаточно `participant_package/requirements.txt`.
Агенту не нужны веб-сервер, LLM, GPU, ключи или внешняя БД.

## API и подключение frontend

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Один процесс, без `--workers`. SQLite по умолчанию находится в
`backend/data/runs.sqlite3`; другой путь задаётся через `ORBITDUO_DB_PATH`.
ОС-блокировка не допускает второй сервер с той же БД. Миграция существующей базы
сохраняет результаты и ключи идемпотентности. После аварии незавершённые задания
получают `failed / SERVER_RESTARTED`; готовые результаты остаются доступны.
Расчёт выполняется в выделенном worker, HTTP продолжает отвечать.

- [Health](http://127.0.0.1:8000/api/v1/health).
- [Аудит и справочники](http://127.0.0.1:8000/api/v1/overview).
- [Swagger](http://127.0.0.1:8000/docs).
- [Общий API-контракт](docs/team/API_CONTRACT.md) и [Pydantic DTO](backend/models.py).
- [Подробности backend](backend/README.md).

Из другого окна PowerShell:

```powershell
$runKey = [guid]::NewGuid().ToString()
$run = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8000/api/v1/runs' -ContentType 'application/json' -Headers @{ 'Idempotency-Key' = $runKey } -Body '{"seed":42,"risk_profile":"balanced"}'
Invoke-RestMethod "http://127.0.0.1:8000/api/v1/runs/$($run.id)"
```

Polling примерно раз в секунду до `completed` или `failed`. Повтор POST использует
тот же ключ; новый эксперимент — новый ключ. Второй активный расчёт возвращает
`409 RUN_ALREADY_ACTIVE`. Опциональный `If-None-Match` с предыдущим `ETag`
позволяет получить `304`, когда результат не изменился.
После завершения доступны `/runs/{id}/campaigns.csv` и `/runs/{id}/report.json`.
Экспорт читает сохранённый план и не запускает агента заново.

`forecast` — posterior-прогноз, `pilots` — наблюдения, `local_evaluation` —
независимая локальная оценка. Денежные значения — CU (у.е.).
Нерассчитанный интервал равен `null`.

Для общего запуска frontend и API из корня репозитория:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-demo.ps1
```

Скрипт проверяет Python и npm, при необходимости устанавливает зависимости,
запускает один backend и Vite с `VITE_DEMO_MODE=false`, затем печатает адреса.
Сценарий показа на три минуты: [docs/DEMO.md](docs/DEMO.md).

Для локальной разработки `frontend/.env.example` по умолчанию включает настоящий
API (`VITE_DEMO_MODE=false`). Демо включается явно только для демонстрации.
Для ручного запуска сначала запустите backend командой `uvicorn` выше.
При первом запуске frontend:

```powershell
Set-Location frontend
npm ci
Copy-Item .env.example .env
```

В `.env` оставьте `VITE_DEMO_MODE=false`, затем `npm run dev`.
Vite передаёт `/api/v1` на backend порта 8000. Подробности и команды UI-проверок
находятся в [frontend/README.md](frontend/README.md).
Для frontend нужен Node 24.15+ в линии 24 LTS. Docker уже содержит подходящую
версию сборщика.

Проверки frontend из `frontend/`:

```powershell
npm run build
npm run lint
npm run test
npm run test:e2e
npm run test:e2e:real
```

Демо-тесты запускают Vite с явным `VITE_DEMO_MODE=true`. Отдельный реальный
браузерный набор поднимает FastAPI и Vite с `VITE_DEMO_MODE=false`, использует
временную SQLite-базу и настоящий локальный расчёт. Для него требуется Python
в корневой `.venv/Scripts/python.exe`; другой путь задаётся через
`ORBITDUO_PYTHON`.
Проверка уже работающего приложения через `npm run test:e2e:live` описана
в [frontend/README.md](frontend/README.md).

## Оценка и submission

Из корня перейти в пакет участника:

```powershell
$env:PYTHONUTF8 = '1'
Set-Location participant_package
..\.venv\Scripts\python.exe local_eval.py
..\.venv\Scripts\python.exe local_eval.py --runs 10
..\.venv\Scripts\python.exe make_submission.py
$submissionHash = (Get-FileHash -LiteralPath submission.csv -Algorithm SHA256).Hash
..\.venv\Scripts\python.exe make_submission.py
if ((Get-FileHash -LiteralPath submission.csv -Algorithm SHA256).Hash -ne $submissionHash) { throw 'CSV не воспроизводится' }
..\.venv\Scripts\python.exe -m pytest -q
..\.venv\Scripts\python.exe -m orbitduo.evaluation
..\.venv\Scripts\python.exe -m experiments.verify_delivery
```

`local_eval.py` перехватывает ошибки агента, поэтому exit code недостаточен.
Строгий adapter дополнительно проверяет 1-10 непустых кампаний, успешные пилоты,
санитаризацию, поля, фактические аудитории и совпадение ресурсов с оценщиком.
`verify_delivery` проверяет неизменность организаторских файлов относительно
Git HEAD и совпадение submission в чистой копии без backend.

Из корня репозитория:

```powershell
.\.venv\Scripts\python.exe -m pytest backend/tests -q
.\.venv\Scripts\python.exe -m backend.final_smoke
.\.venv\Scripts\python.exe -m backend.benchmark_storage
```

`backend.final_smoke` сам запускает сервер на временном порту с отдельной БД,
проверяет balanced/42, CSV, события, идемпотентность, ETag и перезапуск.
Он не изменяет пользовательские запуски.

Сдавать `agent.py`, каталог `orbitduo/`, `requirements.txt`, `submission.csv`
и исторический `data/change_tariff.csv`, если его нет в поставке организатора.
Без истории предусмотрен нейтральный prior, но для повторения результатов нужны
те же входные CSV. Точка входа — `Agent().act(env)`.
Balanced/42 через API использует ту же конфигурацию.

## Что улучшено во второй версии

Пилоты уточняют не только эффект предложения, но и степень доверия к истории
и масштаб неопределённости. Разведка сравнивает размеры выборок, учитывает цену
информации и обычно сохраняет 80% бюджета для финала. Fallback при отрицательных
оценках выбирает минимальный ущерб по той же риск-цели.

Планировщик кэширует аудитории и суммы по префиксам, пересчитывая только затронутые
группы. На замороженном posterior тот же план получен за 0.076 с вместо 0.613 с
(около 8 раз быстрее; измерен именно шаг планирования). Дополнительный поиск
каналов/порядка включён после более широкого парного сравнения сценариев:
первые три seed не показали разницы, но на других семействах выигрыш обнаружен.
Вариант без расширения доступен как `Agent(advanced_search=False)`.

Backend сохраняет неизменяемые завершённые результаты, стабильные события,
версию snapshot и краткие сводки для списка. В отдельном измерении списка из
100 запусков чтение ускорилось с 62.05 до 7.86 мс. Это скорость хранилища,
а не всей HTTP-операции.

Подробнее: [математика и допущения](participant_package/docs/approach.md),
[конкурсный контракт](participant_package/docs/contract.md).

## Измерения и ограничения

Аудит: 23 441 клиент, 21 тариф, baseline 150 641 084.25 CU.
Для адресных кандидатов пригодна 23 341 строка; 100 исключены с учётом причин.
Пересечение ID исторической и целевой аудитории равно нулю.

[Сравнение v1/v2](participant_package/reports/improvement_report.md) содержит
среднее, медиану, минимум, p10, стоимость, контакты, охват, пилоты и время.
В нём явно сохранены ухудшения и границы независимости контрольных выборок.
[Каталог отчётов](participant_package/reports/README.md) различает текущие
измерения, архив v1 и промежуточную v2 с расширенным поиском.

После фиксации стратегии проверены mock-seed 40, 41, 43, 44, 45. При переименовании
в OrbitDuo обе версии повторно запущены: результаты совпали, время измерено заново
при параллельной проверке Docker. Повтор не считается новой независимой выборкой.

| Версия | Средний net, CU | Средние расходы, CU | Среднее act(), с |
|---|---:|---:|---:|
| v1 | 756 162.67 | 99 912.80 | 10.30 |
| v2 | 1 255 793.25 | 36 965.60 | 4.58 |

В этой серии средний net вырос примерно на 66%; обе версии дали положительные
результаты во всех пяти запусках. Это малая выборка шума той же mock-модели,
не гарантия переноса на неизвестные эффекты. Другие серии содержат ухудшения.

Стандартный seed 42: net **431 321.12 CU**, расходы **20 000**, контакты **10 355**,
уникальный охват **8 620**, **16 пилотов и 5 финальных кампаний**.
В v1 на этом seed было 928 158.79 CU при расходах 99 646: улучшение среднего
не означает улучшения каждого запуска.

Пройдены **66 тестов ядра и 36 тестов backend** на Windows и все **102 теста в Linux-контейнере**.
Frontend: сборка, lint, **10 unit-тестов и 8 браузерных тестов**, включая реальный API в Docker.
Два штатных экспорта, чистая копия и настоящий HTTP API дали одинаковые байты submission
в пределах каждой платформы; строки Windows и Linux совпали. После перезапуска контейнера
сохранились результат, экспорт и ключ идемпотентности.
SHA256 Windows CSV: `61149d82fcd740ef9e20acf16127abe014aa40f241758242b11e0aa49d7693e0`.
В TestClient есть предупреждение Starlette об устаревающем httpx fallback;
реальный TCP HTTP также проверен.

Для проверки ТЗ: [матрица требований и приёмка](docs/ACCEPTANCE.md),
[архитектура](docs/ARCHITECTURE.md), [сводка проверок](participant_package/reports/validation.json),
[Docker](backend/reports/docker_acceptance.json) и [браузер](frontend/reports/acceptance.json).

Смена seed проверяет шум одной mock-модели. Дополнительные семейства меняют
истинные эффекты, однако гарантии на неизвестной модели нет. Возможны убытки
при слабых эффектах и перестановке лидеров. Пересечения с пилотами приближённые,
posterior-прогноз не откалиброван как гарантированный интервал.
Conservative также не гарантирует положительного результата.
