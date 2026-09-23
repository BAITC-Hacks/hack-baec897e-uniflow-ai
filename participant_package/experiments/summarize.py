"""Собрать измеренные CSV в воспроизводимый отчёт на русском языке."""
from __future__ import annotations

import json
import pandas as pd
from .benchmark import REPORTS, summarize


def table(summary):
    lines = ["| Стратегия | Запуски | Средний net | Медиана | Минимум | p10 | Отрицательные | Стоимость | Контакты | Уникальные | Пилоты | Финальные | Макс. секунды | Корректны все |",
             "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"]
    for item in summary:
        lines.append("| " + " | ".join([
            item["strategy"], str(item["runs"]), *[f"{item[key]:,.0f}" for key in ("mean_net", "median_net", "min_net", "p10_net")],
            f"{item['negative_fraction']:.0%}", f"{item['mean_communication_cost']:,.0f}",
            f"{item['mean_total_contacts']:,.0f}", f"{item['mean_unique_customers']:,.0f}",
            f"{item['mean_n_pilots']:.1f}", f"{item['mean_n_final_campaigns']:.1f}", f"{item['max_runtime_seconds']:.2f}",
            "да" if item["all_conform"] else "нет",
        ]) + " |")
    return "\n".join(lines)


def main():
    benchmark = pd.read_csv(REPORTS / "benchmark.csv")
    ablation = pd.read_csv(REPORTS / "ablation.csv")
    diverse_path = REPORTS / "diverse_fixed.csv"
    diverse = pd.read_csv(diverse_path) if diverse_path.exists() else None
    if diverse is not None:
        benchmark = pd.concat([benchmark, diverse.loc[diverse.scenario == "mock"]], ignore_index=True)
    text = ["# Измеренные результаты офлайн-решения", "",
        "Все суммы — синтетические у.е. (CU). Net означает дополнительный ARPU за вычетом всех коммуникаций, включая пилоты и повторные контакты. Это не полная прибыль оператора.", "",
        "## Локальная mock-модель: seed среды 0–9", "", table(summarize(benchmark.to_dict("records"))), "",
        "Исходный неизменённый шаблон не возвращает финальную кампанию на seed 3; его фактический результат сохранён, корректность отмечена как false. Реализованные стратегии соблюдают ограничения исполнения и ресурсов во всех этих запусках. Стоимость, контакты, охват и количества кампаний в таблицах усреднены. Время измеряет только `act()`, без загрузки и скоринга. p10 по десяти запускам — грубая описательная оценка.", "",
        "`fixed` фиксирует исходный рейтинг гипотез и на этих данных направляет все пилоты в крупнейшую исходную группу. Это диагностический соперник: он не удовлетворяет требованию разнообразной разведки и не выбран по умолчанию, несмотря на высокий локальный результат. Адаптивная стратегия сначала исследует шесть разных групп, когда они доступны, затем использует обновлённые оценки. Её средний результат выше исходного шаблона на измеренной mock-модели, но ниже концентрированного `fixed`; один запуск отрицательный.", ""]
    if diverse is not None:
        text += ["`diverse_fixed` — отдельный более простой вариант: первые шесть групп различаются, затем не более четырёх пилотов на группу; расписание не зависит от ответов. Его локальное среднее немного выше адаптивного, но отрицательных запусков 2/10 вместо 1/10, p10 ниже; при смене знаков средний результат отрицательный, тогда как у адаптивного положительный. При слабой связи с историей `diverse_fixed` выигрывает. Универсального превосходства нет; стандартным сохранён адаптивный вариант. Полные 28 запусков находятся в `diverse_fixed.csv`.", ""]
    text += ["## Абляции: одинаковые seed 0–2", "", table(summarize(ablation.to_dict("records"))), "",
        "Это ограниченная проверка чувствительности. Исторические средние служат слабым предварительным ранжированием; частоты состоявшихся переходов не трактуются как отклик на предложение. Равное качество без истории на построенной из истории mock-модели не подтверждается.", ""]
    scenario_path = REPORTS / "scenarios.csv"
    if scenario_path.exists():
        scenarios = pd.read_csv(scenario_path)
        if diverse is not None:
            scenarios = pd.concat([scenarios, diverse.loc[diverse.scenario != "mock"]], ignore_index=True)
        text += ["## Другие семейства эффектов: три seed на стратегию", "",
            "Истинные эффекты изменены через публичную фабрику; агент получает только публичную среду и шумные пилоты. Конструкции зафиксированы до оценки и описаны в `experiments/README.md`.", ""]
        for family, group in scenarios.groupby("scenario", sort=True):
            text += [f"### {family}", "", table(summarize(group.to_dict("records"))), ""]
        text += ["Смена seed шума не меняет семейство истинных эффектов. Эти отдельные стресс-сценарии выявляют ограничения, которых не видно по десяти локальным seed. Они не являются выборкой из скрытого судейского распределения. При перестановке лидеров, низкой конверсии и почти нулевых эффектах стандартный агент получает отрицательные результаты; положительный исход не гарантируется.", ""]
    prior_path = REPORTS / "prior_sensitivity.csv"
    if prior_path.exists():
        prior = pd.read_csv(prior_path)
        text += ["## Чувствительность к prior и пересечениям", "", table(summarize(prior.to_dict("records"))), "",
            "Среднее исторического prior умножается на 0,5, 1 или 2 при неизменной широкой дисперсии. Результат чувствителен к этому выбору. Три seed не устанавливают оптимальные параметры.", ""]
    overlap_path = REPORTS / "overlap_sensitivity.csv"
    if overlap_path.exists():
        overlap = pd.read_csv(overlap_path)
        text += ["Аналитическое включение пилотов сравнено с игнорированием пересечений при одинаковых posterior, проведённых пилотах и остатках ресурсов:", "",
                 "| Seed | Net с аналитическим пересечением | Net без учёта пересечения | План изменился |", "| ---: | ---: | ---: | --- |"]
        for seed, group in overlap.groupby("seed", sort=True):
            indexed = group.set_index("method")
            changed = "да" if group.plan_changed.any() else "нет"
            text += [f"| {seed} | {indexed.loc['analytic_overlap', 'net_arpu_gain']:,.0f} | {indexed.loc['ignore_pilot_overlap', 'net_arpu_gain']:,.0f} | {changed} |"]
        text += ["", "Вероятности включения аналитические при независимых равномерных выборках; смысловой тест сверяет их с Монте-Карло. Однако прогноз подставляет средние posterior в максимум и не интегрирует неопределённость параметров. Это приближение влияет на решения и может ухудшать качество, как видно здесь. Реальные ID пилотов доступны только независимому оценщику. Интервал прогноза равен null, поскольку калиброванный интервал не рассчитан. Дополнительная проверка пересечений методом Монте-Карло сохранена в `overlap_sensitivity.json`.", ""]
    conservative_path = REPORTS / "conservative_check.json"
    if conservative_path.exists():
        conservative = json.loads(conservative_path.read_text(encoding="utf-8"))["local_evaluation"]
        text += ["## Проверка консервативного профиля", "",
            f"Отдельный реальный запуск, seed 42: net {conservative['net_arpu_gain']:,.2f} у.е., "
            f"стоимость {conservative['communication_cost']:,.0f}, контакты {conservative['total_contacts']:,}, "
            f"пилоты {conservative['n_pilots']}, финальные кампании {conservative['n_final_campaigns']}. "
            "Проверки ресурсов и экспортируемого плана в evaluation adapter пройдены. Более высокий штраф за неопределённость меняет планирование, но не гарантирует положительный фактический результат.", ""]
    metadata = json.loads((REPORTS / "experiment_environment.json").read_text(encoding="utf-8"))
    text += ["## Воспроизведение и ограничения", "",
        f"Проверенная среда: Python {metadata['python']}; " + ", ".join(f"{name} {version}" for name, version in metadata["versions"].items()) + ".",
        "", "```powershell", "python -m experiments.benchmark --runs 10 --scenario-runs 3", "python -m experiments.diverse_fixed --runs 10 --scenario-runs 3", "python -m experiments.sensitivity --runs 3", "python -m experiments.summarize", "python -m pytest -q", "```", "",
        "Команды выполняются из `participant_package/` в активированном виртуальном окружении репозитория. `experiment_environment.json` содержит отпечатки исходников организатора и данных; эти файлы не изменялись. Все индивидуальные измерения сохранены в CSV рядом с отчётом. Отдельная штатная команда `python local_eval.py --runs 10` использует стандартный Agent. Название конфигурации в таблице обозначает проведённый эксперимент, а не обещание будущего результата.", ""]
    (REPORTS / "benchmark_report.md").write_text("\n".join(text), encoding="utf-8")


if __name__ == "__main__":
    main()
