import { useState } from 'react'
import { ArrowRight, Info } from 'lucide-react'
import type { CampaignSpec, RunSnapshot } from '../../lib/api/types'
import { channel, money, number, percentage, segment, tariff, when } from '../../lib/format'
import { explainEvent, explainPilotDecision, explainPilotSelection } from '../../lib/explanations'
import { Card, CardHeader, EmptyState } from '../../components/ui/common'
import { TechnicalDetails } from '../../components/ui/TechnicalDetails'
import './research-activity.css'

function who(spec: CampaignSpec) {
  const level = spec.filter_arpu_segment?.split(';').map(value => segment(value.trim()).toLocaleLowerCase('ru')).join(', ') || 'все уровни выручки'
  const tariffs = spec.filter_current_tariff?.split(';').map(value => tariff(value.trim())).join(', ') || 'Любой текущий тариф'
  return `${tariffs} · ${level}`
}

export function ResearchActivity({ run }: { run: RunSnapshot }) {
  const [allPilots, setAllPilots] = useState(false)
  const [allEvents, setAllEvents] = useState(false)
  const pilots = [...run.pilots].sort((a, b) => a.sequence - b.sequence)
  const events = [...run.events].sort((a, b) => a.sequence - b.sequence)
  const active = run.status === 'queued' || run.status === 'running'
  const visiblePilots = allPilots ? pilots : pilots.slice(-3)
  const visibleEvents = allEvents ? events : events.slice(-5)
  return <section className="research-section run-anchor" id="run-research" aria-label="Проверки предложений и действия программы">
    <div className="research-introduction"><Info size={21} aria-hidden="true" /><div><h2>Почему программа предложила такой план?</h2><p>Слева — небольшие пробные проверки предложений, которые называют пилотами. Справа — действия программы и изменения плана. Это история расчёта: выполнять команды или вводить что-либо здесь не нужно.</p></div></div>
    <div className="activity-grid">
      <Card><CardHeader eyebrow="ЧТО ПРОВЕРИЛИ" title="Проверки предложений" aside={<span className="result-count">{number(pilots.length)} из возможных {number(run.resources.pilots_limit)}</span>} />
        <p className="activity-intro">Во время пробной проверки предложение оценивается на небольшой группе в учебной среде. Процент показывает наблюдение этой проверки, а не итоговую выгоду всего плана.{pilots.length > 3 && !allPilots ? ' Ниже — последние 3 проверки.' : ''}</p>
        {pilots.length ? <><div className="plain-pilot-list">{visiblePilots.map(pilot => {
          const selection = explainPilotSelection(pilot)
          const decision = explainPilotDecision(pilot)
          const observed = pilot.observed_lift_ratio
          return <article className="plain-pilot" key={pilot.id} aria-labelledby={`pilot-heading-${pilot.id}`}>
            <div className="plain-pilot-heading"><span className="pilot-seq">{pilot.sequence.toString().padStart(2, '0')}</span><div><h3 id={`pilot-heading-${pilot.id}`}>Предложить {tariff(pilot.campaign.target_tariff)}</h3><p>Кому: {who(pilot.campaign)}</p><p>Способ связи: {channel(pilot.campaign.channel)}</p></div></div>
            <div className="pilot-observation-box"><div><span>Наблюдаемый эффект</span><strong>{percentage(observed)}</strong><small>{observed < 0 ? 'Ниже исходного уровня в этой проверке' : observed > 0 ? 'Выше исходного уровня в этой проверке' : 'Изменение не зафиксировано'}</small></div><div><span>Участников</span><b>{number(pilot.actual_customers)}</b><small>из {number(pilot.requested_customers)} запрошенных</small></div><div><span>Расход на связь</span><b>{money(pilot.cost)}</b><small>входит в общий бюджет</small></div></div>
            <div className="pilot-answer"><h4>Зачем проверяли</h4><p>{selection.text}</p></div>
            <div className="pilot-answer pilot-answer-decision"><ArrowRight size={17} aria-hidden="true" /><div><h4>Как изменилось решение</h4><p>{decision.text}</p></div></div>
            <p className="pilot-observation-caution">Это небольшая выборка: одно наблюдение не доказывает, что предложение выгодно или невыгодно для всей аудитории.</p>
            <TechnicalDetails>{`Проверка: ${pilot.id}\nАудитория и предложение: ${JSON.stringify(pilot.campaign, null, 2)}\n\nПричина проверки:\n${pilot.selection_reason}\n\nИзменение решения:\n${pilot.decision_after}`}</TechnicalDetails>
          </article>
        })}</div>{pilots.length > 3 && <button type="button" className="button button-subtle activity-expand" aria-expanded={allPilots} onClick={() => setAllPilots(value => !value)}>{allPilots ? 'Свернуть до последних 3 проверок' : `Показать все проверки (${number(pilots.length)})`}</button>}</> : <EmptyState title="Проверок пока нет" text={active ? 'После первой пробы здесь появятся предложение, число участников, наблюдение и объяснение решения.' : 'В этом расчёте пробные проверки не сохранены.'} />}
      </Card>
      <Card><CardHeader eyebrow="КАК СОБИРАЛСЯ ПЛАН" title="Что сделала программа" aside={<span className="result-count">Записей: {number(events.length)}</span>} /><p className="activity-intro">Последовательность фактических действий: от проверки данных до сохранения результата.{events.length > 5 && !allEvents ? ' Показаны последние 5 записей.' : ''}</p>
        {events.length ? <><ol className="event-list plain-event-list">{visibleEvents.map(event => {
          const explanation = explainEvent(event)
          return <li key={event.id}><span className="event-point" aria-hidden="true" /><div><small><time dateTime={event.created_at}>{when(event.created_at)}</time></small><h3>{explanation.title}</h3><p>{explanation.text}</p><TechnicalDetails>{`${event.title}\n${event.message}`}</TechnicalDetails></div></li>
        })}</ol>{events.length > 5 && <button type="button" className="button button-subtle activity-expand" aria-expanded={allEvents} onClick={() => setAllEvents(value => !value)}>{allEvents ? 'Свернуть до последних 5 записей' : `Показать весь ход подбора (${number(events.length)})`}</button>}</> : <EmptyState title={active ? 'Ожидаем первые действия' : 'Нет сохранённых записей'} text={active ? 'Программа добавит сюда выполненные шаги по мере расчёта.' : 'История действий не сохранена в этом отчёте.'} />}
      </Card>
    </div>
  </section>
}
