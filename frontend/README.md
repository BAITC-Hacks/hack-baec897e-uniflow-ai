# UniFlow Campaign Studio · frontend

React + TypeScript + Vite интерфейс для синтетического кейса Beeline. UI показывает аудиторию, журнал подбора, сохранённый план и два разных результата: прогноз агента и локальную оценку. Реальных рассылок нет.

## Запуск

```powershell
cd frontend
npm ci
Copy-Item .env.example .env
npm run dev
```

`VITE_DEMO_MODE=true` включает явный сценарий в браузере. Запуски демо хранятся в `localStorage`, поэтому страницы восстанавливаются после reload. Seed `42` показывает положительный план, `7` — отрицательный прогноз, `13` — ошибку. Осторожный риск-профиль уменьшает демонстрационную оценку. Для проверки пустой аудитории установите в DevTools `localStorage.setItem('uniflow-demo-fixture', 'empty')` и обновите страницу. Это сценарии демонстрации, не результаты агента.

Для настоящего backend установите `VITE_DEMO_MODE=false` в `.env` и запустите FastAPI на `http://127.0.0.1:8000`. Vite передаст запросы `/api/v1` через proxy. Можно задать `VITE_API_BASE_URL` для другого адреса. Если API недоступен, интерфейс покажет ошибку подключения и не включит демо автоматически.

## Проверки

```powershell
npm run build
npm run lint
npm run test
npx playwright install chromium
npm run test:e2e
```

E2E запускает Vite с демо-режимом. UI берёт все данные через типизированный клиент `src/lib/api/client.ts`. Демо-транспорт `src/mocks/transport.ts` выдаёт те же DTO и ошибки, что описаны в `docs/team/API_CONTRACT.md` (файл на уровень выше). Сводка аудитории в `src/mocks/overview.json` построена из открытого синтетического CSV командой `python scripts/generate_demo_overview.py`.

Конкурсный `submission.csv` создаётся отдельно: `cd ../participant_package; python make_submission.py`. Экспорт UI скачивает сохранённый план выбранного запуска.

## Статус интеграции

Frontend готов к контрактному API. Сквозной сценарий с настоящим FastAPI требует работающего backend: `/overview` → `POST /runs` → `GET /runs/{id}` → файлы экспорта. Когда сервис появится, запустить его, выключить demo и пройти этот сценарий.
