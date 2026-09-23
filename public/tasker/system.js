import { isPreview, loadCatalog } from '../api.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const taskSample = document.querySelector('#task-sample');
const picker = document.querySelector('#sample-task');
const dialog = document.querySelector('#sample-dialog');
const note = document.querySelector('#interaction-note');
const labels = {
  context: 'Контекст', need: 'Потребность', data: 'Данные и материалы', result: 'Ожидаемый результат',
  success: 'Критерии успеха', constraints: 'Ограничения', users: 'Пользователи',
  contact: 'Контакт', format: 'Формат взаимодействия', feedback: 'Обратная связь',
};
const windowLabels = { context: 'Контекст', data: 'Данные', result: 'Результат', success: 'Приёмка', constraints: 'Ограничения', users: 'Пользователи', contact: 'Связь' };
const filters = { industry: '', level: '', query: '' };
let tasks = [], activeTask, dialogTrigger;

// Illumination follows the server's missing list and confirmed snapshot.
// Group earnings and the total come directly from the server, never a local sum.
function fieldState(task, group, key) {
  if (!task.fields[key]?.trim()) return 'missing';
  return task.confirmedFields?.includes(key) && !group.missing.some(item => item.key === key) ? 'lit' : 'pending';
}

function windows(task, prefix, compact = false) {
  const groups = task.rating.breakdown;
  return `<div class="light-windows${compact ? ' is-compact' : ''}" ${compact ? `role="img" aria-label="Полнота условий ${escape(task.rating.score)} из 100. Расшифровка ниже в паспорте."` : 'role="group" aria-label="Перейти к условиям задачи"'} style="--window-columns:${groups.map(group => `${Number(group.max) || 1}fr`).join(' ')}">${groups.map((group, index) => {
    const track = `<span class="window-track" aria-hidden="true">${group.parts.map(([key, weight]) => `<span class="window-part is-${fieldState(task, group, key)}" style="flex:${Number(weight) || 1}"></span>`).join('')}</span>`;
    if (compact) return `<span class="light-window" title="${escape(group.label)}: ${escape(group.earned)} / ${escape(group.max)}">${track}</span>`;
    return `<button type="button" class="light-window" data-field-group="${prefix}-group-${index}" style="--group-weight:${Number(group.max) || 1}" aria-label="${escape(group.label)}: ${escape(group.earned)} из ${escape(group.max)}. Перейти к полям.">${track}<span class="window-label">${escape(windowLabels[group.parts[0]?.[0]] || group.label)}</span><span class="window-score">${escape(group.earned)}<span> / ${escape(group.max)}</span></span></button>`;
  }).join('')}</div>`;
}

function score(task) {
  return `<span class="score-number">${escape(task.rating.score)}<small>/ 100</small></span>`;
}

function status(task) {
  const key = ['draft', 'working', 'ready', 'priority'].includes(task.rating.level.key) ? task.rating.level.key : 'draft';
  return `<span class="status status-${key}">${escape(task.rating.level.label)}</span>`;
}

function fields(task, prefix) {
  return `<div class="passport-fields">${task.rating.breakdown.map((group, index) => `<section class="field-group" id="${prefix}-group-${index}" tabindex="-1" aria-label="${escape(group.label)}">${group.parts.map(([key, weight]) => {
    const state = fieldState(task, group, key);
    const stateLabel = state === 'lit' ? 'Подтверждено бизнесом' : state === 'pending' ? 'Ожидает подтверждения' : 'Не указано';
    return `<div class="passport-field is-${state}" data-field="${escape(key)}"><h4>${escape(labels[key] || key)}</h4><p class="field-content">${escape(task.fields[key]?.trim() || 'Бизнес ещё не указал эти сведения.')}</p><div class="field-meta"><span class="field-points">${state === 'lit' ? Number(weight) : 0}<span> / ${Number(weight)}</span></span><span class="field-status">${stateLabel}</span></div></div>`;
  }).join('')}</section>`).join('')}</div>`;
}

function renderTask(task) {
  activeTask = task;
  const conditions = ['data', 'result', 'success'].map(key => {
    const group = task.rating.breakdown.find(item => item.parts.some(([part]) => part === key));
    const state = fieldState(task, group, key);
    return `<span class="task-condition is-${state}"><span>${escape(windowLabels[key])}</span><strong>${state === 'lit' ? 'Подтверждено' : state === 'pending' ? 'Ждёт подтверждения' : 'Не указано'}</strong></span>`;
  }).join('');
  taskSample.innerHTML = `<article class="task-document" aria-labelledby="sample-task-title">
    <div class="task-row"><div class="task-company"><span class="eyebrow">БИЗНЕС / ${escape(task.industry)}</span><strong>${escape(task.company)}</strong><span class="task-reference">Демонстрационная задача</span></div>
      <div class="task-body"><h2 id="sample-task-title">${escape(task.fields.title)}</h2><p>${escape(task.fields.need || task.raw)}</p><div class="task-conditions">${conditions}</div></div>
      <div class="task-rating"><span class="score-label">Полнота условий</span>${score(task)}${windows(task, 'compact', true)}${status(task)}<button class="text-button ui-sample" type="button" data-open-dialog>Разобрать рейтинг <span aria-hidden="true">↗</span></button></div>
    </div>
    <details class="passport" open><summary><span>Паспорт задачи</span><span class="passport-toggle">Условия и подтверждения <span aria-hidden="true">−</span></span></summary>
      <div class="passport-intro"><p>Какие условия уже определены</p><span>Выберите окно, чтобы перейти к полю</span></div>
      ${windows(task, 'passport')}
      <div class="light-legend"><span><i class="legend-lit" aria-hidden="true"></i>Подтверждено бизнесом</span><span><i class="legend-missing" aria-hidden="true"></i>Есть пробелы в условиях</span></div>
      ${fields(task, 'passport')}
      <p class="passport-note">Рейтинг показывает полноту подтверждённых условий. Откликнуться можно при любом рейтинге.</p>
    </details>
  </article>`;
  document.querySelector('#dialog-rating').innerHTML = `<div class="dialog-task"><p>${escape(task.fields.title)}</p>${score(task)}</div>${windows(task, 'dialog')}${fields(task, 'dialog')}`;
  document.querySelectorAll('[data-open-dialog]').forEach(button => { button.disabled = false; });
}

