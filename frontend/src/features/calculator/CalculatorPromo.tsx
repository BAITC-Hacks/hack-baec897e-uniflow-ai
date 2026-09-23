import { ArrowRight, Calculator } from 'lucide-react'
import { Link } from 'react-router-dom'
import './calculator.css'

export function CalculatorPromo() {
  return <div className="calculator-promo"><Calculator size={26} aria-hidden="true" /><div><strong>Сначала прикиньте эффект</strong><p>Изменяйте аудиторию, бюджет и отклик — предварительная оценка обновится сразу.</p></div><Link className="text-link" to="/calculator">Открыть калькулятор <ArrowRight size={17} aria-hidden="true" /></Link></div>
}
