import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight, BookOpen, CircleHelp, Search, X } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'

const topics = [
  { title: 'Как работает предварительный калькулятор?', category: 'Первые шаги', text: 'Откройте «Калькулятор» и двигайте ползунки аудитории, бюджета, вероятности перехода и изменения выручки. Стоимость связи и средняя выручка берутся из учебных данных, а вероятность и изменение — ваши предположения. Результат обновляется сразу: это дополнительная выручка после расходов на связь для одного предложения, а не полная прибыль бизнеса. Калькулятор не запускает подбор и не передаёт в него свои значения.', to: '/calculator', action: 'Открыть калькулятор' },
  { title: 'Что это за программа?', category: 'Первые шаги', text: 'OrbitDuo помогает подобрать тарифные предложения для абонентов. Вы получаете план: кому предложить какой тариф, как связаться, сколько это стоит и какой дополнительный эффект ожидается. Программа использует учебные данные. Симуляция — компьютерная проверка предложений: реальные сообщения людям не отправляются.' },
  { title: 'С чего начать?', category: 'Первые шаги', text: 'Нажмите «Подобрать кампании». Для первого расчёта оставьте сбалансированный подход и нажмите кнопку подбора ещё раз на странице настроек. Программа откроет ход расчёта, затем покажет план и его разбор. При желании сначала откройте «Аудиторию», чтобы посмотреть абонентов и качество данных.', to: '/runs/new', action: 'Настроить подбор' },
  { title: 'Кампания, аудитория и канал — что это?', category: 'Первые шаги', text: 'Аудитория — абоненты, для которых подбираются предложения. Сегмент — группа абонентов с общим признаком, например высокой выручкой. Канал — способ связи: СМС, уведомление в приложении, интернет-реклама или звонок. Кампания объединяет одну группу, один предлагаемый тариф и один способ связи. Это строка будущего плана.' },
  { title: 'Что происходит после запуска?', category: 'Первые шаги', text: 'Программа проверяет данные, сравнивает предложения, проверяет часть из них на небольших учебных группах и составляет план. В ходе расчёта появляются результаты и объяснения. Можно перейти в другой раздел: расчёт продолжится. Вернуться к нему можно через «Запуски». Один запуск — один сохранённый расчёт.', to: '/runs', action: 'Открыть историю' },
  { title: 'Надписи в журнале — это команды?', category: 'Первые шаги', text: 'Нет. Журнал показывает, что программа уже сделала и почему: проверила данные, выбрала предложение, уточнила оценку. Ничего вводить или выполнять по этим записям не нужно. Исходные технические записи доступны в раскрываемых подробностях, если нужно свериться с отчётом. Например, queued означает ожидание, audit — проверку данных, planning — составление плана.' },
  { title: 'Что означают tariff_11, HIGH и digital_ads?', category: 'Первые шаги', text: 'Это коды в исходных данных, а не команды. В интерфейсе tariff_11 показан как «Тариф 11», HIGH — «Высокая выручка», digital_ads — «Интернет-реклама». Цифра в названии тарифа — его номер, а не цена и не оценка качества. В скачанных файлах исходные коды сохранены для совместимости.' },
  { title: 'ARPU и исходная выручка', category: 'Показатели', text: 'ARPU — средняя выручка на одного абонента. Исходная ожидаемая выручка — сумма прогнозов до новых кампаний. Она описывает аудиторию и не является доходом от предложенного плана. Денежные суммы показаны в условных единицах (у.е.).' },
  { title: 'Пилот и наблюдаемый эффект', category: 'Показатели', text: 'Пилот — пробная проверка предложения на небольшой группе учебных абонентов. Наблюдаемый эффект показывает, как изменилась выручка в этой проверке: плюс — выросла, минус — снизилась. Это ещё не результат всего плана. Программа уточняет оценку с учётом случайных колебаний; одного удачного пилота недостаточно, чтобы обещать выгоду. Проверки тоже расходуют бюджет и попытки связи.' },
  { title: 'Прогноз и проверка в симуляции', category: 'Показатели', text: 'Прогноз эффекта — сколько дополнительной выручки ожидается после вычета расходов на связь, включая пробные проверки. Проверка в симуляции (локальная проверка) — результат отдельного компьютерного расчёта на учебных данных. Он позволяет проверить план, но может отличаться от прогноза. Оба показателя не являются реальным доходом или гарантией будущего результата.' },
  { title: 'Контакты и уникальный охват', category: 'Показатели', text: 'Контакт — одна попытка связи. Один абонент может участвовать в нескольких предложениях, поэтому контактов бывает больше, чем уникальных людей. Уникальный охват считает каждого человека один раз. Не складывайте вклад пересекающихся кампаний для самостоятельного пересчёта прогноза.' },
  { title: 'Сбалансированный или осторожный?', category: 'Настройки', text: 'Сбалансированный подход учитывает и ожидаемый эффект, и точность прогноза. Начните с него. Осторожный сильнее снижает оценку предложений, в которых программа меньше уверена. Он не гарантирует положительный результат. Бюджет и остальные лимиты одинаковы для обоих подходов; изменить их в интерфейсе нельзя.' },
  { title: 'Что такое seed — номер сценария?', category: 'Настройки', text: 'Seed — целое число, которое задаёт учебный сценарий. Оставьте 42 при первом знакомстве. Чтобы сравнить два подхода к риску, сохраняйте одинаковые исходные данные, номер сценария и версию программы. Параметр находится в блоке «Номер сценария (необязательно)» на странице нового расчёта.' },
  { title: 'Как читать готовый план?', category: 'Результат', text: 'Начните с разбора результата: он укажет, что стоит проверить. Затем сравните прогноз с проверкой в симуляции и посмотрите расходы. В таблице кампаний откройте «Подробности», чтобы узнать, кому и какой тариф предлагается, почему он выбран и чем подтверждён. Номер кампании показывает порядок выполнения; сортировка таблицы его не меняет.' },
  { title: 'Как улучшить план: что добавить или убрать?', category: 'Результат', text: 'Разбор результата помогает найти слабые места: отрицательный эффект, большой разрыв между прогнозом и проверкой, неподтверждённые предложения или нехватку исходных данных. Это рекомендации для проверки, а не изменения плана. Добавлять и удалять кампании вручную здесь нельзя. Изучите причины выбора и создайте новый расчёт с другим подходом к риску; сравните оба результата в «Запусках». Смена номера сценария меняет условия опыта, поэтому сама по себе не доказывает улучшение.', to: '/runs/new', action: 'Рассчитать другой вариант' },
  { title: 'Почему прогноз отрицательный?', category: 'Результат', text: 'Ожидаемая дополнительная выручка не покрывает расходы на связь, включая пробные проверки. Посмотрите, какие кампании выбраны и насколько их подтверждают пилоты. Завершённый расчёт означает, что план подготовлен, но не обязательно выгоден. Для сравнения можно рассчитать осторожный вариант с тем же номером сценария.' },
  { title: 'Экспорт: какой файл скачать — CSV или JSON?', category: 'Результат', text: 'CSV — таблица готовых кампаний, которую можно открыть в Excel или другом табличном редакторе. JSON — подробный отчёт с настройками, проверками, журналом и результатом; он подходит для дальнейшего анализа и передачи разработчику. Оба файла доступны после завершения расчёта. Скачивание не запускает расчёт заново и не отправляет предложения абонентам.' },
  { title: 'Пропало соединение или произошла ошибка', category: 'Помощь', text: 'При потере связи последний загруженный результат остаётся на экране. «Повторить» заново запрашивает данные. Если связь пропала при создании расчёта, повторите отправку с теми же настройками: программа откроет уже созданный расчёт, если он успел сохраниться. Если сам расчёт завершился ошибкой, прочитайте её объяснение и при необходимости создайте новый.' },
  { title: 'Как пользоваться с клавиатуры?', category: 'Помощь', text: 'Tab перемещает фокус между действиями, Enter активирует ссылку или кнопку, пробел переключает выбранный элемент. В справке и подробностях кампании фокус остаётся внутри окна. Escape закрывает окно и возвращает фокус к кнопке, с которой оно открыто.' },
]

