import { ArrowUpRight, CircleAlert, ClipboardCheck, Info, ListChecks } from 'lucide-react'
import type { RunSnapshot } from '../../lib/api/types'
import { analyzeRun, type AnalysisAction } from '../../lib/runAnalysis'
import { StatusPill } from '../../components/ui/common'
import './run-analysis.css'

export function RunAnalysis({ run, onOpenCampaign }: { run: RunSnapshot; onOpenCampaign?: (id: string) => void }) {
  const analysis = analyzeRun(run)
  const complete = run.status === 'completed'
  function action(item: AnalysisAction) {
    if (item.campaignId && onOpenCampaign) return <button type="button" className="analysis-action" onClick={() => onOpenCampaign(item.campaignId!)}>{item.label}<ArrowUpRight size={15} aria-hidden="true" /></button>
    return <a className="analysis-action" href={item.href}>{item.label}<ArrowUpRight size={15} aria-hidden="true" /></a>
  }

  return <section id="run-analysis" className="run-analysis card run-anchor" aria-labelledby="run-analysis-title">
    <div className="analysis-heading">
      <div className="analysis-heading-icon"><ClipboardCheck size={22} aria-hidden="true" /></div>
      <div><p className="eyebrow">ПОНЯТНЫМ ЯЗЫКОМ</p><h2 id="run-analysis-title">Разбор результата</h2></div>
      <StatusPill tone={analysis.tone}>{analysis.label}</StatusPill>
    </div>
    <div className={`analysis-summary analysis-summary-${analysis.tone}`}>
      <strong>{analysis.headline}</strong><p>{analysis.summary}</p>
    </div>
    <div className="analysis-list-heading"><ListChecks size={19} aria-hidden="true" /><div><h3>{complete ? 'На что обратить внимание и что проверить дальше' : 'Что можно посмотреть сейчас'}</h3><p>{complete ? 'Подсказки расположены по приоритету и опираются на данные этого расчёта.' : 'Итоговые рекомендации появятся, когда будет сохранён готовый план.'}</p></div></div>
    <ol className="analysis-list">
      {analysis.recommendations.map((item, index) => <li className={`analysis-item analysis-item-${item.tone}`} key={item.id}>
        <span className="analysis-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
        <div className="analysis-item-body">
          <div className="analysis-item-title"><h4>{item.title}</h4>{item.tone === 'negative' && <CircleAlert size={17} aria-label="Требует особого внимания" />}</div>
          <p className="analysis-evidence"><span>Что видно в данных</span>{item.evidence}</p>
          <p className="analysis-next"><span>Следующий шаг</span>{item.nextStep}</p>
          {action(item.action)}
        </div>
      </li>)}
    </ol>
    <div className="analysis-footnote"><Info size={16} aria-hidden="true" /><div>{complete && <><p>Это сохранённый план для просмотра. В новом подборе можно выбрать уровень осторожности или номер учебного сценария. Кампании и пробные проверки система подбирает сама; вручную добавить или убрать их здесь нельзя.</p><a className="analysis-action" href="/runs/new">Настроить новый подбор<ArrowUpRight size={15} aria-hidden="true" /></a></>}<p>{run.mode === 'demo' ? 'Сейчас показан демонстрационный пример.' : 'Расчёт использует учебные данные.'} Прогноз и локальная проверка не являются фактическим доходом.</p></div></div>
  </section>
}
