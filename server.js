// ============================================================
// API BASE — backend is served from the same origin as this
// page (single server.js serves both the site and /api/*).
// If you ever host the frontend separately, set:
//   <script>window.SCS_API_BASE = "https://your-backend.com/api";</script>
// before script.js loads.
// ============================================================
const API_BASE = window.SCS_API_BASE || '/api';

// ============================================================
// SPA ROUTING — index.html now contains 3 "pages" in one file:
// #page-home, #page-ai-assistant, #page-gulf-middle-east
// ============================================================
const PAGE_IDS = ['home', 'ai-assistant', 'gulf-middle-east'];

function showPage(pageId) {
  PAGE_IDS.forEach(id => {
    const el = document.getElementById('page-' + id);
    if (el) el.classList.toggle('hidden', id !== pageId);
  });
  window.scrollTo(0, 0);
}

function handleRoute() {
  const hash = window.location.hash.replace('#', '');
  if (hash === 'page-ai-assistant') {
    showPage('ai-assistant');
  } else if (hash === 'page-gulf-middle-east') {
    showPage('gulf-middle-east');
  } else {
    // any other hash (#network, #services, #gulf, #rfq, #ai, #cases, or empty)
    // is an in-page anchor that lives on the home page
    showPage('home');
    if (hash) {
      setTimeout(() => {
        document.getElementById(hash)?.scrollIntoView({ behavior: 'smooth' });
      }, 30);
    }
  }
}
window.addEventListener('hashchange', handleRoute);
handleRoute();

// Ops panel routes
const routes = [
  { from: 'TAS', to: 'DXB', flight: 'HY-273', status: 'BOARDING', eta: '3h 20m', gold: true },
  { from: 'PVG', to: 'TAS', flight: 'KE-902', status: 'IN TRANSIT', eta: '5h 45m', gold: false },
  { from: 'TAS', to: 'FRA', flight: 'LH-1443', status: 'SCHEDULED', eta: '7h 10m', gold: false },
  { from: 'TAS', to: 'DOH', flight: 'QR-338', status: 'READY', eta: '4h 05m', gold: true },
  { from: 'ICN', to: 'TAS', flight: 'KE-931', status: 'IN TRANSIT', eta: '6h 30m', gold: false },
  { from: 'TAS', to: 'RUH', flight: 'HY-297', status: 'BOARDING', eta: '4h 40m', gold: true },
];

function renderRoutes() {
  const el = document.getElementById('opsRoutes');
  if (!el) return;
  el.innerHTML = routes.map(r => `
    <div class="flex items-center justify-between py-1.5 border-b border-border-soft/50 last:border-0 hover:bg-white/[0.02] px-1 -mx-1 rounded transition">
      <div class="flex items-center gap-3">
        <span class="font-mono text-xs font-bold ${r.gold ? 'text-gold' : 'text-white/90'} w-10">${r.from}</span>
        <svg class="w-3 h-3 ${r.gold ? 'text-gold' : 'text-blue'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
        <span class="font-mono text-xs font-bold ${r.gold ? 'text-gold' : 'text-white/90'} w-10">${r.to}</span>
        <span class="font-mono text-[10px] text-slate-soft ml-2">${r.flight}</span>
      </div>
      <div class="flex items-center gap-3">
        <span class="font-mono text-[10px] text-slate-soft hidden sm:inline">${r.eta}</span>
        <span class="font-mono text-[9px] tracking-widest px-2 py-0.5 border ${
          r.status === 'BOARDING' ? 'border-orange/50 text-orange bg-orange/5' :
          r.status === 'IN TRANSIT' ? 'border-blue/50 text-blue bg-blue/5' :
          r.status === 'READY' ? 'border-gold/50 text-gold bg-gold/5' :
          'border-slate-soft/50 text-slate-soft'
        }">${r.status}</span>
      </div>
    </div>
  `).join('');
}
renderRoutes();

function updateClock() {
  const el = document.getElementById('opsClock');
  if (!el) return;
  const d = new Date();
  const opts = { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
  el.textContent = d.toLocaleTimeString('en-GB', opts) + ' UTC+5';
}
setInterval(updateClock, 1000);
updateClock();

// Reveal on scroll
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('on'); });
}, { threshold: 0.1 });
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// Mobile menu
document.getElementById('menuBtn')?.addEventListener('click', () => {
  document.getElementById('mobileMenu').classList.toggle('hidden');
});

// ============================================================
// AI CARGO ASSISTANT — real Claude API integration via backend
// (POST {API_BASE}/chat). Wired to BOTH chat widgets on the
// page: the small teaser on the homepage (#chatInput/#chatSend/
// #chatMessages) and the full-screen one on the AI Assistant
// page (#chatInput2/#chatSend2/#chatMessages2). Each keeps its
// own conversation history so the two widgets don't mix.
// ============================================================
let currentLang = 'ru';

