import { isPreview, loadState, loadCatalog, createTask } from './api.js';

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
  read(key, fallback) { try { return JSON.parse(localStorage.getItem(`alem:${key}`)) ?? fallback; } catch { return fallback; } },
  write(key, value) { try { localStorage.setItem(`alem:${key}`, JSON.stringify(value)); } catch { /* Browsing remains available when storage is disabled. */ } },
};
const storedSaved = storage.read('saved', []);
const state = {
  data: null, tasks: [], view: 'catalog', layout: storage.read('layout', 'list') === 'grid' ? 'grid' : 'list',
  saved: new Set(Array.isArray(storedSaved) ? storedSaved.filter(x => typeof x === 'string') : []),
  role: storage.read('role', 'team') === 'business' ? 'business' : 'team', teamId: storage.read('team', 'team_orbit'),
  filters: { query: '', industry: '', level: '' }, loading: false, error: '',
  draft: { raw: '', industry: '', pending: false, error: '', uncertain: false, created: null },
};
let catalogController, searchTimer, toastTimer, activeDialogTask = null, lastDialogTrigger = null;
const app = document.querySelector('#app');
const detailDialog = document.querySelector('#detail-dialog');
const infoDialog = document.querySelector('#info-dialog');

const plural = (n, forms) => n % 10 === 1 && n % 100 !== 11 ? forms[0] : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? forms[1] : forms[2];
const avatar = (item, cls = '') => `<span class="avatar ${colors.has(item.color) ? item.color : 'lavender'} ${cls}" aria-hidden="true">${escape(item.initials || item.name?.[0] || item.company?.[0] || 'A')}</span>`;
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

const brand = () => `<span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M12 6H6v20h6M20 6h6v20h-6" stroke="currentColor" stroke-width="2.4"/><circle cx="16" cy="16" r="2.8" fill="currentColor"/></svg></span><span class="wordmark">alem<span>.</span></span>`;
const ownDrafts = () => state.data.tasks.filter(t => !t.published && t.businessId === 'business_demo');
function readinessStrip(task) {
  return `<div class="readiness-strip" role="img" aria-label="Готовность: ${task.rating.score} из 100. Расшифровка в паспорте задачи.">${task.rating.breakdown.map(g => `<span class="readiness-segment" style="flex:${Number(g.max) || 1}" title="${escape(g.label)}: ${g.earned}/${g.max}"><i style="width:${g.max ? Math.max(0, Math.min(100, g.earned / g.max * 100)) : 0}%"></i></span>`).join('')}</div>`;
}
function renderShell() {
  const team = currentTeam();
  const selected = state.view;
  app.innerHTML = `<div class="workspace">
    <header class="site-header"><div class="header-inner">
      <a href="#" class="brand" data-action="catalog" aria-label="alem — каталог задач">${brand()}</a><span class="brand-caption">бюро<br>практики</span>
      <nav class="main-nav" aria-label="Основная навигация">
        <button data-action="catalog" class="nav-item ${selected === 'catalog' ? 'active' : ''}" ${selected === 'catalog' ? 'aria-current="page"' : ''}>Задачи <span class="nav-count">${String(published().length).padStart(2, '0')}</span></button>
        <button data-action="teams" class="nav-item ${selected === 'teams' ? 'active' : ''}" ${selected === 'teams' ? 'aria-current="page"' : ''}>Команды</button>
        <button data-action="saved" class="nav-item ${selected === 'saved' ? 'active' : ''}" ${selected === 'saved' ? 'aria-current="page"' : ''}>Избранное <span class="saved-count nav-count">${savedCount()}</span></button>
      </nav>
      <div class="header-actions"><label class="role-control"><span>Демо-роль</span><select id="role-select" aria-label="Демонстрационная роль" ${state.draft.pending ? "disabled" : ""}><option value="team" ${state.role === 'team' ? 'selected' : ''}>Команда</option><option value="business" ${state.role === 'business' ? 'selected' : ''}>Бизнес</option></select></label>
      ${state.role === 'team' && team ? `<button class="profile-button" data-action="profile" aria-label="Выбрать команду. Сейчас ${escape(team.name)}">${avatar(team, 'avatar-small')}</button>` : ''}
      <button class="primary-button header-create" data-action="create" ${state.draft.pending ? 'disabled' : ''}>Предложить задачу ${icon('arrowUp')}</button></div>
    </div></header>
    <main id="main" tabindex="-1">${selected === 'teams' ? teamsPage() : selected === 'create' ? createPage() : catalogPage()}</main>
    <footer class="page-footer"><a class="footer-brand" href="#" data-action="catalog">alem<span>.</span></a><span>Задача бизнеса. Практика команды.</span><div class="footer-meta"><span class="data-mode ${isPreview ? 'preview' : ''}"><span class="live-dot"></span>${isPreview ? 'Просмотр примеров' : 'Демо-среда'}</span><button class="icon-button refresh-button" data-action="refresh" aria-label="Обновить данные" title="Обновить данные">${icon('refresh')}</button><button class="text-button" data-action="rating">Правила рейтинга ${icon('arrowUp')}</button></div></footer>
  </div>`;
  if (selected === 'catalog' || selected === 'saved') renderResults();
}