const HelpContext = createContext<(query?: string) => void>(() => {})

export function HelpButton({ children = 'Как это работает', query = '', className = 'text-link' }: { children?: ReactNode; query?: string; className?: string }) {
  const open = useContext(HelpContext)
  return <button type="button" className={className} onClick={() => open(query)}><CircleHelp size={17} aria-hidden="true" />{children}</button>
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [isOpen, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const origin = useRef<HTMLElement | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef(true)
  const location = useLocation()
  const previousPath = useRef(location.pathname)
  useEffect(() => {
    if (!isOpen) return
    origin.current = document.activeElement as HTMLElement
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialog.current?.showModal()
    input.current?.focus()
    return () => { document.body.style.overflow = previousOverflow }
  }, [isOpen])
  useEffect(() => {
    if (previousPath.current !== location.pathname) {
      restoreFocus.current = false
      dialog.current?.close()
      previousPath.current = location.pathname
    }
  }, [location.pathname])
  const close = (restore = true) => { restoreFocus.current = restore; dialog.current?.close() }
  const filtered = topics.filter(topic => `${topic.title} ${topic.text} ${topic.category}`.toLocaleLowerCase('ru').includes(search.trim().toLocaleLowerCase('ru')))
  return <HelpContext.Provider value={query => { setSearch(query || ''); setOpen(true) }}>
    {children}
    <dialog ref={dialog} className="help-dialog" aria-labelledby="help-title" onCancel={event => { event.preventDefault(); close() }} onClose={() => { setOpen(false); if (restoreFocus.current && origin.current?.isConnected) origin.current.focus() }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close() } }}>
      {isOpen && <><div className="help-header"><span className="help-icon"><BookOpen size={24} aria-hidden="true" /></span><div><p className="eyebrow">ПОНЯТНЫЕ ОТВЕТЫ</p><h2 id="help-title">Как пользоваться OrbitDuo</h2><p>Что делает программа, куда нажимать и как понять результат.</p></div><button type="button" className="icon-button" aria-label="Закрыть справку" onClick={() => close()}><X size={21} /></button></div>
      <div className="help-search"><Search size={19} aria-hidden="true" /><input ref={input} aria-label="Поиск по справке" placeholder="Например: с чего начать, тариф или улучшить" value={search} onChange={event => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Очистить поиск по справке" onClick={() => { setSearch(''); input.current?.focus() }}><X size={17} /></button>}</div>
      <div className="help-body"><div className="help-result-count" role="status">{search ? `Найдено ответов: ${filtered.length}` : 'От первого подбора до готового отчёта'}</div>
        {filtered.length === 0 ? <div className="empty-state"><Search size={28} aria-hidden="true" /><h3>Такой подсказки пока нет</h3><p>Попробуйте «пилот», «риск» или «экспорт».</p><button className="button button-secondary" onClick={() => { setSearch(''); input.current?.focus() }}>Показать все ответы</button></div> : filtered.map(topic => <details className="help-topic" key={topic.title} open={search.trim() ? true : undefined}><summary><span><small>{topic.category}</small>{topic.title}</span><span className="disclosure-plus" aria-hidden="true">+</span></summary><div><p>{topic.text}</p>{topic.to && <Link to={topic.to} onClick={() => close(false)} className="text-link">{topic.action}<ArrowRight size={16} aria-hidden="true" /></Link>}</div></details>)}
      </div><div className="help-footer"><span>OrbitDuo · Подбор предложений</span><span><kbd>Esc</kbd> закрыть справку</span></div></>}
    </dialog>
  </HelpContext.Provider>
}
