# OrbitDuo Campaign Studio · frontend

React + TypeScript + Vite интерфейс для синтетического кейса Beeline. UI показывает аудиторию, журнал подбора, сохранённый план и два разных результата: прогноз агента и локальную оценку. Реальных рассылок нет.

## Запуск

```powershell
cd frontend
npm ci
Copy-Item .env.example .env
npm run dev
```

`VITE_DEMO_MODE=true` включает явный сценарий в браузере. Запуски демо хранятся в `localStorage`, поэтому страницы восстанавливаются после reload. Seed `42` показывает положительный план, `7` — отрицательный прогноз, `13` — ошибку. Осторожный риск-профиль уменьшает демонстрационную оценку. Для проверки пустой аудитории установите в DevTools `localStorage.setItem('orbitduo-demo-fixture', 'empty')` и обновите страницу. Это сценарии демонстрации, не результаты агента.

Для настоящего backend установите `VITE_DEMO_MODE=false` в `.env` и запустите FastAPI на `http://127.0.0.1:8000`. Либо из корня выполните `powershell -ExecutionPolicy Bypass -File .\scripts\start-demo.ps1`: он запустит оба процесса в реальном режиме. Vite передаст запросы `/api/v1` через proxy. Можно задать `VITE_API_BASE_URL` для другого адреса. Если API недоступен, интерфейс покажет ошибку подключения и не включит демо автоматически.

## Проверки

```powershell
npm run build
npm run lint
npm run test
npx playwright install chromium
npm run test:e2e
npm run test:e2e:real
```

`test:e2e` запускает Vite с демо-режимом. `test:e2e:real` поднимает настоящий FastAPI, Vite с `VITE_DEMO_MODE=false` и изолированную временную SQLite-базу. Для реального набора нужен Python с backend-зависимостями в `../participant_package/.venv/Scripts/python.exe` или путь в `ORBITDUO_PYTHON`. UI берёт все данные через типизированный клиент `src/lib/api/client.ts`. Демо-транспорт `src/mocks/transport.ts` выдаёт те же DTO и ошибки, что описаны в `docs/team/API_CONTRACT.md` (файл на уровень выше).

Конкурсный `submission.csv` создаётся отдельно: `cd ../participant_package; python make_submission.py`. Экспорт UI скачивает сохранённый план выбранного запуска.

## Интеграция

Настоящий путь: `/overview` → `POST /runs` → polling `/runs/{id}` → сохранённый план и экспорт. После перезагрузки страница читает тот же `run_id`; ошибки связи показывают последний полученный снимок и возобновляют опрос. Демо включается только при `VITE_DEMO_MODE=true`.