function savedCount() { return published().filter(t => state.saved.has(t.id)).length; }

function catalogPage() {
  const saved = state.view === 'saved';
  const tasks = published();
  const example = tasks.find(t => t.id === 'task_service') || [...tasks].sort((a,b) => a.rating.score-b.rating.score)[0];
  return `${saved ? `<section class="page-intro saved-intro"><div class="eyebrow">ВАШ КОРОТКИЙ СПИСОК</div><h1>Стоит <em>сохранить.</em></h1><p>Задачи, к которым вы хотите вернуться.</p></section>` : `<section class="page-intro">
      <div class="hero-copy"><div class="eyebrow"><span class="edition-marker"></span>БИЗНЕС × СТУДЕНЧЕСКИЕ КОМАНДЫ</div><h1>Знания —<br><em>в дело.</em></h1><p>У бизнеса есть задача. У вас — навыки.<br>Найдите друг друга и сделайте работу,<br class="desktop-break"> которую можно показать.</p><div class="hero-actions"><a class="primary-button" href="#catalog-section">Выбрать задачу ${icon('arrow')}</a><button class="text-button" data-action="about">Как работает alem ${icon('arrowUp')}</button></div><div class="hero-footnote"><span>${String(tasks.length).padStart(2,'0')} открытых задач</span><span>${String(state.data.teams.length).padStart(2,'0')} команд</span><span class="demo-label">Демонстрационные примеры</span></div></div>
      ${example ? `<aside class="featured-passport ${levelKey(example)}" aria-label="Пример паспорта задачи"><div class="passport-overline"><span>ПАСПОРТ ЗАДАЧИ</span><span>ОТКРЫТА ДЛЯ КОМАНД ${icon('arrowUp')}</span></div><div class="passport-company">${escape(example.company)} <span>/ ${escape(example.industry)}</span></div><h2>${escape(example.fields.title)}</h2><div class="passport-readiness"><div><span class="score-caption">Готовность к работе</span><div class="passport-score">${example.rating.score}<small>/100</small></div></div><p>${example.rating.missing.length ? 'Есть потребность.\nУсловия ещё уточняются.' : 'Все условия\nподтверждены.'}</p></div>${readinessStrip(example)}<div class="passport-next"><span>Следующее уточнение</span><strong>${escape(example.rating.missing[0]?.label || 'Все сведения подтверждены')} ${example.rating.missing[0] ? `<b>+${example.rating.missing[0].weight}</b>` : ''}</strong><p>${example.rating.missing.length ? 'Баллы появятся после ответа и подтверждения бизнеса.' : 'Можно обсудить с бизнесом ваш подход к задаче.'}</p></div><button class="passport-open" data-action="task" data-id="${escape(example.id)}">Разобрать эту задачу ${icon('arrow')}</button><span class="passport-corner" aria-hidden="true"></span></aside>` : ''}
    </section><section class="practice-route" aria-label="Путь от задачи к результату"><div><span>01</span><p>Понятные условия<strong>Изучите паспорт задачи</strong></p></div><span class="route-arrow" aria-hidden="true">↗</span><div><span>02</span><p>Свободный выбор<strong>Предложите свой подход</strong></p></div><span class="route-arrow" aria-hidden="true">↗</span><div><span>03</span><p>Подтверждённая работа<strong>Получите баллы за результат</strong></p></div><button class="text-button" data-action="rating" aria-label="Как начисляются баллы">Правила ${icon('arrowUp')}</button></section>`}
    <section id="catalog-section" class="catalog-section" aria-label="${saved ? 'Сохранённые задачи' : 'Открытые задачи'}">
      <div class="section-heading"><div><span class="section-index">${saved ? '02' : '01'} /</span><h2>${saved ? 'Сохранённые задачи' : 'Открытые задачи'}</h2><span class="result-count" id="result-count" aria-live="polite"></span></div><span class="catalog-access">Любая команда. Любой уровень готовности.</span></div>
      <div class="filter-toolbar"><label class="search-field">${icon('search')}<span class="sr-only">Поиск задач</span><input id="search-input" type="search" placeholder="Поиск по задаче, навыку или компании" value="${escape(state.filters.query)}" maxlength="160" autocomplete="off" /></label><label class="level-filter"><span class="sr-only">Уровень готовности</span><select id="level-select" aria-label="Уровень готовности"><option value="">Любая готовность</option>${Object.entries(levels).map(([key, name]) => `<option value="${key}" ${state.filters.level === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label><div class="layout-switch" role="group" aria-label="Вид каталога"><button class="icon-button ${state.layout === 'list' ? 'selected' : ''}" data-action="list" aria-label="Список" aria-pressed="${state.layout === 'list'}">${icon('list')}</button><button class="icon-button ${state.layout === 'grid' ? 'selected' : ''}" data-action="grid" aria-label="Карточки" aria-pressed="${state.layout === 'grid'}">${icon('grid')}</button></div></div>
      <div class="category-row"><div class="category-chips" role="group" aria-label="Отрасль">${['', ...state.data.meta.industries].map(industry => `<button class="category-chip ${state.filters.industry === industry ? 'selected' : ''}" data-action="industry" data-industry="${escape(industry)}" aria-pressed="${state.filters.industry === industry}">${escape(industry || 'Все задачи')}</button>`).join('')}</div><span class="sort-label">${icon('sort')}Сначала полные условия</span></div>
      <div id="results" aria-busy="false"></div>
      <div class="catalog-bottom"><span>Рейтинг оценивает полноту условий. Откликнуться можно на любую задачу.</span><button class="text-button" data-action="reset-filters">Сбросить фильтры ${icon('refresh')}</button></div>
    </section>`;
}

function card(task) {
  const proposals = state.data.proposals.filter(p => p.taskId === task.id).length;
  const level = levelKey(task);
  const number = String(published().findIndex(t => t.id === task.id) + 1).padStart(2, '0');
  const isConfirmed = key => task.confirmedFields?.includes(key) && task.fields[key]?.trim();
  return `<article class="task-card ${level}" data-task-id="${escape(task.id)}">
    <div class="card-top"><span class="card-index">${number} /</span><div class="company">${avatar(task)}<div><span class="company-name">${escape(task.company)}</span><span class="industry-label">${escape(task.industry)}</span></div></div>${bookmark(task)}</div>
    <div class="card-body"><h3><button data-action="task" data-id="${escape(task.id)}">${escape(task.fields.title || 'Задача без названия')}</button></h3><p>${escape(task.fields.need || task.fields.context || task.raw || 'Описание уточняется.')}</p><div class="tags">${(task.tags || []).slice(0, 3).map(tag => `<span>${escape(tag)}</span>`).join('')}</div></div>
    <div class="card-conditions" aria-label="Условия задачи">${[['data','Материалы'],['result','Результат'],['success','Приёмка']].map(([key,label]) => `<span class="condition ${isConfirmed(key) ? 'confirmed' : 'unconfirmed'}" title="${isConfirmed(key) ? 'Подтверждено бизнесом' : 'Нужно уточнить у бизнеса'}"><span aria-hidden="true">${isConfirmed(key) ? '✓' : '—'}</span>${label}<span class="sr-only">: ${isConfirmed(key) ? 'подтверждено' : 'нужно уточнить'}</span></span>`).join('')}</div>
    <div class="card-rating"><div class="rating-label-row"><span class="score-caption">Готовность</span><span class="score-value">${task.rating.score}<small>/100</small></span></div>${readinessStrip(task)}<span class="level-label"><span class="level-dot"></span>${escape(levels[level])}</span></div>
    <div class="card-footer"><span class="proposal-count">${proposals} ${plural(proposals, ['отклик', 'отклика', 'откликов'])}</span><button class="card-open" data-action="task" data-id="${escape(task.id)}" aria-label="Открыть задачу: ${escape(task.fields.title)}">Читать задачу ${icon('arrowUp')}</button></div>
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
  return `<section class="page-intro compact-intro"><div class="intro-copy"><div class="eyebrow"><span class="eyebrow-line"></span>УЧАСТНИКИ ПРАКТИКИ</div><h1>Кто берётся<br><em>за дело.</em></h1><p>Навыки, интересы и результаты студенческих команд.</p></div></section><section aria-label="Команды"><div class="section-heading"><div><h2>Команды</h2><span class="result-count">${state.data.teams.length}</span></div><span class="catalog-access">${icon('people')}Выбор всегда за людьми</span></div><div class="teams-grid">${state.data.teams.map(team => `<article class="team-card">${avatar(team, 'avatar-large')}<div class="team-card-heading"><h3>${escape(team.name)}</h3><span>${team.members} ${plural(team.members, ['участник', 'участника', 'участников'])}</span></div><p>${escape(team.description)}</p><div class="team-interests">${(team.interests || []).map(escape).join(' · ')}</div><div class="tags">${[...(team.skills || []), ...(team.technologies || [])].slice(0, 4).map(x => `<span>${escape(x)}</span>`).join('')}</div><div class="team-card-footer"><span>${icon('chart')}<strong>${Number.isFinite(team.points) ? team.points : 0}</strong> баллов за результат</span>${team.id === state.teamId && state.role === 'team' ? '<span class="your-team">Ваша команда</span>' : ''}</div></article>`).join('')}</div><p class="team-points-note">Баллы появляются после того, как бизнес подтвердит выполненный этап. Отклики и выбор команды сами по себе баллов не дают.</p></section>`;
}

function createPage() {
  const draft = state.draft;
  const saved = draft.created;
  return `<section class="create-intro"><div class="eyebrow">ДЛЯ БИЗНЕСА / ПОСТАНОВКА ЗАДАЧИ</div><h1>Начнём<br><em>с вашей задачи.</em></h1><p>Опишите, что сейчас не получается.<br>Для начала достаточно нескольких предложений.</p></section><div class="draft-layout"><section class="draft-paper" aria-label="Черновик задачи">
    <div class="paper-heading"><span>01 / ИСХОДНАЯ ПОТРЕБНОСТЬ</span><span class="paper-state">${saved ? 'СОХРАНЕНО' : 'ЧЕРНОВИК'}</span></div>
    ${saved ? `<div class="draft-success" role="status" tabindex="-1"><span class="success-mark">${icon('check')}</span><h2>Описание сохранено.</h2><p>Черновик ещё не опубликован и не виден командам.</p><div class="saved-description"><span>${escape(saved.industry)}</span><p>${escape(saved.raw)}</p></div><div class="saved-rating"><span>Готовность</span><strong>${saved.rating.score}<small>/100</small></strong></div><p class="draft-help">Баллы появятся, когда вы заполните и подтвердите условия в паспорте задачи.</p><div class="form-actions"><button class="primary-button" data-action="catalog">К открытым задачам ${icon('arrow')}</button><button class="text-button" data-action="new-draft">Новый черновик</button></div></div>` : `<form id="draft-form" class="draft-form" aria-busy="${draft.pending}"><label for="draft-raw">Что нужно решить?</label><p id="draft-hint" class="draft-help">Как устроена работа сейчас, что мешает и что хочется изменить.</p><textarea id="draft-raw" name="raw" required maxlength="4000" rows="7" ${draft.pending ? 'disabled' : ''} aria-describedby="draft-hint draft-counter" placeholder="Например: у нас небольшая кофейня. К вечеру часть выпечки остаётся, а утром популярных позиций не хватает. Хотим понять, сколько готовить на каждый день.">${escape(draft.raw)}</textarea><div class="form-counter" id="draft-counter">${draft.raw.length} / 4000</div><label for="draft-industry">В какой сфере работает ваш бизнес?</label><select id="draft-industry" name="industry" required ${draft.pending ? 'disabled' : ''}><option value="">Выберите сферу</option>${state.data.meta.industries.map(i => `<option value="${escape(i)}" ${draft.industry === i ? 'selected' : ''}>${escape(i)}</option>`).join('')}</select>${draft.error ? `<div class="form-error" role="alert" tabindex="-1">${escape(draft.error)}${draft.uncertain ? '<button type="button" class="text-button" data-action="check-drafts">Проверить сохранённые черновики</button>' : ''}${draft.uncertain && draft.reviewed ? '<button type="button" class="text-button" data-action="new-draft">Начать новый черновик</button>' : ''}</div>` : ''}${isPreview ? '<p class="form-error">Это режим просмотра. Для сохранения <a href="/">откройте приложение</a>.</p>' : ''}<div class="form-actions"><button class="primary-button" type="submit" ${draft.pending || draft.uncertain || isPreview ? 'disabled' : ''}>${draft.pending ? 'Сохраняем…' : 'Сохранить черновик'} ${icon('arrow')}</button><span>Публикация — отдельный шаг</span></div></form>`}
  </section><aside class="draft-aside"><div class="eyebrow">ХОРОШАЯ ПОСТАНОВКА</div><h2>Команде нужен<br>ваш контекст.</h2><ol><li><span>01</span><p>Расскажите о процессе так, как объяснили бы его коллеге.</p></li><li><span>02</span><p>Назовите проблему, которую можно увидеть или измерить.</p></li><li><span>03</span><p>Если чего-то не знаете, оставьте это вопросом.</p></li></ol><p class="aside-footnote">Не включайте пароли и персональные данные клиентов.</p>${ownDrafts().length ? `<div class="my-drafts"><h3>Ваши черновики <span>${ownDrafts().length}</span></h3>${ownDrafts().slice().reverse().map(t => `<button data-action="open-draft" data-id="${escape(t.id)}" ${draft.pending ? 'disabled' : ''}><span>${escape(t.fields.title || t.raw || 'Без описания')}</span>${icon('arrowUp')}</button>`).join('')}</div>` : ''}</aside></div>`;
}

document.addEventListener('submit', async event => {
  if (event.target.id !== 'draft-form') return;
  event.preventDefault();
  if (state.draft.pending || state.draft.uncertain || isPreview) return;
  const raw = state.draft.raw.trim();
  if (!raw || !state.draft.industry) { state.draft.error = 'Опишите потребность и выберите сферу бизнеса.'; renderShell(); document.querySelector('.form-error')?.focus(); return; }
  state.draft.pending = true; state.draft.error = ''; renderShell();
  try {
    const task = await createTask({ raw, industry: state.draft.industry });
    state.data.tasks.push(task); state.draft.created = task;
    toast('Черновик сохранён. Команды пока его не видят.');
  } catch (error) {
    state.draft.error = error.message; state.draft.uncertain = Boolean(error.uncertain);
  } finally {
    state.draft.pending = false;
    renderShell();
    if (state.view === 'create') document.querySelector(state.draft.error ? '.form-error' : '.draft-success')?.focus({ preventScroll: false });
  }
}
);

function fieldBlock(label, value, wide = false, confirmed = false) {
  return `<section class="detail-field ${wide ? 'wide' : ''}"><h3>${escape(label)}${value?.trim() ? `<span class="field-status">${confirmed ? "Подтверждено бизнесом" : "Ожидает подтверждения"}</span>` : ""}</h3><p class="${value ? '' : 'missing-value'}">${escape(value || 'Бизнес ещё не указал. Уточните перед началом работы.')}</p></section>`;
}

function openTask(id) {
  const task = state.tasks.find(t => t.id === id) || published().find(t => t.id === id);
  if (!task) { toast('Эта задача пока недоступна в каталоге.'); return; }
  activeDialogTask = task;
  lastDialogTrigger = document.activeElement;
  const level = levelKey(task);
  const proposals = state.data.proposals.filter(p => p.taskId === task.id);
  detailDialog.innerHTML = `<div class="dialog-topline"><span>ПАСПОРТ ЗАДАЧИ <span class="detail-dot">/</span> ${escape(task.industry)}</span><div>${bookmark(task)}<button class="icon-button" data-action="close-detail" aria-label="Закрыть карточку">${icon('close')}</button></div></div>
    <div class="detail-heading"><div class="company">${avatar(task)}<div><span class="company-name">${escape(task.company)}</span><span class="industry-label">Бизнес-задача · открыта всем командам</span></div></div><h2 id="detail-title">${escape(task.fields.title)}</h2><div class="tags">${(task.tags || []).map(tag => `<span>${escape(tag)}</span>`).join('')}</div></div>
    <div class="detail-layout"><div class="detail-main"><div class="detail-field-grid">${fieldBlock('Контекст', task.fields.context, true, task.confirmedFields?.includes('context'))}${fieldBlock('Что нужно изменить', task.fields.need, true, task.confirmedFields?.includes('need'))}${fieldBlock('Для кого', task.fields.users, false, task.confirmedFields?.includes('users'))}${fieldBlock('Данные и материалы', task.fields.data, false, task.confirmedFields?.includes('data'))}${fieldBlock('Ожидаемый результат', task.fields.result, true, task.confirmedFields?.includes('result'))}${fieldBlock('Критерии успеха', task.fields.success, true, task.confirmedFields?.includes('success'))}${fieldBlock('Ограничения', task.fields.constraints, true, task.confirmedFields?.includes('constraints'))}</div><div class="contact-section"><h3>${icon('mail')}Взаимодействие с бизнесом</h3>${fieldBlock('Контакт', task.fields.contact, false, task.confirmedFields?.includes('contact'))}${fieldBlock('Формат консультаций', task.fields.format, false, task.confirmedFields?.includes('format'))}${fieldBlock('Обратная связь', task.fields.feedback, false, task.confirmedFields?.includes('feedback'))}</div>${proposals.length ? `<section class="detail-proposals"><h3>Идеи от команд <span>${proposals.length}</span></h3>${proposals.map(p => { const team = state.data.teams.find(t => t.id === p.teamId); return `<div class="proposal-preview">${avatar(team || { initials: '?', color: 'lavender' })}<div><strong>${escape(team?.name || 'Команда')}</strong><p>${escape(p.idea)}</p><span>${icon('clock')}${escape(p.duration)}</span></div></div>`; }).join('')}</section>` : ''}</div>
    <aside class="detail-rating ${level}"><div class="rating-panel"><div class="rating-panel-top"><h3>Готовность задачи</h3><button class="icon-button" data-action="rating" aria-label="О формуле рейтинга">${icon('info')}</button></div><div class="score-total"><strong>${task.rating.score}</strong><span>/100</span></div>${readinessStrip(task)}<div class="detail-level"><span class="level-dot"></span>${escape(levels[level])}</div><p class="rating-explanation">Баллы за сведения,<br> подтверждённые бизнесом</p><div class="breakdown">${task.rating.breakdown.map(g => `<div class="breakdown-item"><div><span>${escape(g.label)}</span><strong>${g.earned}<span>/${g.max}</span></strong></div><div class="breakdown-track"><span style="width:${g.max ? Math.min(100, g.earned / g.max * 100) : 0}%"></span></div></div>`).join('')}</div>${task.rating.missing.length ? `<div class="missing-panel"><h4>Что уточнить у бизнеса</h4>${task.rating.missing.slice(0, 4).map(m => `<div><span>${escape(m.label)}</span><strong>+${m.weight}</strong></div>`).join('')}${task.rating.missing.length > 4 ? `<p>И ещё ${task.rating.missing.length - 4} ${plural(task.rating.missing.length - 4, ['поле', 'поля', 'полей'])} в карточке</p>` : ''}</div>` : `<div class="complete-note">${icon('check')}Все сведения подтверждены бизнесом</div>`}</div><p class="detail-availability">${icon('globe')}Любая команда может предложить решение независимо от рейтинга.</p></aside></div>
    <div class="dialog-footer"><span>${isPreview ? 'Синтетический пример для демонстрации' : 'Демо-среда · команды выбирает бизнес'}</span><button class="secondary-button" data-action="copy-link">${icon('link')}Скопировать ссылку</button></div>`;
  if (!detailDialog.open) detailDialog.showModal();
  document.body.classList.add('dialog-open');
  const hash = `#task/${encodeURIComponent(id)}`;
  if (location.hash !== hash) history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
}

function openInfo(kind) {
  let content;
  if (kind === 'profile') {
    content = `<div class="info-kicker">ДЕМОНСТРАЦИОННАЯ РОЛЬ</div><h2 id="info-title">От лица какой команды?</h2><p class="info-intro">Выберите команду для демонстрации. Все задачи останутся доступными.</p><div class="team-picker">${state.data.teams.map(t => `<button data-action="select-team" data-id="${escape(t.id)}" class="team-picker-item">${avatar(t)}<span><strong>${escape(t.name)}</strong><small>${escape((t.interests || []).join(' · '))}</small></span>${t.id === state.teamId ? icon('check') : icon('chevron')}</button>`).join('')}</div>`;
  } else if (kind === 'about') {
    content = `<div class="info-kicker">ПРАКТИКА, У КОТОРОЙ ЕСТЬ ЗАКАЗЧИК</div><h2 id="info-title">От задачи до сотрудничества</h2><p class="info-intro">Alem помогает бизнесу сформулировать задачу, а студенческим командам — найти интересную практику.</p><ol class="how-steps"><li><span>01</span><div><h3>Бизнес описывает потребность</h3><p>Уточняет условия, проверяет сведения и публикует карточку. Полнота описания определяет её рейтинг.</p></div></li><li><span>02</span><div><h3>Команды предлагают решения</h3><p>Каталог открыт всем. Команда выбирает интересную задачу и готовит идею с планом работы.</p></div></li><li><span>03</span><div><h3>Бизнес выбирает партнёров</h3><p>Одна, несколько или ни одной команды — решение всегда за человеком.</p></div></li><li><span>04</span><div><h3>Баллы за принятую работу</h3><p>Команда получает баллы после подтверждённого бизнесом результата этапа.</p></div></li></ol>`;
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
  if (view === 'catalog' || view === 'saved') updateCatalog();
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
  if (action === 'create') {
    if (state.draft.pending) return;
    state.role = 'business'; storage.write('role', 'business'); setView('create');
  }
  if (action === 'new-draft' && !state.draft.pending) {
    state.draft = { raw: '', industry: '', pending: false, error: '', uncertain: false, created: null };
    renderShell(); document.querySelector('#draft-raw')?.focus();
  }
  if (action === 'open-draft') {
    const task = ownDrafts().find(t => t.id === id);
    if (task && !state.draft.pending) { state.draft.created = task; state.draft.error = ''; renderShell(); }
  }
  if (action === 'check-drafts') {
    button.disabled = true;
    try { state.data = await loadState(); state.draft.reviewed = true; renderShell(); toast('Список черновиков обновлён. Проверьте сохранённое описание.'); }
    catch (error) { state.draft.error = error.message; renderShell(); }
  }
  if (action === 'refresh' || action === 'retry') boot(true);
});

document.addEventListener('input', event => {
  if (event.target.id === 'draft-raw') { state.draft.raw = event.target.value; document.querySelector('#draft-counter').textContent = `${event.target.value.length} / 4000`; return; }
  if (event.target.id !== 'search-input') return;
  state.filters.query = event.target.value;
  clearTimeout(searchTimer); searchTimer = setTimeout(updateCatalog, 180);
});
document.addEventListener('change', event => {
  if (event.target.id === 'draft-industry') state.draft.industry = event.target.value;
  if (event.target.id === 'level-select') { state.filters.level = event.target.value; updateCatalog(); }
  if (event.target.id === 'role-select') { state.role = event.target.value === 'business' ? 'business' : 'team'; storage.write('role', state.role); if (state.role === 'team' && state.view === 'create') setView('catalog'); else renderShell(); toast(state.role === 'business' ? 'Вы смотрите приложение от лица бизнеса' : 'Вы смотрите приложение от лица команды'); }
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
    app.innerHTML = `<main class="connection-error"><a class="brand" href="/">${brand()}</a><div class="empty-state">${icon('globe')}<h1>Каталог пока недоступен</h1><p>${escape(error.message)}</p><p>Проверьте, запущен ли сервер приложения.<br>Для отдельного просмотра интерфейса доступны тестовые данные.</p><div class="error-actions"><button class="primary-button" data-action="retry">Повторить ${icon('refresh')}</button><a class="secondary-button" href="/?preview=1">Открыть демо-каталог ${icon('arrow')}</a></div></div></main>`;
  }
}

boot();