function createChatController(inputId, sendId, messagesId) {
  const input = document.getElementById(inputId);
  const send = document.getElementById(sendId);
  const messages = document.getElementById(messagesId);
  if (!input || !send || !messages) return null;

  const history = []; // [{role:'user'|'assistant', content:'...'}]

  function addMessage(text, isUser = false) {
    const div = document.createElement('div');
    div.className = isUser
      ? 'bubble-user rounded-lg rounded-tr-none px-3.5 py-2.5 max-w-[85%] text-sm ml-auto'
      : 'bubble-ai rounded-lg rounded-tl-none px-3.5 py-2.5 max-w-[85%] text-sm';
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function showTyping() {
    const div = document.createElement('div');
    div.className = 'typingIndicator bubble-ai rounded-lg rounded-tl-none px-3.5 py-2.5 max-w-[85%] text-sm flex gap-1 items-center';
    div.innerHTML = '<span class="typing-dot w-1.5 h-1.5 bg-blue rounded-full"></span><span class="typing-dot w-1.5 h-1.5 bg-blue rounded-full"></span><span class="typing-dot w-1.5 h-1.5 bg-blue rounded-full"></span>';
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  async function handleChat() {
    const text = input.value.trim();
    if (!text) return;
    addMessage(text, true);
    history.push({ role: 'user', content: text });
    input.value = '';
    input.disabled = true;
    send.disabled = true;
    const typingEl = showTyping();

    try {
      const res = await fetch(`${API_BASE}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, lang: currentLang })
      });
      if (!res.ok) throw new Error('Bad response: ' + res.status);
      const data = await res.json();
      typingEl.remove();
      const reply = data.reply || '...';
      addMessage(reply, false);
      history.push({ role: 'assistant', content: reply });

      // Backend sets rfq_ready:true once it has collected enough
      // details to file an RFQ; it also handles Telegram/Email
      // notification server-side, nothing else to do here.
      if (data.rfq_ready) {
        addMessage(
          currentLang === 'en' ? 'Your request has been forwarded to our team and Telegram bot. We will contact you shortly.' :
          currentLang === 'uz' ? "So'rovingiz jamoamizga va Telegram botga yuborildi. Tez orada bog'lanamiz." :
          currentLang === 'zh' ? '您的请求已发送给我们的团队和Telegram机器人。我们会尽快与您联系。' :
          'Ваша заявка передана нашей команде и в Telegram бот. Мы свяжемся с вами в ближайшее время.',
          false
        );
      }
    } catch (err) {
      typingEl.remove();
      addMessage(
        currentLang === 'en' ? 'Sorry, something went wrong. Please try again or contact us via WhatsApp/Telegram.' :
        currentLang === 'uz' ? 'Kechirasiz, xatolik yuz berdi. Qayta urinib ko\'ring yoki WhatsApp/Telegram orqali bog\'laning.' :
        currentLang === 'zh' ? '抱歉，出现了问题。请重试，或通过WhatsApp/Telegram联系我们。' :
        'Извините, произошла ошибка. Попробуйте ещё раз или свяжитесь с нами через WhatsApp/Telegram.',
        false
      );
      console.error('Chat error:', err);
    } finally {
      input.disabled = false;
      send.disabled = false;
      input.focus();
    }
  }

  send.addEventListener('click', handleChat);
  input.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleChat(); });
  return { handleChat };
}

createChatController('chatInput', 'chatSend', 'chatMessages');           // homepage teaser widget
createChatController('chatInput2', 'chatSend2', 'chatMessages2');        // full-screen /ai-assistant widget

// ============================================================
// RFQ FORM — real submission to backend (POST {API_BASE}/rfq)
// The backend saves the request and notifies Telegram + Email.
// ============================================================
document.getElementById('rfqForm')?.addEventListener('submit', async function(e) {
  e.preventDefault();
  const form = this;
  const btn = form.querySelector('button[type="submit"]');
  const originalText = btn.innerHTML;
  const sendingText = (translations[currentLang] && translations[currentLang]['rfq.sending']) || translations.ru['rfq.sending'];
  btn.innerHTML = '<span class="animate-pulse">' + sendingText + '</span>';
  btn.disabled = true;

  const val = (id) => document.getElementById(id)?.value || '';
  const urgencyEl = form.querySelector('input[name="urg"]:checked');
  const urgencyLabels = ['express', 'standard', 'economy'];
  const urgencyInputs = Array.from(form.querySelectorAll('input[name="urg"]'));
  const urgencyIndex = urgencyEl ? urgencyInputs.indexOf(urgencyEl) : 1;

  const payload = {
    lang: currentLang,
    fullName: val('fullName'),
    company: val('company'),
    phoneCountryCode: val('phoneCountryCode'),
    phoneNumber: val('phoneNumber'),
    email: val('email'),
    origin: val('origin'),
    destination: val('destination'),
    cargoType: val('cargoType'),
    weight: val('weight'),
    pieces: val('pieces'),
    dimensions: val('dimensions'),
    incoterms: val('incoterms'),
    urgency: urgencyLabels[urgencyIndex] || 'standard',
    cargoReadyDate: val('cargoReadyDate'),
    specialRequirements: val('specialRequirements'),
    cargoDescription: val('cargoDescription'),
  };

  try {
    const res = await fetch(`${API_BASE}/rfq`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Bad response: ' + res.status);
    form.style.display = 'none';
    document.getElementById('rfqSuccess').classList.remove('hidden');
  } catch (err) {
    console.error('RFQ submit error:', err);
    btn.innerHTML = originalText;
    btn.disabled = false;
    alert(
      currentLang === 'en' ? 'Something went wrong sending your request. Please try again or contact us via WhatsApp/Telegram.' :
      currentLang === 'uz' ? "So'rovni yuborishda xatolik yuz berdi. Qayta urinib ko'ring yoki WhatsApp/Telegram orqali bog'laning." :
      currentLang === 'zh' ? '发送请求时出错。请重试，或通过WhatsApp/Telegram联系我们。' :
      'Произошла ошибка при отправке заявки. Попробуйте ещё раз или свяжитесь с нами через WhatsApp/Telegram.'
    );
  }
});

// Translations
const translations = {
  ru: {
    'hdr.sub': 'Авиакарго · Транзит · Центральная Азия',
    'nav.network': 'Сеть маршрутов', 'nav.services': 'Услуги', 'nav.gulf': 'Персидский залив',
    'nav.cases': 'Кейсы', 'nav.ai': 'AI Ассистент', 'nav.contacts': 'Контакты',
    'cta.quote': 'Запросить тариф',
    'hero.eyebrow': 'Ташкент · С 2017 года · Стандарты IATA',
    'hero.title': 'Международные <span class="text-blue">авиационные</span> и <span class="text-blue">транзитные</span> грузоперевозки через Центральную Азию',
    'hero.sub': 'SPECIAL CARGO SERVICES предоставляет комплексные решения в сфере международных авиаперевозок, экспортной логистики, транзитных операций, e-commerce, таможенного сопровождения и мультимодальных перевозок через Узбекистан и Центральную Азию.',
    'hero.cta1': 'Получить тариф', 'hero.cta2': 'AI Cargo Assistant',
    'kpi.years': 'лет работы', 'kpi.ship': 'отправлений', 'kpi.dest': 'направлений', 'kpi.ops': 'операции',
    'ops.note': 'Interline · 20+ перевозчиков',
    'trust.rating': 'Рейтинг клиентов', 'trust.iata': 'Сертифицированная команда', 'trust.gdp': 'Соответствие для фармы', 'trust.support': 'Поддержка',
    'network.title': 'Транзитные коридоры <span class="text-blue">через Ташкент</span>',
    'network.sub': 'Ключевые маршруты в Персидский залив, Китай, Европу и СНГ. Air-to-Air, Air-to-Truck, мультимодальные решения.',
    'corr.cn_eu': 'Китай → Европа через TAS', 'corr.cn_eu_desc': 'Air-to-Air · Air-to-Truck',
    'corr.cn_gulf': 'Китай → Ближний Восток', 'corr.cn_gulf_desc': 'Air · Мультимодаль',
    'corr.uae_cis': 'Дубай → Ташкент → СНГ', 'corr.uae_cis_desc': 'Прямые ежедневные рейсы',
    'corr.ksa_ca': 'Эр-Рияд / Джидда → TAS', 'corr.ksa_ca_desc': 'Регулярные карго',
    'corr.qa_uz': 'Доха → TAS · Qatar Cargo', 'corr.qa_uz_desc': 'Прямое партнёрство',
    'corr.kr_ca': 'Сеул (ICN) → TAS → СНГ', 'corr.kr_ca_desc': 'Партнёрство Korean Air',
    'corr.eu_ca': 'Европа → Центральная Азия', 'corr.eu_ca_desc': 'Air-to-Truck · Мультимодаль',
    'corr.cis_dist': 'Распределение СНГ', 'corr.cis_dist_desc': 'KZ · KG · TJ · TM · Кавказ',
    'corr.ww': 'Весь мир', 'corr.ww_desc': 'Interline-партнёры',
    'svc.title': '12 направлений <span class="text-blue">карго-логистики</span>',
    'svc.sub': 'От авиаперевозок и Dangerous Goods до e-commerce, фармы и Project Cargo. Полный цикл под ключ.',
    's1.t': 'Авиаперевозки', 's1.d': 'Регулярные и чартерные рейсы, консолидация, экспресс-транзит через ТAS.',
    's2.t': 'Экспорт из Узбекистана', 's2.d': 'Полное сопровождение экспорта: документы, таможня, отгрузка.',
    's3.t': 'Транзит через Узбекистан', 's3.d': 'Ташкент как хаб: Air-to-Air, Air-to-Truck, мультимодаль.',
    's4.t': 'Персидский залив', 's4.d': 'Персидский залив и Ближний Восток: DXB, JED, DOH, RUH, KWI, BAH, MCT, TLV.',
    's5.t': 'E-commerce логистика', 's5.d': 'Last-mile для маркетплейсов и онлайн-магазинов. Быстрый транзит.',
    's6.t': 'DG Cargo', 's6.d': 'Опасные грузы по стандарту IATA DGR. Сертифицированные специалисты.',
    's7.t': 'Фарма-логистика', 's7.d': 'Холодовая цепь 2–8°C, мониторинг температуры, GDP стандарт.',
    's8.t': 'Airport Handling', 's8.d': 'Обработка грузов в аэропорту TAS. ULD, консолидация, разгрузка.',
    's9.t': 'Таможенное оформление', 's9.d': 'Полное таможенное оформление. Экспорт, импорт, транзит.',
    's10.t': 'Project Cargo', 's10.d': 'Негабаритные и проектные грузы. Индивидуальные решения.',
    's11.t': 'СНГ и Центральная Азия', 's11.d': 'KZ, KG, TJ, TM, Кавказ. Мультимодальная доставка.',
    's12.t': 'Чартерные решения', 's12.d': 'Чартерные рейсы под индивидуальный заказ. Full-freighter, part-charter.',
    'gulf.title': 'Персидский залив <br>и <span class="text-gold">Ближний Восток</span>',
    'gulf.text': 'SPECIAL CARGO SERVICES организует международные грузоперевозки в страны Персидского залива и Ближнего Востока через Узбекистан и Центральную Азию — авиационные, транзитные и мультимодальные решения для грузов различных категорий.',
    'gulf.cta': 'Запросить тариф на Gulf',
    'gulf.f1': 'Air-to-Air решения', 'gulf.f1d': 'Прямые авиа-стыковки через TAS hub',
    'gulf.f2': 'Консолидация грузов', 'gulf.f2d': 'Консолидация грузов на TAS',
    'gulf.f3': 'DDP / DAP доставка', 'gulf.f3d': 'Доставка с полным таможенным оформлением',
    'gulf.f4': 'Таможенное сопровождение', 'gulf.f4d': 'Полное таможенное сопровождение',
    'gulf.f5': 'Транзит через Ташкент', 'gulf.f5d': 'Использование хаба TAS как центра перевалки',
    'gulf.f6': 'Мультимодальная логистика', 'gulf.f6d': 'Комбинированные схемы Air + Road',
    'why.title': 'Почему <span class="text-blue">Ташкент</span> — стратегический карго-хаб?',
    'why.1t': 'Географический центр', 'why.1d': 'На пересечении маршрутов Китай ↔ Европа и Восток ↔ Запад. 5 часов лёта до 60% мирового ВВП.',
    'why.2t': 'Открытое небо', 'why.2d': 'Либерализация авиасектора. Регулярные рейсы с 20+ карго-перевозчиками.',
    'why.3t': 'Карго-терминал TAS', 'why.3d': 'Современный терминал с холодовыми зонами, DG-хендлингом и 24/7 операциями.',
    'why.4t': 'Быстрая таможня', 'why.4d': 'Ускоренные транзитные процедуры для авиагрузов. Упрощённое оформление.',
    'air.title': 'Прямые контракты и sub-agency', 'air.sub': 'Мгновенный доступ к stock AWB и регулярным рейсам',
    'cases.title': 'Реальные <span class="text-blue">кейсы</span>',
    'cases.sub': 'Типовые проекты: маршрут, вес, сроки, результат. KPI по каждому.',
    'case1.tag': 'ЭЛЕКТРОНИКА · КОНСОЛИДИРОВАННО', 'case1.title': 'Куала-Лумпур → Ташкент',
    'case1.k1': 'Груз', 'case1.k2': 'Транзит', 'case1.k3': 'Результат',
    'case2.tag': 'ФАРМА · ХОЛОДОВАЯ ЦЕПЬ', 'case2.title': 'Мумбаи → Ташкент',
    'case2.k1': 'Груз', 'case2.k2': 'Транзит', 'case2.k3': 'Результат',
    'case3.tag': 'GULF · ЦЕННЫЙ ГРУЗ', 'case3.title': 'Дубай → Ташкент',
    'case3.k1': 'Груз', 'case3.k2': 'Транзит', 'case3.k3': 'Результат',
    'ai.title': 'Тариф за <span class="text-blue">5 минут</span>. С помощью AI.',
    'ai.text': 'AI Cargo Assistant принимает RFQ 24/7, классифицирует тип груза, собирает данные о маршруте и передаёт заявку менеджеру и в Telegram. Работает на RU и EN.',
    'ai.p1': 'Claude API — умная классификация типа груза',
    'ai.p2': 'Автоматический сбор данных: маршрут, вес, размеры',
    'ai.p3': 'Уведомления в Telegram + Email',
    'ai.p4': 'RU / EN сейчас · ZH скоро',
    'ai.cta': 'Открыть AI Ассистента',
    'ai.chat1': 'Здравствуйте! Я AI Cargo Assistant. Расскажите о вашем грузе, и я помогу с расчётом тарифа. Откуда отправляем и куда?',
    'rfq.title': 'Онлайн запрос <span class="text-blue">тарифа</span>',
    'rfq.sub': 'Укажите маршрут, тип груза и контакты — свяжемся в течение 24 часов с КП, договором и оплатой.',
    'rfq.s1': 'КОНТАКТНАЯ ИНФОРМАЦИЯ', 'rfq.s2': 'МАРШРУТ', 'rfq.s3': 'ДЕТАЛИ ГРУЗА', 'rfq.s4': 'УСЛОВИЯ И СРОКИ',
    'rfq.f1': 'ФИО *', 'rfq.f2': 'Компания', 'rfq.f3': 'Телефон / WhatsApp *', 'rfq.f4': 'Email',
    'rfq.f5': 'Откуда (город / аэропорт)', 'rfq.f6': 'Куда (город / аэропорт)',
    'rfq.f7': 'Тип груза', 'rfq.f8': 'Вес (кг)', 'rfq.f9': 'Количество мест', 'rfq.f10': 'Размеры Д×Ш×В (см)',
    'rfq.f11': 'Incoterms', 'rfq.f12': 'Срочность', 'rfq.f13': 'Дата готовности', 'rfq.f14': 'Специальные требования',
    'rfq.f15': 'Описание груза',
    'rfq.ct0': '— выберите —', 'rfq.ct1': 'Обычный', 'rfq.ct2': 'Опасный (DG)', 'rfq.ct3': 'Фарма / GDP',
    'rfq.ct4': 'Ценный', 'rfq.ct5': 'E-commerce', 'rfq.ct6': 'Проект / негабарит', 'rfq.ct7': 'Живые животные',
    'rfq.u1': 'Срочно', 'rfq.u2': 'Стандарт', 'rfq.u3': 'Экономно',
    'rfq.protect': 'Защищено reCAPTCHA · Данные конфиденциальны',
    'rfq.submit': 'Получить тариф за 5 минут',
    'faq.title': 'Часто задаваемые вопросы',
    'faq.q1': 'Как быстро я получу предложение по тарифу?',
    'faq.a1': 'В течение 5–15 минут через AI Assistant. Для сложных грузов — до 2–4 часов от менеджера.',
    'faq.q2': 'Работаете ли вы с опасными грузами (DG)?',
    'faq.a2': 'Да. Наши специалисты сертифицированы по IATA DGR, работаем со всеми классами опасности.',
    'faq.q3': 'Какие способы оплаты доступны?',
    'faq.a3': 'Банковский перевод, Click, Payme, корпоративный счёт. Все документы оформляются официально.',
    'faq.q4': 'Есть ли минимальный вес груза?',
    'faq.a4': 'Минимальный расчётный вес зависит от направления, обычно 45–100 кг.',
    'faq.q5': 'Работаете ли вы со странами Персидского залива?',
    'faq.a5': 'Да, это одно из наших стратегических направлений. ОАЭ, Саудовская Аравия, Катар, Кувейт, Бахрейн, Оман, Иордания, Израиль.',
    'ftr.about': 'Международные авиаперевозки и транзитная логистика через Ташкент. IATA стандарты, GDP compliant, 24/7 support.',
    'ftr.nav': 'Навигация', 'ftr.svc': 'Услуги', 'ftr.contact': 'Контакты',
    'ftr.strip': 'Авиаперевозки │ Экспорт из Узбекистана │ Транзит через Ташкент │ Персидский залив │ E-commerce │ DG Cargo │ Worldwide Delivery │ 24/7 Support',
    'chat.placeholder': 'Спросите о вашем грузе...',
    'rfq.ph_special': 'Холодовая цепь / охрана / и т.д.',
    'rfq.ph_desc': 'Дополнительные детали...',
    'rfq.sending': 'Отправка...',
    'rfq.success_title': 'Заявка получена',
    'rfq.success_text': 'Ваша заявка отправлена нашей команде и в Telegram бот. Мы свяжемся с вами в ближайшее время.',
    'aip.back': '← На главную',
    'aip.eyebrow': 'AI CARGO ASSISTANT · ПОЛНЫЙ ЭКРАН',
    'aip.title': 'Тариф за <span class="text-blue">5 минут</span> — без ожидания менеджера',
    'aip.sub': 'Опишите груз, маршрут и сроки — AI Cargo Assistant классифицирует тип груза, соберёт нужные детали и передаст заявку менеджеру и в Telegram. Работает 24/7 на RU и EN, ZH — скоро.',
    'aip.panel_title': 'AI CARGO ASSISTANT',
    'aip.how_title': 'Как это работает',
    'aip.step1_t': 'Опишите груз',
    'aip.step1_d': 'Расскажите откуда и куда, какой груз, вес и сроки — в свободной форме.',
    'aip.step2_t': 'AI уточняет детали',
    'aip.step2_d': 'Ассистент классифицирует тип груза и задаёт уточняющие вопросы по маршруту и Incoterms.',
    'aip.step3_t': 'Заявка передаётся команде',
    'aip.step3_d': 'Готовый RFQ уходит менеджеру и в Telegram бот. Ответ — в течение 2–4 часов.',
    'aip.cta_rfq': 'Заполнить полную RFQ форму',
    'aip.disclaimer': 'Защищено reCAPTCHA · Данные конфиденциальны · Реальная интеграция с Claude API',
  },
  en: {
    'hdr.sub': 'Air Cargo · Transit · Central Asia',
    'nav.network': 'Global Network', 'nav.services': 'Services', 'nav.gulf': 'Gulf & Middle East',
    'nav.cases': 'Case Studies', 'nav.ai': 'AI Assistant', 'nav.contacts': 'Contacts',
    'cta.quote': 'Request Quote',
    'hero.eyebrow': 'Tashkent · Since 2017 · IATA Standards',
    'hero.title': 'International <span class="text-blue">Air Cargo</span> & <span class="text-blue">Transit Solutions</span> Across Central Asia',
    'hero.sub': 'SPECIAL CARGO SERVICES provides international air freight, export, transit and specialized cargo solutions across Central Asia through operational coordination, airline connectivity and flexible logistics support.',
    'hero.cta1': 'Get a Quote', 'hero.cta2': 'AI Cargo Assistant',
    'kpi.years': 'years operating', 'kpi.ship': 'shipments', 'kpi.dest': 'destinations', 'kpi.ops': 'operations',
    'ops.note': 'Interline network · 20+ carriers',
    'trust.rating': 'Client rating', 'trust.iata': 'Certified team', 'trust.gdp': 'Pharma compliant', 'trust.support': 'Support',
    'network.title': 'Transit corridors <span class="text-blue">via Tashkent</span>',
    'network.sub': 'Key routes to Gulf, China, Europe and CIS. Air-to-Air, Air-to-Truck, multimodal solutions.',
    'corr.cn_eu': 'China → Europe via TAS', 'corr.cn_eu_desc': 'Air-to-Air · Air-to-Truck',
    'corr.cn_gulf': 'China → Middle East', 'corr.cn_gulf_desc': 'Air · Multimodal',
    'corr.uae_cis': 'Dubai → Tashkent → CIS', 'corr.uae_cis_desc': 'Direct daily flights',
    'corr.ksa_ca': 'Riyadh / Jeddah → TAS', 'corr.ksa_ca_desc': 'Regular cargo',
    'corr.qa_uz': 'Doha → TAS · Qatar Cargo', 'corr.qa_uz_desc': 'Direct partnership',
    'corr.kr_ca': 'Seoul (ICN) → TAS → CIS', 'corr.kr_ca_desc': 'Korean Air partnership',
    'corr.eu_ca': 'Europe → Central Asia', 'corr.eu_ca_desc': 'Air-to-Truck · Multimodal',
    'corr.cis_dist': 'CIS Distribution', 'corr.cis_dist_desc': 'KZ · KG · TJ · TM · Caucasus',
    'corr.ww': 'Worldwide', 'corr.ww_desc': 'Interline partners',
    'svc.title': '12 <span class="text-blue">cargo logistics</span> services',
    'svc.sub': 'From air freight and Dangerous Goods to e-commerce, pharma and Project Cargo. Full turnkey cycle.',
    's1.t': 'Air Freight', 's1.d': 'Regular and charter flights, consolidation, express transit via TAS.',
    's2.t': 'Export from Uzbekistan', 's2.d': 'Full export support: documents, customs, shipment.',
    's3.t': 'Transit via Uzbekistan', 's3.d': 'Tashkent as hub: Air-to-Air, Air-to-Truck, multimodal.',
    's4.t': 'Gulf & Middle East', 's4.d': 'Persian Gulf and Middle East: DXB, JED, DOH, RUH, KWI, BAH, MCT, TLV.',
    's5.t': 'E-commerce Logistics', 's5.d': 'Last-mile for marketplaces and online shops. Fast transit.',
    's6.t': 'DG Cargo', 's6.d': 'Dangerous Goods per IATA DGR. Certified specialists.',
    's7.t': 'Pharma Logistics', 's7.d': 'Cold chain 2–8°C, temperature monitoring, GDP standard.',
    's8.t': 'Airport Handling', 's8.d': 'Cargo handling at TAS. ULD, consolidation, unloading.',
    's9.t': 'Customs Clearance', 's9.d': 'Full customs clearance. Export, import, transit.',
    's10.t': 'Project Cargo', 's10.d': 'Oversized and project cargo. Custom solutions.',
    's11.t': 'CIS & Central Asia', 's11.d': 'KZ, KG, TJ, TM, Caucasus. Multimodal delivery.',
    's12.t': 'Charter Solutions', 's12.d': 'Charter flights on demand. Full-freighter, part-charter.',
    'gulf.title': 'Gulf and <span class="text-gold">Middle East</span>',
    'gulf.text': 'SPECIAL CARGO SERVICES organizes international cargo transportation to Gulf and Middle East destinations through Uzbekistan and Central Asia, providing airfreight, transit and multimodal logistics solutions.',
    'gulf.cta': 'Request Gulf Route Quote',
    'gulf.f1': 'Air-to-Air solutions', 'gulf.f1d': 'Direct air connections via TAS hub',
    'gulf.f2': 'Cargo consolidation', 'gulf.f2d': 'Consolidation at TAS',
    'gulf.f3': 'DDP / DAP deliveries', 'gulf.f3d': 'Delivery with full customs clearance',
    'gulf.f4': 'Customs coordination', 'gulf.f4d': 'Full customs support',
    'gulf.f5': 'Transit via Tashkent', 'gulf.f5d': 'Using TAS hub as transshipment center',
    'gulf.f6': 'Multimodal logistics', 'gulf.f6d': 'Combined Air + Road schemes',
    'why.title': 'Why <span class="text-blue">Tashkent</span> — a strategic cargo hub?',
    'why.1t': 'Geographic Pivot', 'why.1d': 'At the crossroads of China ↔ Europe and East ↔ West routes. 5-hour flight to 60% of world GDP.',
    'why.2t': 'Open Skies Policy', 'why.2d': 'Aviation sector liberalization. Regular flights with 20+ cargo carriers.',
    'why.3t': 'TAS Cargo Terminal', 'why.3d': 'Modern terminal with cold zones, DG handling and 24/7 operations.',
    'why.4t': 'Fast Customs', 'why.4d': 'Expedited transit procedures for air cargo. Simplified clearance.',
    'air.title': 'Direct contracts and sub-agency', 'air.sub': 'Instant access to stock AWB and regular flights',
    'cases.title': 'Real <span class="text-blue">case studies</span>',
    'cases.sub': 'Typical projects: route, weight, transit time, result. KPI for each.',
    'case1.tag': 'ELECTRONICS · CONSOLIDATED', 'case1.title': 'Kuala Lumpur → Tashkent',
    'case1.k1': 'Cargo', 'case1.k2': 'Transit', 'case1.k3': 'Result',
    'case2.tag': 'PHARMA · COLD CHAIN', 'case2.title': 'Mumbai → Tashkent',
    'case2.k1': 'Cargo', 'case2.k2': 'Transit', 'case2.k3': 'Result',
    'case3.tag': 'GULF · VALUABLE', 'case3.title': 'Dubai → Tashkent',
    'case3.k1': 'Cargo', 'case3.k2': 'Transit', 'case3.k3': 'Result',
    'ai.title': 'Quote in <span class="text-blue">5 minutes</span>. Powered by AI.',
    'ai.text': 'AI Cargo Assistant handles RFQ 24/7, classifies cargo type, collects route data and forwards to manager and Telegram. Works in EN and RU.',
    'ai.p1': 'Claude API — smart cargo type classification',
    'ai.p2': 'Automatic data collection: route, weight, dimensions',
    'ai.p3': 'Telegram + Email notifications',
    'ai.p4': 'EN / RU now · ZH coming soon',
    'ai.cta': 'Launch AI Assistant',
    'ai.chat1': "Hello! I'm the AI Cargo Assistant. Tell me about your cargo, and I'll help with a rate quote. Where are we shipping from and to?",
    'rfq.title': 'Online <span class="text-blue">rate</span> request',
    'rfq.sub': 'Specify route, cargo type and contacts — we\'ll respond within 24 hours with a quote, contract and payment.',
    'rfq.s1': 'CONTACT INFO', 'rfq.s2': 'ROUTE', 'rfq.s3': 'CARGO DETAILS', 'rfq.s4': 'TERMS & TIMING',
    'rfq.f1': 'Full name *', 'rfq.f2': 'Company', 'rfq.f3': 'Phone / WhatsApp *', 'rfq.f4': 'Email',
    'rfq.f5': 'Origin (city / airport)', 'rfq.f6': 'Destination (city / airport)',
    'rfq.f7': 'Cargo type', 'rfq.f8': 'Weight (kg)', 'rfq.f9': 'Number of pieces', 'rfq.f10': 'Dimensions L×W×H (cm)',
    'rfq.f11': 'Incoterms', 'rfq.f12': 'Urgency', 'rfq.f13': 'Cargo ready date', 'rfq.f14': 'Special requirements',
    'rfq.f15': 'Cargo description',
    'rfq.ct0': '— select —', 'rfq.ct1': 'General', 'rfq.ct2': 'Dangerous Goods (DG)', 'rfq.ct3': 'Pharma / GDP',
    'rfq.ct4': 'Valuable', 'rfq.ct5': 'E-commerce', 'rfq.ct6': 'Project / Oversized', 'rfq.ct7': 'Live animals',
    'rfq.u1': 'Express', 'rfq.u2': 'Standard', 'rfq.u3': 'Economy',
    'rfq.protect': 'Protected by reCAPTCHA · Data confidential',
    'rfq.submit': 'Get quote in 5 minutes',
    'faq.title': 'Frequently Asked Questions',
    'faq.q1': 'How quickly will I get a rate quote?',
    'faq.a1': 'Within 5–15 minutes via AI Assistant. For complex cargo — up to 2–4 hours from a manager.',
    'faq.q2': 'Do you work with Dangerous Goods (DG)?',
    'faq.a2': 'Yes. Our specialists are IATA DGR certified, we work with all hazard classes.',
    'faq.q3': 'What payment methods are available?',
    'faq.a3': 'Bank transfer, Click, Payme, corporate account. All documents are officially processed.',
    'faq.q4': 'Is there a minimum cargo weight?',
    'faq.a4': 'Minimum chargeable weight depends on route, typically 45–100 kg.',
    'faq.q5': 'Do you operate in the Persian Gulf?',
    'faq.a5': 'Yes, this is one of our strategic directions. UAE, Saudi Arabia, Qatar, Kuwait, Bahrain, Oman, Jordan, Israel.',
    'ftr.about': 'International air freight and transit logistics via Tashkent. IATA standards, GDP compliant, 24/7 support.',
    'ftr.nav': 'Navigation', 'ftr.svc': 'Services', 'ftr.contact': 'Contact',
    'ftr.strip': 'Air Freight │ Export from Uzbekistan │ Transit via Tashkent │ Gulf & Middle East │ E-commerce │ DG Cargo │ Worldwide Delivery │ 24/7 Support',
    'chat.placeholder': 'Ask about your cargo...',
    'rfq.ph_special': 'Cold chain / secured / etc.',
    'rfq.ph_desc': 'Any additional details...',
    'rfq.sending': 'Sending...',
    'rfq.success_title': 'RFQ Received',
    'rfq.success_text': 'Your request has been sent to our team and Telegram bot. We will contact you shortly.',
    'aip.back': '← Back to home',
    'aip.eyebrow': 'AI CARGO ASSISTANT · FULL SCREEN',
    'aip.title': 'Quote in <span class="text-blue">5 minutes</span> — no need to wait for a manager',
    'aip.sub': 'Describe your cargo, route and timing — AI Cargo Assistant classifies the cargo type, gathers the details it needs and passes the request to a manager and Telegram. Available 24/7 in RU and EN, ZH coming soon.',
    'aip.panel_title': 'AI CARGO ASSISTANT',
    'aip.how_title': 'How it works',
    'aip.step1_t': 'Describe your cargo',
    'aip.step1_d': 'Tell us the origin, destination, cargo type, weight and timing — in your own words.',
    'aip.step2_t': 'AI clarifies the details',
    'aip.step2_d': 'The assistant classifies the cargo type and asks follow-up questions about route and Incoterms.',
    'aip.step3_t': 'Request goes to the team',
    'aip.step3_d': 'The finished RFQ is sent to a manager and our Telegram bot. Response within 2–4 hours.',
    'aip.cta_rfq': 'Fill in the full RFQ form',
    'aip.disclaimer': 'Protected by reCAPTCHA · Data confidential · Real integration with Claude API',
  },
  uz: {
    'hdr.sub': 'Aviakargo · Tranzit · Markaziy Osiyo',
    'nav.network': 'Global tarmoq', 'nav.services': 'Xizmatlar', 'nav.gulf': 'Fors ko\'rfazi',
    'nav.cases': 'Keyslar', 'nav.ai': 'AI Yordamchi', 'nav.contacts': 'Kontaktlar',
    'cta.quote': 'Tarif so\'rash',
    'hero.eyebrow': 'Toshkent · 2017 yildan · IATA standartlari',
    'hero.title': 'Markaziy Osiyo orqali <span class="text-blue">xalqaro aviatsiya</span> va <span class="text-blue">tranzit</span> yuk tashish',
    'hero.sub': 'SPECIAL CARGO SERVICES O\'zbekiston va Markaziy Osiyo orqali xalqaro aviaqatnov, eksport logistika, tranzit operatsiyalar, e-commerce, bojxona hamrohligi va multimodal xizmatlarni ko\'rsatadi.',
    'hero.cta1': 'Tarif olish', 'hero.cta2': 'AI Cargo Assistant',
    'kpi.years': 'yillik tajriba', 'kpi.ship': 'jo\'natma', 'kpi.dest': 'yo\'nalish', 'kpi.ops': 'operatsiyalar',
    'ops.note': 'Interline · 20+ tashuvchi',
    'trust.rating': 'Mijozlar reytingi', 'trust.iata': 'Sertifikatli jamoa', 'trust.gdp': 'Farma mos', 'trust.support': 'Qo\'llab-quvvatlash',
    'network.title': 'Toshkent orqali <span class="text-blue">tranzit koridorlar</span>',
    'network.sub': 'Fors ko\'rfazi, Xitoy, Yevropa va MDH ga asosiy yo\'nalishlar. Air-to-Air, Air-to-Truck, multimodal.',
    'svc.title': '12 ta <span class="text-blue">kargo-logistika</span> yo\'nalishi',
    'svc.sub': 'Aviaqatnov va Dangerous Goods dan e-commerce, farma va Project Cargo gacha. To\'liq siklda.',
    's1.t': 'Aviaqatnov', 's4.t': 'Fors ko\'rfazi va Yaqin Sharq',
    'gulf.title': 'Fors ko\'rfazi <br>va <span class="text-gold">Yaqin Sharq</span>',
    'gulf.cta': 'Gulf tarifini so\'rash',
    'why.title': 'Nima uchun <span class="text-blue">Toshkent</span> — strategik kargo-hub?',
    'cases.title': 'Haqiqiy <span class="text-blue">keyslar</span>',
    'ai.title': '<span class="text-blue">5 daqiqada</span> tarif. AI yordamida.',
    'ai.cta': 'AI Yordamchini ochish',
    'rfq.title': 'Onlayn <span class="text-blue">tarif</span> so\'rovi',
    'rfq.submit': '5 daqiqada tarif olish',
    'faq.title': 'Tez-tez so\'raladigan savollar',
    'ftr.nav': 'Navigatsiya', 'ftr.svc': 'Xizmatlar', 'ftr.contact': 'Kontaktlar',
    'ai.text': 'AI Cargo Assistant 24/7 rejimida RFQ qabul qiladi, yuk turini klassifikatsiya qiladi, marshrut ma\'lumotlarini yig\'adi va menejer hamda Telegram\'ga yuboradi. RU va EN tillarida ishlaydi.',
    'ai.p1': 'Claude API — yuk turini aqlli klassifikatsiya qilish',
    'ai.p2': 'Avtomatik ma\'lumot yig\'ish: marshrut, og\'irlik, o\'lchamlar',
    'ai.p3': 'Telegram + Email orqali bildirishnomalar',
    'ai.p4': 'Hozircha RU / EN · ZH tez orada',
    'ai.chat1': 'Assalomu alaykum! Men AI Cargo Assistantman. Yukingiz haqida gapirib bering, tarifni hisoblashda yordam beraman. Qayerdan qayerga jo\'natyapmiz?',
    'air.title': 'To\'g\'ridan-to\'g\'ri shartnomalar va sub-agentlik',
    'air.sub': 'Stock AWB va muntazam reyslarga tezkor kirish',
    'case1.tag': 'ELEKTRONIKA · KONSOLIDATSIYALANGAN',
    'case1.title': 'Kuala-Lumpur → Toshkent',
    'case1.k1': 'Yuk',
    'case1.k2': 'Tranzit',
    'case1.k3': 'Natija',
    'case2.tag': 'FARMA · SOVUQ ZANJIR',
    'case2.title': 'Mumbay → Toshkent',
    'case2.k1': 'Yuk',
    'case2.k2': 'Tranzit',
    'case2.k3': 'Natija',
    'case3.tag': 'GULF · QIMMATBAHO YUK',
    'case3.title': 'Dubay → Toshkent',
    'case3.k1': 'Yuk',
    'case3.k2': 'Tranzit',
    'case3.k3': 'Natija',
    'cases.sub': 'Tipik loyihalar: marshrut, og\'irlik, muddat, natija. Har biri uchun KPI.',
    'corr.cis_dist': 'MDH bo\'ylab tarqatish',
    'corr.cis_dist_desc': 'QZ · QQ · TJ · TM · Kavkaz',
    'corr.cn_eu': 'Xitoy → Yevropa (TAS orqali)',
    'corr.cn_eu_desc': 'Air-to-Air · Air-to-Truck',
    'corr.cn_gulf': 'Xitoy → Yaqin Sharq',
    'corr.cn_gulf_desc': 'Aviatsiya · Multimodal',
    'corr.eu_ca': 'Yevropa → Markaziy Osiyo',
    'corr.eu_ca_desc': 'Air-to-Truck · Multimodal',
    'corr.kr_ca': 'Seul (ICN) → TAS → MDH',
    'corr.kr_ca_desc': 'Korean Air hamkorligi',
    'corr.ksa_ca': 'Er-Riyod / Jidda → TAS',
    'corr.ksa_ca_desc': 'Muntazam kargo',
    'corr.qa_uz': 'Doha → TAS · Qatar Cargo',
    'corr.qa_uz_desc': 'To\'g\'ridan-to\'g\'ri hamkorlik',
    'corr.uae_cis': 'Dubay → Toshkent → MDH',
    'corr.uae_cis_desc': 'To\'g\'ridan-to\'g\'ri kunlik reyslar',
    'corr.ww': 'Butun dunyo bo\'ylab',
    'corr.ww_desc': 'Interline hamkorlari',
    'faq.a1': 'AI Assistant orqali 5–15 daqiqa ichida. Murakkab yuklar uchun — menejerdan 2–4 soatgacha.',
    'faq.a2': 'Ha. Mutaxassislarimiz IATA DGR bo\'yicha sertifikatlangan, barcha xavf sinflari bilan ishlaymiz.',
    'faq.a3': 'Bank o\'tkazmasi, Click, Payme, korporativ hisob raqami. Barcha hujjatlar rasmiy tartibda rasmiylashtiriladi.',
    'faq.a4': 'Minimal hisob-kitob og\'irligi yo\'nalishga bog\'liq, odatda 45–100 kg.',
    'faq.a5': 'Ha, bu bizning strategik yo\'nalishlarimizdan biri. BAA, Saudiya Arabistoni, Qatar, Kuvayt, Bahrayn, Ummon, Iordaniya, Isroil.',
    'faq.q1': 'Tarif taklifini qanchalik tez olaman?',
    'faq.q2': 'Xavfli yuklar (DG) bilan ishlaysizmi?',
    'faq.q3': 'Qanday to\'lov usullari mavjud?',
    'faq.q4': 'Yukning minimal og\'irligi bormi?',
    'faq.q5': 'Fors ko\'rfazi mamlakatlari bilan ishlaysizmi?',
    'ftr.about': 'Toshkent orqali xalqaro aviatashish va tranzit logistika. IATA standartlari, GDPga mos, 24/7 qo\'llab-quvvatlash.',
    'ftr.strip': 'Aviatashish │ O\'zbekistondan eksport │ Toshkent orqali tranzit │ Fors ko\'rfazi │ E-commerce │ DG Cargo │ Butun dunyo bo\'ylab yetkazib berish │ 24/7 qo\'llab-quvvatlash',
    'gulf.f1': 'Air-to-Air yechimlari',
    'gulf.f1d': 'TAS hub orqali to\'g\'ridan-to\'g\'ri aviabog\'lanish',
    'gulf.f2': 'Yuklarni konsolidatsiya qilish',
    'gulf.f2d': 'TASda yuklarni konsolidatsiya qilish',
    'gulf.f3': 'DDP / DAP yetkazib berish',
    'gulf.f3d': 'To\'liq bojxona rasmiylashtiruvi bilan yetkazib berish',
    'gulf.f4': 'Bojxona hamrohligi',
    'gulf.f4d': 'To\'liq bojxona hamrohligi',
    'gulf.f5': 'Toshkent orqali tranzit',
    'gulf.f5d': 'TAS hubini qayta yuklash markazi sifatida ishlatish',
    'gulf.f6': 'Multimodal logistika',
    'gulf.f6d': 'Aviatsiya + avtomobil kombinatsiyalangan sxemalari',
    'gulf.text': 'SPECIAL CARGO SERVICES O\'zbekiston va Markaziy Osiyo orqali Fors ko\'rfazi va Yaqin Sharq mamlakatlariga xalqaro yuk tashishni tashkil qiladi — turli toifadagi yuklar uchun aviatsiya, tranzit va multimodal yechimlar.',
    'rfq.ct0': '— tanlang —',
    'rfq.ct1': 'Oddiy',
    'rfq.ct2': 'Xavfli (DG)',
    'rfq.ct3': 'Farma / GDP',
    'rfq.ct4': 'Qimmatbaho',
    'rfq.ct5': 'E-commerce',
    'rfq.ct6': 'Loyiha / negabarit',
    'rfq.ct7': 'Tirik hayvonlar',
    'rfq.f1': 'F.I.Sh. *',
    'rfq.f2': 'Kompaniya',
    'rfq.f3': 'Telefon / WhatsApp *',
    'rfq.f4': 'Email',
    'rfq.f5': 'Qayerdan (shahar / aeroport)',
    'rfq.f6': 'Qayerga (shahar / aeroport)',
    'rfq.f7': 'Yuk turi',
    'rfq.f8': 'Og\'irligi (kg)',
    'rfq.f9': 'O\'rinlar soni',
    'rfq.f10': 'O\'lchamlari U×K×B (sm)',
    'rfq.f11': 'Incoterms',
    'rfq.f12': 'Shoshilinchligi',
    'rfq.f13': 'Tayyor bo\'lish sanasi',
    'rfq.f14': 'Maxsus talablar',
    'rfq.f15': 'Yuk tavsifi',
    'rfq.protect': 'reCAPTCHA bilan himoyalangan · Ma\'lumotlar maxfiy',
    'rfq.s1': 'KONTAKT MA\'LUMOTLARI',
    'rfq.s2': 'MARSHRUT',
    'rfq.s3': 'YUK TAFSILOTLARI',
    'rfq.s4': 'SHART VA MUDDATLAR',
    'rfq.sub': 'Marshrut, yuk turi va kontaktlaringizni ko\'rsating — 24 soat ichida KP, shartnoma va to\'lov bilan bog\'lanamiz.',
    'rfq.u1': 'Shoshilinch',
    'rfq.u2': 'Standart',
    'rfq.u3': 'Tejamkor',
    's1.d': 'Muntazam va chartar reyslar, konsolidatsiya, TAS orqali ekspress-tranzit.',
    's2.t': 'O\'zbekistondan eksport',
    's2.d': 'Eksportni to\'liq qo\'llab-quvvatlash: hujjatlar, bojxona, jo\'natish.',
    's3.t': 'O\'zbekiston orqali tranzit',
    's3.d': 'Toshkent hub sifatida: Air-to-Air, Air-to-Truck, multimodal.',
    's4.d': 'Fors ko\'rfazi va Yaqin Sharq: DXB, JED, DOH, RUH, KWI, BAH, MCT, TLV.',
    's5.t': 'E-commerce logistika',
    's5.d': 'Marketpleyslar va onlayn-do\'konlar uchun last-mile. Tezkor tranzit.',
    's6.t': 'DG Cargo',
    's6.d': 'IATA DGR standarti bo\'yicha xavfli yuklar. Sertifikatlangan mutaxassislar.',
    's7.t': 'Farma-logistika',
    's7.d': 'Sovuq zanjir 2–8°C, harorat monitoringi, GDP standarti.',
    's8.t': 'Aeroport xizmatlari',
    's8.d': 'TAS aeroportida yuklarni qayta ishlash. ULD, konsolidatsiya, tushirish.',
    's9.t': 'Bojxona rasmiylashtiruvi',
    's9.d': 'To\'liq bojxona rasmiylashtiruvi. Eksport, import, tranzit.',
    's10.t': 'Project Cargo',
    's10.d': 'Negabarit va loyihaviy yuklar. Individual yechimlar.',
    's11.t': 'MDH va Markaziy Osiyo',
    's11.d': 'QZ, QQ, TJ, TM, Kavkaz. Multimodal yetkazib berish.',
    's12.t': 'Chartar yechimlar',
    's12.d': 'Individual buyurtma asosida chartar reyslar. Full-freighter, part-charter.',
    'why.1t': 'Geografik markaz',
    'why.1d': 'Xitoy ↔ Yevropa va Sharq ↔ G\'arb marshrutlari kesishmasida. Dunyo YaIMning 60%iga 5 soatlik parvoz masofasida.',
    'why.2t': 'Ochiq osmon siyosati',
    'why.2d': 'Aviatsiya sohasini liberallashtirish. 20+ kargo-tashuvchi bilan muntazam reyslar.',
    'why.3t': 'TAS kargo terminali',
    'why.3d': 'Sovuq zonalar, DG-xendling va 24/7 operatsiyalarga ega zamonaviy terminal.',
    'why.4t': 'Tezkor bojxona',
    'why.4d': 'Aviayuklar uchun tezlashtirilgan tranzit tartib-qoidalari. Soddalashtirilgan rasmiylashtiruv.',
    'chat.placeholder': 'Yukingiz haqida so\'rang...',
    'rfq.ph_special': 'Sovuq zanjir / qo\'riqlanadigan / va h.k.',
    'rfq.ph_desc': 'Qo\'shimcha tafsilotlar...',
    'rfq.sending': 'Yuborilmoqda...',
    'rfq.success_title': 'So\'rov qabul qilindi',
    'rfq.success_text': 'So\'rovingiz jamoamizga va Telegram botga yuborildi. Tez orada siz bilan bog\'lanamiz.',
    'aip.back': '← Bosh sahifaga',
    'aip.eyebrow': 'AI CARGO ASSISTANT · TO\'LIQ EKRAN',
    'aip.title': '<span class="text-blue">5 daqiqada</span> tarif — menejerni kutmasdan',
    'aip.sub': 'Yukingiz, marshrut va muddatlarni tasvirlab bering — AI Cargo Assistant yuk turini aniqlaydi, kerakli tafsilotlarni yig\'adi va so\'rovni menejer va Telegramga uzatadi. 24/7 RU va EN tillarida ishlaydi, ZH tez orada.',
    'aip.panel_title': 'AI CARGO ASSISTANT',
    'aip.how_title': 'Bu qanday ishlaydi',
    'aip.step1_t': 'Yukingizni tasvirlang',
    'aip.step1_d': 'Qayerdan qayerga, qanday yuk, og\'irligi va muddatlari haqida erkin shaklda yozing.',
    'aip.step2_t': 'AI tafsilotlarni aniqlaydi',
    'aip.step2_d': 'Assistent yuk turini aniqlaydi va marshrut hamda Incoterms bo\'yicha aniqlashtiruvchi savollar beradi.',
    'aip.step3_t': 'So\'rov jamoaga uzatiladi',
    'aip.step3_d': 'Tayyor RFQ menejer va Telegram botga yuboriladi. Javob — 2–4 soat ichida.',
    'aip.cta_rfq': 'To\'liq RFQ formasini to\'ldirish',
    'aip.disclaimer': 'reCAPTCHA bilan himoyalangan · Ma\'lumotlar maxfiy · Claude API bilan haqiqiy integratsiya',
  },
  zh: {
    'hdr.sub': '航空货运 · 中转 · 中亚',
    'nav.network': '全球网络', 'nav.services': '服务', 'nav.gulf': '海湾与中东',
    'nav.cases': '案例', 'nav.ai': 'AI助手', 'nav.contacts': '联系',
    'cta.quote': '获取报价',
    'hero.eyebrow': '塔什干 · 自2017年 · IATA标准',
    'hero.title': '<span class="text-blue">国际航空</span>与<span class="text-blue">中转</span>货运,横跨中亚',
    'hero.sub': 'SPECIAL CARGO SERVICES 通过乌兹别克斯坦和中亚,提供国际空运、出口、中转和专业货运解决方案。',
    'hero.cta1': '获取报价', 'hero.cta2': 'AI货运助手',
    'kpi.years': '运营年份', 'kpi.ship': '货运量', 'kpi.dest': '目的地', 'kpi.ops': '运营',
    'network.title': '经塔什干的<span class="text-blue">中转走廊</span>',
    'svc.title': '12项<span class="text-blue">货运物流</span>服务',
    's4.t': '海湾与中东',
    'gulf.title': '海湾<br>与<span class="text-gold">中东</span>',
    'gulf.cta': '请求海湾路线报价',
    'why.title': '为什么<span class="text-blue">塔什干</span>是战略货运枢纽?',
    'cases.title': '真实<span class="text-blue">案例</span>',
    'ai.title': '<span class="text-blue">5分钟</span>报价。由AI驱动。',
    'ai.cta': '启动AI助手',
    'rfq.title': '在线<span class="text-blue">报价</span>请求',
    'rfq.submit': '5分钟内获取报价',
    'faq.title': '常见问题',
    'ftr.nav': '导航', 'ftr.svc': '服务', 'ftr.contact': '联系',
    'ai.text': 'AI货运助手全天候受理询价,对货物类型进行分类,收集路线信息并转交给经理和Telegram。目前支持俄语和英语。',
    'ai.p1': 'Claude API —— 智能货物类型分类',
    'ai.p2': '自动收集数据:路线、重量、尺寸',
    'ai.p3': 'Telegram + 邮件通知',
    'ai.p4': '目前支持俄语/英语 · 中文即将上线',
    'ai.chat1': '您好!我是AI货运助手。请告诉我您的货物信息,我将协助您计算运费。请问从哪里发到哪里?',
    'air.title': '直接合同与分代理',
    'air.sub': '即时获取stock AWB和定期航班资源',
    'case1.tag': '电子产品 · 拼箱',
    'case1.title': '吉隆坡 → 塔什干',
    'case1.k1': '货物',
    'case1.k2': '中转',
    'case1.k3': '结果',
    'case2.tag': '医药 · 冷链',
    'case2.title': '孟买 → 塔什干',
    'case2.k1': '货物',
    'case2.k2': '中转',
    'case2.k3': '结果',
    'case3.tag': '海湾 · 高价值货物',
    'case3.title': '迪拜 → 塔什干',
    'case3.k1': '货物',
    'case3.k2': '中转',
    'case3.k3': '结果',
    'cases.sub': '典型项目:路线、重量、时限、结果。每个项目均有KPI指标。',
    'corr.cis_dist': '独联体分拨',
    'corr.cis_dist_desc': '哈萨克斯坦 · 吉尔吉斯斯坦 · 塔吉克斯坦 · 土库曼斯坦 · 高加索',
    'corr.cn_eu': '中国 → 欧洲(经塔什干)',
    'corr.cn_eu_desc': '空运直达 · 空陆联运',
    'corr.cn_gulf': '中国 → 中东',
    'corr.cn_gulf_desc': '空运 · 多式联运',
    'corr.eu_ca': '欧洲 → 中亚',
    'corr.eu_ca_desc': '空陆联运 · 多式联运',
    'corr.kr_ca': '首尔(ICN) → 塔什干 → 独联体',
    'corr.kr_ca_desc': '大韩航空合作',
    'corr.ksa_ca': '利雅得 / 吉达 → 塔什干',
    'corr.ksa_ca_desc': '定期货运航班',
    'corr.qa_uz': '多哈 → 塔什干 · 卡塔尔货运',
    'corr.qa_uz_desc': '直接合作伙伴关系',
    'corr.uae_cis': '迪拜 → 塔什干 → 独联体',
    'corr.uae_cis_desc': '每日直飞航班',
    'corr.ww': '全球范围',
    'corr.ww_desc': '联运合作伙伴',
    'faq.a1': '通过AI助手5–15分钟内即可获得。复杂货物则需经理在2–4小时内回复。',
    'faq.a2': '是的。我们的专员持有IATA DGR认证,可处理所有危险品类别。',
    'faq.a3': '银行转账、Click、Payme、对公账户。所有单据均正式开具。',
    'faq.a4': '最低计费重量取决于航线,通常为45–100公斤。',
    'faq.a5': '是的,这是我们的战略方向之一。阿联酋、沙特阿拉伯、卡塔尔、科威特、巴林、阿曼、约旦、以色列。',
    'faq.q1': '我多快能收到报价?',
    'faq.q2': '你们承运危险品(DG)吗?',
    'faq.q3': '有哪些付款方式?',
    'faq.q4': '有最低货物重量要求吗?',
    'faq.q5': '你们承运至海湾国家的货物吗?',
    'ftr.about': '经塔什干的国际空运与中转物流。符合IATA标准与GDP规范,提供全天候支持。',
    'ftr.strip': '航空货运 │ 乌兹别克斯坦出口 │ 经塔什干中转 │ 海湾地区 │ 电商物流 │ 危险品货运 │ 全球配送 │ 24/7支持',
    'gulf.f1': '空运直达方案',
    'gulf.f1d': '经塔什干枢纽的直接航空衔接',
    'gulf.f2': '货物拼箱',
    'gulf.f2d': '在塔什干进行货物拼箱',
    'gulf.f3': 'DDP / DAP 送达',
    'gulf.f3d': '包含完整清关手续的配送',
    'gulf.f4': '清关协助',
    'gulf.f4d': '全程清关协助服务',
    'gulf.f5': '经塔什干中转',
    'gulf.f5d': '将塔什干枢纽用作中转集散中心',
    'gulf.f6': '多式联运物流',
    'gulf.f6d': '空运+公路联合运输方案',
    'gulf.text': 'SPECIAL CARGO SERVICES 通过乌兹别克斯坦和中亚组织前往海湾及中东国家的国际货物运输——为各类货物提供航空、中转及多式联运解决方案。',
    'network.sub': '通往海湾、中国、欧洲及独联体的关键航线。提供空运直达、空陆联运及多式联运方案。',
    'ops.note': '联运网络 · 20多家承运商',
    'rfq.ct0': '— 请选择 —',
    'rfq.ct1': '普通货物',
    'rfq.ct2': '危险品(DG)',
    'rfq.ct3': '医药 / GDP',
    'rfq.ct4': '贵重物品',
    'rfq.ct5': '电商货物',
    'rfq.ct6': '项目 / 超大件',
    'rfq.ct7': '活体动物',
    'rfq.f1': '姓名 *',
    'rfq.f2': '公司',
    'rfq.f3': '电话 / WhatsApp *',
    'rfq.f4': '邮箱',
    'rfq.f5': '始发地(城市/机场)',
    'rfq.f6': '目的地(城市/机场)',
    'rfq.f7': '货物类型',
    'rfq.f8': '重量(公斤)',
    'rfq.f9': '件数',
    'rfq.f10': '尺寸 长×宽×高(厘米)',
    'rfq.f11': '贸易术语(Incoterms)',
    'rfq.f12': '紧急程度',
    'rfq.f13': '备货日期',
    'rfq.f14': '特殊要求',
    'rfq.f15': '货物描述',
    'rfq.protect': '受reCAPTCHA保护 · 数据严格保密',
    'rfq.s1': '联系信息',
    'rfq.s2': '路线',
    'rfq.s3': '货物详情',
    'rfq.s4': '条款与时限',
    'rfq.sub': '请提供路线、货物类型和联系方式——我们将在24小时内回复报价、合同及付款方式。',
    'rfq.u1': '加急',
    'rfq.u2': '标准',
    'rfq.u3': '经济',
    's1.t': '空运货运',
    's1.d': '定期与包机航班、拼箱服务、经塔什干快速中转。',
    's2.t': '乌兹别克斯坦出口',
    's2.d': '全程出口支持:单证、清关、发运。',
    's3.t': '经乌兹别克斯坦中转',
    's3.d': '以塔什干为枢纽:空运直达、空陆联运、多式联运。',
    's4.d': '海湾与中东地区:迪拜、吉达、多哈、利雅得、科威特、巴林、马斯喀特、特拉维夫。',
    's5.t': '电商物流',
    's5.d': '面向电商平台与网店的最后一公里配送。快速中转。',
    's6.t': '危险品货运',
    's6.d': '符合IATA DGR标准的危险品运输。持证专业人员。',
    's7.t': '医药物流',
    's7.d': '2–8°C冷链、温度监控、符合GDP标准。',
    's8.t': '机场地面服务',
    's8.d': '塔什干机场货物处理。ULD操作、拼箱、卸货。',
    's9.t': '清关服务',
    's9.d': '全程清关服务。出口、进口、中转。',
    's10.t': '项目货运',
    's10.d': '超大件与项目货物。定制化解决方案。',
    's11.t': '独联体与中亚',
    's11.d': '哈萨克斯坦、吉尔吉斯斯坦、塔吉克斯坦、土库曼斯坦、高加索地区。多式联运配送。',
    's12.t': '包机方案',
    's12.d': '按需定制包机航班。整机包机、部分包机。',
    'svc.sub': '从空运和危险品到电商、医药及项目货运,提供全流程一站式服务。',
    'trust.rating': '客户评分',
    'trust.iata': '持证专业团队',
    'trust.gdp': '符合医药标准',
    'trust.support': '客户支持',
    'why.1t': '地理枢纽',
    'why.1d': '地处中国↔欧洲与东↔西航线交汇点。5小时航程可覆盖全球60%的GDP。',
    'why.2t': '开放天空政策',
    'why.2d': '航空业自由化。与20多家货运航空公司保持定期航班往来。',
    'why.3t': '塔什干货运航站楼',
    'why.3d': '配备冷藏区、危险品操作能力及全天候运营的现代化航站楼。',
    'why.4t': '快速清关',
    'why.4d': '航空货物快速中转流程,简化通关手续。',
    'chat.placeholder': '请咨询您的货物信息...',
    'rfq.ph_special': '冷链 / 需安保 / 等等',
    'rfq.ph_desc': '其他补充说明...',
    'rfq.sending': '发送中...',
    'rfq.success_title': '询价已收到',
    'rfq.success_text': '您的询价已发送至我们的团队和Telegram机器人。我们会尽快与您联系。',
    'aip.back': '← 返回首页',
    'aip.eyebrow': 'AI货运助手 · 全屏模式',
    'aip.title': '<span class="text-blue">5分钟</span>获取报价 — 无需等待客服经理',
    'aip.sub': '描述您的货物、路线和时间安排 — AI货运助手将对货物类型进行分类,收集所需信息,并将请求发送给客服经理和Telegram机器人。RU和EN语言全天候可用,ZH即将推出。',
    'aip.panel_title': 'AI货运助手',
    'aip.how_title': '工作原理',
    'aip.step1_t': '描述您的货物',
    'aip.step1_d': '用您自己的话告诉我们起点、终点、货物类型、重量和时间安排。',
    'aip.step2_t': 'AI澄清详情',
    'aip.step2_d': '助手对货物类型进行分类,并就路线和贸易术语提出后续问题。',
    'aip.step3_t': '请求发送给团队',
    'aip.step3_d': '完成的询价单将发送给客服经理和我们的Telegram机器人。2-4小时内回复。',
    'aip.cta_rfq': '填写完整询价表',
    'aip.disclaimer': '受reCAPTCHA保护 · 数据保密 · 与Claude API的真实集成',
  }
};

function setLang(lang) {
  currentLang = lang;
  document.documentElement.setAttribute('lang', lang);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const dict = translations[lang];
    if (dict && dict[key]) {
      el.innerHTML = dict[key];
    } else if (translations.ru[key]) {
      el.innerHTML = translations.ru[key];
    }
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.getAttribute('data-i18n-ph');
    const dict = translations[lang];
    if (dict && dict[key]) {
      el.setAttribute('placeholder', dict[key]);
    } else if (translations.ru[key]) {
      el.setAttribute('placeholder', translations.ru[key]);
    }
  });
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-lang') === lang);
  });
}

document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => setLang(btn.getAttribute('data-lang')));
});

setLang('ru');
