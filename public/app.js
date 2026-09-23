import { isPreview, loadState, loadCatalog } from './api.js';

const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  bookmark: '<path d="M6 5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16l-6-4-6 4Z"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  arrowUp: '<path d="M6 18 18 6M6 6h12v12"/>',
  search: '<circle cx="10.8" cy="10.8" r="7"/><path d="m16 16 5 5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  spark: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4ZM20 2v4m-2-2h4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chart: '<path d="M4 20V4m0 16h16M8 16v-4m5 4V8m5 8V3"/>',
  sort: '<path d="M8 4v16m-4-4 4 4 4-4m2-12h6m-6 5h4m-4 5h2"/>',
  list: '<path d="M9 5h12M9 12h12M9 19h12M3 5h1m-1 7h1m-1 7h1"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="m3 7 9 6 9-6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17"/>',
  briefcase: '<rect x="3" y="7" width="18" height="14" rx="3"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12a24 24 0 0 0 18 0m-9 0v3"/>',
  link: '<path d="m10 13 4-4m-5 7-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" transform="translate(1 0)"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
};
const icon = (name, cls = '') => `<svg class="icon ${cls}" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const colors = new Set(['peach', 'lavender', 'mint', 'sky', 'rose']);
const levels = { draft: 'Требует уточнения', working: 'Рабочая', ready: 'Готовая', priority: 'Приоритетная' };
const storage = {
  read(key, fallback) { try { return JSON.parse(localStorage.getItem(`tasker:${key}`)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(`tasker:${key}`, JSON.stringify(value)); } catch { /* Browsing remains available when storage is disabled. */ } },
};
const storedSaved = storage.read('saved', []);
const state = {
  data: null, tasks: [], view: 'catalog', layout: storage.read('layout', 'grid') === 'list' ? 'list' : 'grid',
  saved: new Set(Array.isArray(storedSaved) ? storedSaved.filter(x => typeof x === 'string') : []),
  role: storage.read('role', 'team') === 'business' ? 'business' : 'team', teamId: storage.read('team', 'team_orbit'),
  filters: { query: '', industry: '', level: '' }, loading: false, error: '',
};
let catalogController, searchTimer, toastTimer, activeDialogTask = null, lastDialogTrigger = null;
const app = document.querySelector('#app');
const detailDialog = document.querySelector('#detail-dialog');
const infoDialog = document.querySelector('#info-dialog');

const plural = (n, forms) => n % 10 === 1 && n % 100 !== 11 ? forms[0] : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? forms[1] : forms[2];
const avatar = (item, cls = '') => `<span class="avatar ${colors.has(item.color) ? item.color : 'lavender'} ${cls}" aria-hidden="true">${escape(item.initials || item.name?.[0] || item.company?.[0] || 'T')}</span>`;
const bookmark = task => `<button class="icon-button bookmark-button ${state.saved.has(task.id) ? 'is-saved' : ''}" data-action="save" data-id="${escape(task.id)}" aria-pressed="${state.saved.has(task.id)}" aria-label="${state.saved.has(task.id) ? 'Убрать из избранного' : 'Сохранить задачу'}: ${escape(task.fields.title)}" title="${state.saved.has(task.id) ? 'Убрать из избранного' : 'Сохранить задачу'}">${icon('bookmark')}</button>`;
const levelKey = task => levels[task.rating.level.key] ? task.rating.level.key : 'draft';
const published = () => state.data.tasks.filter(t => t.published);
const currentTeam = () => state.data.teams.find(t => t.id === state.teamId) || state.data.teams[0];

function toast(message) {
  const el = document.querySelector('#toast');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('visible'), 3000);
}

function renderShell() {
  const team = currentTeam();
  const selected = state.view;
  app.innerHTML = `
    <aside class="sidebar" aria-label="Навигация">
      <a href="#" class="brand" data-action="catalog" aria-label="TASKER — каталог задач"><span class="brand-symbol">T</span><span>TASKER<span class="brand-dot">.</span></span></a>
      <div class="workspace-label">ПРОСТРАНСТВО ВОЗМОЖНОСТЕЙ</div>
      <nav class="main-nav">
        <button data-action="catalog" class="nav-item ${selected === 'catalog' ? 'active' : ''}" ${selected === 'catalog' ? 'aria-current="page"' : ''}>${icon('grid')}<span>Каталог задач</span><span class="nav-count">${published().length}</span></button>
        <button data-action="saved" class="nav-item ${selected === 'saved' ? 'active' : ''}" ${selected === 'saved' ? 'aria-current="page"' : ''}>${icon('bookmark')}<span>Избранное</span><span class="saved-count nav-count">${savedCount()}</span></button>
        <button data-action="teams" class="nav-item ${selected === 'teams' ? 'active' : ''}" ${selected === 'teams' ? 'aria-current="page"' : ''}>${icon('people')}<span>Команды</span><span class="nav-count">${state.data.teams.length}</span></button>
      </nav>
      <div class="sidebar-bottom">
        <div class="side-note"><span class="side-note-icon">${icon('globe')}</span><strong>Ваши идеи.<br>Настоящий опыт.</strong><p>Решайте задачи бизнеса<br>и растите вместе.</p><button class="text-button" data-action="about">Как это работает ${icon('arrow')}</button></div>
        <div class="sidebar-footnote"><span class="live-dot"></span>Сделано для HackAlem</div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <button class="icon-button mobile-menu" data-action="menu" aria-label="Открыть меню" aria-expanded="false">${icon('menu')}</button>
        <div class="breadcrumbs"><span>Рабочее пространство</span>${icon('chevron')}<strong>${selected === 'saved' ? 'Избранное' : selected === 'teams' ? 'Команды' : 'Каталог задач'}</strong></div>
        <div class="topbar-actions">
          <span class="data-mode ${isPreview ? 'preview' : ''}" title="${isPreview ? 'Синтетические данные для просмотра интерфейса. Сервер API не используется.' : 'Данные загружены с сервера'}"><span class="live-dot"></span>${isPreview ? 'Демо-данные' : 'API подключён'}</span>
          <button class="icon-button refresh-button" data-action="refresh" aria-label="Обновить данные" title="Обновить данные">${icon('refresh')}</button>
          <span class="topbar-divider"></span>
          <label class="role-control">${icon(state.role === 'team' ? 'people' : 'briefcase')}<span class="sr-only">Демонстрационная роль</span><select id="role-select" aria-label="Демонстрационная роль"><option value="team" ${state.role === 'team' ? 'selected' : ''}>Команда</option><option value="business" ${state.role === 'business' ? 'selected' : ''}>Бизнес</option></select></label>
          ${state.role === 'team' && team ? `<button class="profile-button" data-action="profile" aria-label="Выбрать команду. Сейчас ${escape(team.name)}">${avatar(team, 'avatar-small')}</button>` : `<span class="avatar avatar-small lavender" title="Представитель бизнеса">Б</span>`}
        </div>
      </header>
      <main id="main" tabindex="-1">
        ${selected === 'teams' ? teamsPage() : catalogPage()}
      </main>
      <footer class="page-footer"><span>TASKER. <span class="footer-separator">/</span> От идеи к общему результату</span><button class="text-button" data-action="rating">Прозрачный рейтинг ${icon('arrowUp')}</button></footer>
    </div>`;
  if (selected !== 'teams') renderResults();
}

function savedCount() { return published().filter(t => state.saved.has(t.id)).length; }

function catalogPage() {
  const saved = state.view === 'saved';
  const tasks = published();
  const readyCount = tasks.filter(t => t.rating.score >= 70).length;
  return `
    <section class="page-intro ${saved ? 'compact-intro' : ''}">
      <div class="intro-copy"><div class="eyebrow"><span class="eyebrow-line"></span>${saved ? 'ВАШ КОРОТКИЙ СПИСОК' : 'БИЗНЕС-ЗАДАЧИ. СТУДЕНЧЕСКИЕ РЕШЕНИЯ.'}</div>
      <h1>${saved ? 'Сохраните интерес.<br><span>Вернитесь с идеей.</span>' : 'Найдите задачу.<br><span>Создайте результат.</span>'}</h1>
      <p>${saved ? 'Задачи, к которым хочется вернуться. Избранное хранится в этом браузере.' : 'Применяйте свои навыки в реальных проектах.<br>Выберите задачу, которая станет вашим следующим шагом.'}</p></div>
      <div class="intro-metrics" aria-label="Статистика каталога"><div><span class="metric-number">${String(tasks.length).padStart(2, '0')}<span class="metric-dot">↗</span></span><span class="metric-label">${plural(tasks.length, ['открытая задача', 'открытые задачи', 'открытых задач'])}</span></div><div><span class="metric-number">${String(state.data.teams.length).padStart(2, '0')}</span><span class="metric-label">${plural(state.data.teams.length, ['команда', 'команды', 'команд'])} в пространстве</span></div><div class="metric-footnote"><span class="small-check">${icon('check')}</span>${readyCount} ${plural(readyCount, ['задача готова', 'задачи готовы', 'задач готовы'])} к старту</div></div>
    </section>
    ${!saved ? `<section class="rating-banner" aria-label="Как устроен рейтинг"><div class="banner-symbol">${icon('chart')}</div><div class="banner-copy"><h2>Больше ясности — ближе к результату</h2><p>Рейтинг показывает, насколько задача готова к работе.<br class="banner-break"> Чем подробнее условия, тем выше она в каталоге.</p><button class="text-button" data-action="rating">Как считается рейтинг ${icon('arrow')}</button></div><div class="readiness-illustration" aria-hidden="true"><div class="mini-score score-muted"><span>20</span><i></i><small>Идея</small></div><span class="score-connector">${icon('arrow')}</span><div class="mini-score score-medium"><span>65</span><i></i><small>Ясность</small></div><span class="score-connector">${icon('arrow')}</span><div class="mini-score score-full"><span>100<span>✦</span></span><i></i><small>Готовность</small></div></div></section>` : ''}
    <section class="catalog-section" aria-label="${saved ? 'Сохранённые задачи' : 'Открытые задачи'}">
      <div class="section-heading"><div><h2>${saved ? 'Избранные задачи' : 'Открытые задачи'}</h2><span class="result-count" id="result-count" aria-live="polite"></span></div><span class="catalog-access">${icon('globe')}Открыто для любой команды</span></div>
      <div class="filter-toolbar"><label class="search-field">${icon('search')}<span class="sr-only">Поиск задач</span><input id="search-input" type="search" placeholder="Название, навык или ключевое слово" value="${escape(state.filters.query)}" maxlength="160" autocomplete="off" /></label><label class="level-filter"><span class="sr-only">Уровень готовности</span><select id="level-select" aria-label="Уровень готовности"><option value="">Любая готовность</option>${Object.entries(levels).map(([key, name]) => `<option value="${key}" ${state.filters.level === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label><div class="layout-switch" role="group" aria-label="Вид каталога"><button class="icon-button ${state.layout === 'grid' ? 'selected' : ''}" data-action="grid" aria-label="Карточки" aria-pressed="${state.layout === 'grid'}">${icon('grid')}</button><button class="icon-button ${state.layout === 'list' ? 'selected' : ''}" data-action="list" aria-label="Список" aria-pressed="${state.layout === 'list'}">${icon('list')}</button></div></div>
      <div class="category-row"><div class="category-chips" role="group" aria-label="Отрасль">${['', ...state.data.meta.industries.filter(x => x !== 'Другое'), ...(state.data.meta.industries.includes('Другое') ? ['Другое'] : [])].map(industry => `<button class="category-chip ${state.filters.industry === industry ? 'selected' : ''}" data-action="industry" data-industry="${escape(industry)}" aria-pressed="${state.filters.industry === industry}">${escape(industry || 'Все направления')}</button>`).join('')}</div><span class="sort-label">${icon('sort')}По готовности</span></div>
      <div id="results" aria-busy="false"></div>
      <div class="catalog-bottom"><span>${icon('info')}Даже задаче с низким рейтингом можно предложить решение.</span><button class="text-button" data-action="reset-filters">Сбросить фильтры</button></div>
    </section>`;
}

function card(task, index) {
  const proposals = state.data.proposals.filter(p => p.taskId === task.id).length;
  const level = levelKey(task);
  return `<article class="task-card ${level}" style="--card-order:${Math.min(index, 8)}" data-task-id="${escape(task.id)}">
    <div class="card-top"><div class="company">${avatar(task)}<div><span class="company-name">${escape(task.company)}</span><span class="industry-label">${escape(task.industry)}</span></div></div>${bookmark(task)}</div>
    <div class="card-body"><h3><button data-action="task" data-id="${escape(task.id)}">${escape(task.fields.title || 'Задача без названия')}</button></h3><p>${escape(task.fields.need || task.fields.context || task.raw || 'Описание уточняется.')}</p><div class="tags">${(task.tags || []).slice(0, 3).map(tag => `<span>${escape(tag)}</span>`).join('')}</div></div>
    <div class="card-rating"><div class="rating-label-row"><span class="level-label"><span class="level-dot"></span>${escape(levels[level])}</span><span class="score-value">${task.rating.score}<span> / 100</span></span></div><div class="score-track" role="meter" aria-label="Готовность задачи" aria-valuenow="${task.rating.score}" aria-valuemin="0" aria-valuemax="100"><span style="width:${task.rating.score}%"></span></div></div>
    <div class="card-footer"><span class="proposal-count">${icon('people')}${proposals} ${plural(proposals, ['отклик', 'отклика', 'откликов'])}</span><button class="card-open" data-action="task" data-id="${escape(task.id)}" aria-label="Открыть задачу: ${escape(task.fields.title)}">Подробнее ${icon('arrow')}</button></div>
  </article>`;
}

function renderResults() {
  const results = document.querySelector('#results');
  if (!results) return;
  const visible = state.view === 'saved' ? state.tasks.filter(t => state.saved.has(t.id)) : state.tasks;
  document.querySelector('#result-count').textContent = state.loading ? '…' : String(visible.length);
  results.setAttribute('aria-busy', String(state.loading));
  if (state.loading) { results.innerHTML = `<div class="task-grid">${[0, 1, 2].map(() => '<div class="task-skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i></div>').join('')}</div><span class="sr-only" role="status">Загружаем задачи…</span>`; return; }
  if (state.error) { results.innerHTML = `<div class="empty-state" role="alert">${icon('info')}<h3>Не удалось обновить каталог</h3><p>${escape(state.error)}</p><button class="primary-button" data-action="retry-catalog">Попробовать снова ${icon('refresh')}</button></div>`; return; }
  if (!visible.length) {
    const noSaved = state.view === 'saved' && savedCount() === 0;
    results.innerHTML = `<div class="empty-state">${icon(noSaved ? 'bookmark' : 'search')}<h3>${noSaved ? 'Здесь будет ваш короткий список' : 'Пока нет подходящих задач'}</h3><p>${noSaved ? 'Нажмите на закладку у интересной задачи, чтобы сохранить её.' : 'Попробуйте другое слово или снимите часть фильтров.'}</p><button class="primary-button" data-action="${noSaved ? 'catalog' : 'reset-filters'}">${noSaved ? 'Посмотреть каталог' : 'Сбросить фильтры'} ${icon('arrow')}</button></div>`;
    return;
  }
  results.innerHTML = `<div class="task-grid ${state.layout === 'list' ? 'list-view' : ''}">${visible.map(card).join('')}</div>`;
}

async function updateCatalog() {
  catalogController?.abort();
  const controller = new AbortController();
  catalogController = controller;
  const timeout = setTimeout(() => controller.abort('timeout'), 8000);
  state.loading = true; state.error = ''; renderResults();
  try {
    const tasks = await loadCatalog(state.filters, controller.signal);
    if (catalogController !== controller) return;
    state.tasks = tasks;
  } catch (error) {
    if (catalogController !== controller) return;
    state.error = controller.signal.reason === 'timeout' ? 'Сервер не ответил вовремя. Попробуйте ещё раз.' : error.message;
  } finally {
    clearTimeout(timeout);
    if (catalogController === controller) { state.loading = false; renderResults(); }
  }
}

function teamsPage() {
  return `<section class="page-intro compact-intro"><div class="intro-copy"><div class="eyebrow"><span class="eyebrow-line"></span>СТУДЕНЧЕСКИЕ КОМАНДЫ</div><h1>Разные навыки.<br><span>Общий интерес.</span></h1><p>Знакомьтесь с командами, которые превращают идеи в решения.</p></div></section><section aria-label="Команды"><div class="section-heading"><div><h2>Команды в пространстве</h2><span class="result-count">${state.data.teams.length}</span></div><span class="catalog-access">${icon('people')}Выбор всегда за людьми</span></div><div class="teams-grid">${state.data.teams.map(team => `<article class="team-card">${avatar(team, 'avatar-large')}<div class="team-card-heading"><h3>${escape(team.name)}</h3><span>${team.members} ${plural(team.members, ['участник', 'участника', 'участников'])}</span></div><p>${escape(team.description)}</p><div class="team-interests">${(team.interests || []).map(escape).join(' · ')}</div><div class="tags">${[...(team.skills || []), ...(team.technologies || [])].slice(0, 4).map(x => `<span>${escape(x)}</span>`).join('')}</div><div class="team-card-footer"><span>${icon('chart')}<strong>${Number.isFinite(team.points) ? team.points : 0}</strong> баллов за результат</span>${team.id === state.teamId && state.role === 'team' ? '<span class="your-team">Ваша команда</span>' : ''}</div></article>`).join('')}</div><p class="team-points-note">Баллы появляются после того, как бизнес подтвердит выполненный этап. Отклики и выбор команды сами по себе баллов не дают.</p></section>`;
}

function fieldBlock(label, value, wide = false) {
  return `<section class="detail-field ${wide ? 'wide' : ''}"><h3>${escape(label)}</h3><p class="${value ? '' : 'missing-value'}">${escape(value || 'Пока не указано')}</p></section>`;
}

function openTask(id) {
  const task = state.tasks.find(t => t.id === id) || published().find(t => t.id === id);
  if (!task) { toast('Эта задача пока недоступна в каталоге.'); return; }
  activeDialogTask = task;
  lastDialogTrigger = document.activeElement;
  const level = levelKey(task);
  const proposals = state.data.proposals.filter(p => p.taskId === task.id);
  detailDialog.innerHTML = `<div class="dialog-topline"><span>КАРТОЧКА ЗАДАЧИ <span class="detail-dot">/</span> ${escape(task.industry)}</span><div>${bookmark(task)}<button class="icon-button" data-action="close-detail" aria-label="Закрыть карточку">${icon('close')}</button></div></div>
    <div class="detail-heading"><div class="company">${avatar(task)}<div><span class="company-name">${escape(task.company)}</span><span class="industry-label">Бизнес-задача · открыта всем командам</span></div></div><h2 id="detail-title">${escape(task.fields.title)}</h2><div class="tags">${(task.tags || []).map(tag => `<span>${escape(tag)}</span>`).join('')}</div></div>
    <div class="detail-layout"><div class="detail-main"><div class="detail-field-grid">${fieldBlock('Контекст', task.fields.context, true)}${fieldBlock('Что нужно изменить', task.fields.need, true)}${fieldBlock('Для кого', task.fields.users)}${fieldBlock('Данные и материалы', task.fields.data)}${fieldBlock('Ожидаемый результат', task.fields.result, true)}${fieldBlock('Критерии успеха', task.fields.success, true)}${fieldBlock('Ограничения', task.fields.constraints, true)}</div><div class="contact-section"><h3>${icon('mail')}Взаимодействие с бизнесом</h3>${fieldBlock('Контакт', task.fields.contact)}${fieldBlock('Формат консультаций', task.fields.format)}${fieldBlock('Обратная связь', task.fields.feedback)}</div>${proposals.length ? `<section class="detail-proposals"><h3>Идеи от команд <span>${proposals.length}</span></h3>${proposals.map(p => { const team = state.data.teams.find(t => t.id === p.teamId); return `<div class="proposal-preview">${avatar(team || { initials: '?', color: 'lavender' })}<div><strong>${escape(team?.name || 'Команда')}</strong><p>${escape(p.idea)}</p><span>${icon('clock')}${escape(p.duration)}</span></div></div>`; }).join('')}</section>` : ''}</div>
    <aside class="detail-rating ${level}"><div class="rating-panel"><div class="rating-panel-top"><h3>Готовность задачи</h3><button class="icon-button" data-action="rating" aria-label="О формуле рейтинга">${icon('info')}</button></div><div class="score-circle" style="--score:${task.rating.score}%"><div><strong>${task.rating.score}</strong><span>из 100 баллов</span></div></div><div class="detail-level"><span class="level-dot"></span>${escape(levels[level])}</div><p class="rating-explanation">Баллы за заполненные<br>и подтверждённые сведения</p><div class="breakdown">${task.rating.breakdown.map(g => `<div class="breakdown-item"><div><span>${escape(g.label)}</span><strong>${g.earned}<span>/${g.max}</span></strong></div><div class="breakdown-track"><span style="width:${g.max ? Math.min(100, g.earned / g.max * 100) : 0}%"></span></div></div>`).join('')}</div>${task.rating.missing.length ? `<div class="missing-panel"><h4>Что сделает задачу понятнее</h4>${task.rating.missing.slice(0, 4).map(m => `<div><span>${escape(m.label)}</span><strong>+${m.weight}</strong></div>`).join('')}${task.rating.missing.length > 4 ? `<p>И ещё ${task.rating.missing.length - 4} ${plural(task.rating.missing.length - 4, ['поле', 'поля', 'полей'])} в карточке</p>` : ''}</div>` : `<div class="complete-note">${icon('check')}Все сведения подтверждены бизнесом</div>`}</div><p class="detail-availability">${icon('globe')}Любая команда может предложить решение независимо от рейтинга.</p></aside></div>
    <div class="dialog-footer"><span>${isPreview ? 'Синтетический пример для демонстрации' : 'Решение о выборе команды принимает бизнес'}</span><button class="secondary-button" data-action="copy-link">${icon('link')}Скопировать ссылку</button></div>`;
  if (!detailDialog.open) detailDialog.showModal();
  document.body.classList.add('dialog-open');
  const hash = `#task/${encodeURIComponent(id)}`;
  if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}

function openInfo(kind) {
  let content;
  if (kind === 'profile') {
    content = `<div class="info-kicker">ДЕМОНСТРАЦИОННАЯ РОЛЬ</div><h2 id="info-title">От лица какой команды?</h2><p class="info-intro">Посмотрите пространство глазами разных участников. Каталог открыт для всех.</p><div class="team-picker">${state.data.teams.map(t => `<button data-action="select-team" data-id="${escape(t.id)}" class="team-picker-item">${avatar(t)}<span><strong>${escape(t.name)}</strong><small>${escape((t.interests || []).join(' · '))}</small></span>${t.id === state.teamId ? icon('check') : icon('chevron')}</button>`).join('')}</div>`;
  } else if (kind === 'about') {
    content = `<div class="info-kicker">ОДНО ПРОСТРАНСТВО. ОБЩИЙ РЕЗУЛЬТАТ.</div><h2 id="info-title">От задачи до сотрудничества</h2><p class="info-intro">TASKER помогает бизнесу сформулировать задачу, а студенческим командам — найти интересную практику.</p><ol class="how-steps"><li><span>01</span><div><h3>Бизнес описывает потребность</h3><p>Уточняет условия, проверяет сведения и публикует карточку. Полнота описания определяет её рейтинг.</p></div></li><li><span>02</span><div><h3>Команды предлагают решения</h3><p>Каталог открыт всем. Команда выбирает интересную задачу и готовит идею с планом работы.</p></div></li><li><span>03</span><div><h3>Бизнес выбирает партнёров</h3><p>Одна, несколько или ни одной команды — решение всегда за человеком.</p></div></li><li><span>04</span><div><h3>Прогресс становится видимым</h3><p>Команда получает баллы после подтверждённого бизнесом результата этапа.</p></div></li></ol>`;
  } else {
    const rubric = state.data.meta.rubric || [];
    content = `<div class="info-kicker">ПОНЯТНЫЕ ПРАВИЛА ДЛЯ ВСЕХ</div><h2 id="info-title">Хорошая задача начинается<br>с ясных условий</h2><p class="info-intro">Рейтинг показывает полноту описания. Он складывается из сведений, которые заполнил и подтвердил бизнес.</p><div class="rubric-list">${rubric.map(g => `<div><span>${escape(g.label)}</span><strong>${g.max}<small> баллов</small></strong></div>`).join('')}</div><div class="rating-total"><span>Максимальная готовность</span><strong>100</strong></div><div class="level-legend">${[['draft', '0–39'], ['working', '40–69'], ['ready', '70–89'], ['priority', '90–100']].map(([key, range]) => `<div class="${key}"><span class="level-dot"></span><span>${levels[key]}</span><strong>${range}</strong></div>`).join('')}</div><p class="info-footnote">Рейтинг оценивает полноту, а не истинность сведений. Он влияет на порядок задач в каталоге, но не ограничивает отклики. Известность компании и личные данные участников на баллы не влияют.</p>`;
  }
  infoDialog.innerHTML = `<button class="icon-button info-close" data-action="close-info" aria-label="Закрыть окно">${icon('close')}</button>${content}`;
  if (!infoDialog.open) infoDialog.showModal();
  document.body.classList.add('dialog-open');
}

function closeDetail() {
  detailDialog.close(); activeDialogTask = null;
  if (location.hash.startsWith('#task/')) history.replaceState(null, '', `${location.pathname}${location.search}`);
  lastDialogTrigger?.focus?.();
}

function setView(view) {
  clearTimeout(searchTimer);
  state.view = view;
  state.filters = { query: '', industry: '', level: '' };
  renderShell();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (view !== 'teams') updateCatalog();
}

function resetFilters() {
  clearTimeout(searchTimer);
  state.filters = { query: '', industry: '', level: '' };
  renderShell(); updateCatalog();
}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  event.preventDefault();
  if (['catalog', 'saved', 'teams'].includes(action)) setView(action);
  if (action === 'task') openTask(id);
  if (action === 'save') {
    state.saved.has(id) ? state.saved.delete(id) : state.saved.add(id);
    storage.write('saved', [...state.saved]);
    document.querySelectorAll('.saved-count').forEach(el => { el.textContent = savedCount(); });
    renderResults();
    if (activeDialogTask) {
      const existing = detailDialog.querySelector('.bookmark-button');
      if (existing) { const hasFocus = existing === document.activeElement; existing.outerHTML = bookmark(activeDialogTask); if (hasFocus) detailDialog.querySelector('.bookmark-button').focus(); }
    }
    // Preserve keyboard focus after the card list has been refreshed.
    if (!detailDialog.open) document.querySelector(`.task-card[data-task-id="${CSS.escape(id)}"] .bookmark-button`)?.focus();
    toast(state.saved.has(id) ? 'Задача сохранена в избранное' : 'Задача убрана из избранного');
  }
  if (action === 'industry') {
    state.filters.industry = button.dataset.industry;
    document.querySelectorAll('.category-chip').forEach(el => { const selected = el.dataset.industry === state.filters.industry; el.classList.toggle('selected', selected); el.setAttribute('aria-pressed', selected); });
    updateCatalog();
  }
  if (action === 'grid' || action === 'list') {
    state.layout = action; storage.write('layout', action);
    document.querySelectorAll('.layout-switch button').forEach(el => { const selected = el.dataset.action === action; el.classList.toggle('selected', selected); el.setAttribute('aria-pressed', selected); });
    renderResults();
  }
  if (action === 'reset-filters') resetFilters();
  if (action === 'retry-catalog') updateCatalog();
  if (['rating', 'about', 'profile'].includes(action)) openInfo(action);
  if (action === 'close-detail') closeDetail();
  if (action === 'close-info') infoDialog.close();
  if (action === 'select-team') { state.teamId = id; state.role = 'team'; storage.write('team', id); storage.write('role', 'team'); infoDialog.close(); renderShell(); toast(`Вы смотрите каталог от команды ${currentTeam().name}`); }
  if (action === 'copy-link') {
    try { await navigator.clipboard.writeText(location.href); toast('Ссылка на задачу скопирована'); }
    catch { toast('Скопируйте ссылку из адресной строки браузера.'); }
  }
  if (action === 'menu') { const sidebar = document.querySelector('.sidebar'); const open = sidebar.classList.toggle('mobile-open'); button.setAttribute('aria-expanded', open); }
  if (action === 'refresh' || action === 'retry') boot(true);
});