function applyFilters(preferredId = activeTask?.id || 'task_logistics') {
  const query = filters.query.trim().toLocaleLowerCase('ru');
  const matches = tasks.filter(task => (!filters.industry || task.industry === filters.industry)
    && (!filters.level || task.rating.level.key === filters.level)
    && (!query || `${Object.values(task.fields).join(' ')} ${task.company} ${task.industry} ${(task.tags || []).join(' ')}`.toLocaleLowerCase('ru').includes(query)));
  picker.disabled = !matches.length;
  if (matches.length) {
    const task = matches.find(item => item.id === preferredId) || matches[0];
    picker.innerHTML = matches.map(item => `<option value="${escape(item.id)}">${escape(item.rating.score)} / 100 — ${escape(item.company)}</option>`).join('');
    picker.value = task.id;
    renderTask(task);
    note.textContent = isPreview ? 'Статический просмотр: демонстрационные данные из файла проекта. Изменения не сохраняются.' : `Показан один из ${matches.length} подходящих демо-примеров. Рейтинг и подтверждения получены от сервера.`;
  } else {
    activeTask = undefined;
    picker.innerHTML = '<option>Нет подходящих примеров</option>';
    taskSample.innerHTML = '<div class="load-message"><p>В демо-наборе нет задачи с таким сочетанием.</p><button class="text-button" type="button" data-reset-filters>Сбросить поиск и фильтры</button></div>';
    document.querySelector('#dialog-rating').replaceChildren();
    document.querySelectorAll('[data-open-dialog]').forEach(button => { button.disabled = true; });
    note.textContent = 'Совпадений нет. Сбросьте поиск и фильтры, чтобы увидеть все демонстрационные примеры.';
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-open-dialog') && activeTask) {
    dialogTrigger = button;
    dialog.showModal();
  } else if (button.hasAttribute('data-field-group')) {
    const group = document.getElementById(button.dataset.fieldGroup);
    group?.focus({ preventScroll: true });
    group?.scrollIntoView({ block: 'center' });
  } else if (button.hasAttribute('data-nav')) {
    document.querySelectorAll('[data-nav]').forEach(item => item.removeAttribute('aria-current'));
    button.setAttribute('aria-current', 'page');
    note.textContent = `«${button.dataset.nav}» — образец состояния навигации. Вы находитесь в витрине компонентов.`;
  } else if (button.hasAttribute('data-industry')) {
    filters.industry = button.dataset.industry;
    document.querySelectorAll('[data-industry]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    applyFilters();
  } else if (button.hasAttribute('data-reset-filters')) {
    filters.industry = filters.level = filters.query = '';
    document.querySelector('#sample-input').value = '';
    document.querySelector('#sample-level').value = '';
    document.querySelectorAll('[data-industry]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.industry === '')));
    applyFilters();
    document.querySelector('#sample-input').focus();
  } else if (button.hasAttribute('data-sample-action')) {
    note.textContent = `«${button.dataset.sampleAction}» — образец кнопки. Данные не отправлялись и не сохранялись.`;
  }
});

picker.addEventListener('change', event => applyFilters(event.target.value));
document.querySelector('#sample-level').addEventListener('change', event => { filters.level = event.target.value; applyFilters(); });
document.querySelector('#sample-input').addEventListener('input', event => { filters.query = event.target.value; applyFilters(); });
document.querySelectorAll('[name="ui-size"]').forEach(input => input.addEventListener('change', () => {
  document.documentElement.style.setProperty('--ui-test-size', `${input.value}px`);
  note.textContent = `Commissioner ${input.value} px в кнопках, навигации и фильтрах. Размер заголовков и поля ввода сохраняется.`;
}));

dialog.addEventListener('close', () => { if (dialogTrigger?.isConnected) dialogTrigger.focus(); });
dialog.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const buttons = [...dialog.querySelectorAll('button:not([disabled])')];
  const first = buttons[0], last = buttons.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

try {
  tasks = await loadCatalog();
  if (!tasks.length) throw new Error('Нет опубликованных задач для примера.');
  applyFilters();
} catch (error) {
  taskSample.innerHTML = `<p class="load-message" role="alert">Не удалось загрузить пример: ${escape(error.message)}</p>`;
  picker.innerHTML = '<option>Примеры недоступны</option>';
  note.textContent = 'Рейтинг недоступен. Ошибка не подменяется демонстрационным ответом.';
} finally {
  taskSample.setAttribute('aria-busy', 'false');
}
