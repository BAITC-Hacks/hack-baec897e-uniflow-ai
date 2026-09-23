# Beeline Tariff Marketing Campaigns

Стартовый каркас решения кейса для OrbitDuo. Исходные данные, публичная среда
и локальный evaluator находятся в `participant_package/`.

## Структура

- `participant_package/agent.py` — точка входа `Agent.act(env)`; стратегия пока
  оставлена как TODO.
- `participant_package/environment.py`, `scoring_core.py` — публичный контракт
  среды и локальная оценка.
- `participant_package/data/` и CSV в корне пакета — исходные данные кейса.
- `participant_package/agent_template.py` — предоставленный шаблон агента.

## Подготовка окружения

Требуется Python и зависимости из `participant_package/requirements.txt`.

```powershell
cd participant_package
python -m pip install -r requirements.txt
```

После реализации стратегии отдельно проведём локальные проверки и тесты.