document.addEventListener('input', event => {
  if (event.target.id !== 'search-input') return;
  state.filters.query = event.target.value;
  clearTimeout(searchTimer); searchTimer = setTimeout(updateCatalog, 180);
});
document.addEventListener('change', event => {
  if (event.target.id === 'level-select') { state.filters.level = event.target.value; updateCatalog(); }
  if (event.target.id === 'role-select') { state.role = event.target.value === 'business' ? 'business' : 'team'; storage.write('role', state.role); renderShell(); toast(state.role === 'business' ? 'Вы смотрите пространство от лица бизнеса' : 'Вы смотрите пространство от лица команды'); }
});
for (const dialog of [detailDialog, infoDialog]) {
  dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog === detailDialog ? closeDetail() : dialog.close(); } });
  dialog.addEventListener('close', () => { if (!detailDialog.open && !infoDialog.open) document.body.classList.remove('dialog-open'); });
}
detailDialog.addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
window.addEventListener('hashchange', openHashTask);

function openHashTask() {
  if (!state.data) return;
  if (location.hash.startsWith('#task/')) {
    try { openTask(decodeURIComponent(location.hash.slice(6))); } catch { toast('Некорректная ссылка на задачу.'); }
  } else if (detailDialog.open) closeDetail();
}

async function boot(refresh = false) {
  catalogController?.abort(); catalogController = null; clearTimeout(searchTimer);
  if (refresh) {
    document.querySelectorAll('.refresh-button').forEach(el => { el.disabled = true; el.classList.add('spinning'); });
  }
  try {
    state.data = await loadState();
    state.tasks = await loadCatalog(state.filters);
    state.error = ''; state.loading = false;
    renderShell(); openHashTask();
    if (refresh) toast('Каталог обновлён');
  } catch (error) {
    app.innerHTML = `<main class="connection-error"><a class="brand" href="/"><span class="brand-symbol">T</span><span>TASKER.</span></a><div class="empty-state">${icon('globe')}<h1>Подключим ваши задачи</h1><p>${escape(error.message)}</p><p>Проверьте, запущен ли сервер приложения.<br>Для отдельного просмотра интерфейса доступны тестовые данные.</p><div class="error-actions"><button class="primary-button" data-action="retry">Повторить ${icon('refresh')}</button><a class="secondary-button" href="/?preview=1">Открыть демо-каталог ${icon('arrow')}</a></div></div></main>`;
  }
}

boot();
