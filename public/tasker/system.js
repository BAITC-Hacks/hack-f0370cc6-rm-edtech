import { isPreview, loadCatalog } from '../api.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const taskSample = document.querySelector('#task-sample');
const ratingSample = document.querySelector('#rating-sample');
const dialog = document.querySelector('#sample-dialog');
const note = document.querySelector('#interaction-note');
let tasks = [], activeTask, dialogTrigger;
const filters = { industry: '', level: '' };

function scale(task) {
  return `<div class="rating-scale" role="img" aria-label="Полнота условий: ${escape(task.rating.score)} из 100. Подробности доступны в диалоге.">${task.rating.breakdown.map(group => `<span class="rating-segment" style="flex:${Number(group.max) || 1}" title="${escape(group.label)}: ${escape(group.earned)} / ${escape(group.max)}"><i style="width:${group.max ? Math.max(0, Math.min(100, group.earned / group.max * 100)) : 0}%"></i></span>`).join('')}</div>`;
}

function score(task) {
  return `<span class="score-number">${escape(task.rating.score)}<small>/ 100</small></span>`;
}

function status(task) {
  const key = ['draft', 'working', 'ready', 'priority'].includes(task.rating.level.key) ? task.rating.level.key : 'draft';
  return `<span class="status status-${key}">${escape(task.rating.level.label)}</span>`;
}

function renderTask(task) {
  activeTask = task;
  const confirmed = key => task.confirmedFields?.includes(key) && task.fields[key]?.trim();
  taskSample.innerHTML = `<article class="task-row" aria-labelledby="sample-task-title">
    <div class="task-company"><strong>${escape(task.company)}</strong><span class="task-industry">${escape(task.industry)}</span></div>
    <div class="task-body"><h3 id="sample-task-title">${escape(task.fields.title)}</h3><p>${escape(task.fields.need || task.raw)}</p><div class="task-conditions">${[['data', 'Материалы', 'подтверждены'], ['result', 'Результат', 'подтверждён'], ['success', 'Приёмка', 'подтверждена']].map(([key, label, confirmation]) => `<span class="task-condition ${confirmed(key) ? 'is-confirmed' : ''}">${label}: ${confirmed(key) ? confirmation : 'нужно уточнить'}</span>`).join('')}</div></div>
    <div class="task-rating"><span class="score-label">Полнота условий</span>${score(task)}${scale(task)}${status(task)}<button class="text-button" type="button" data-open-dialog>Разобрать рейтинг <span aria-hidden="true">↗</span></button></div>
  </article>`;
  ratingSample.innerHTML = `<div class="rating-sample-top">${score(task)}<span class="score-label">Полнота условий</span></div>${scale(task)}<p class="component-note">Длина сегмента — вес группы.<br>Заполнение — полученные баллы.</p>`;
  document.querySelector('#dialog-rating').innerHTML = `<div class="dialog-task"><p>${escape(task.fields.title)}</p>${score(task)}</div>${scale(task)}<ul class="breakdown">${task.rating.breakdown.map(g => `<li><span>${escape(g.label)}</span><strong>${escape(g.earned)} / ${escape(g.max)}</strong></li>`).join('')}</ul>`;
  document.querySelectorAll('[data-open-dialog]').forEach(button => { button.disabled = false; });
}

function applyFilters() {
  const matches = tasks.filter(task => (!filters.industry || task.industry === filters.industry) && (!filters.level || task.rating.level.key === filters.level));
  if (matches.length) {
    renderTask(matches.find(task => task.id === 'task_service') || matches[0]);
    note.textContent = 'Показан один подходящий пример из демо-набора. Рейтинг взят из данных проекта.';
  } else {
    taskSample.innerHTML = '<p class="load-message">В демо-наборе нет задачи с таким сочетанием. Снимите фильтр, чтобы увидеть пример строки.</p>';
    note.textContent = 'Шкала и диалог сохраняют последний показанный пример.';
  }
}

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-open-dialog') && activeTask) {
    dialogTrigger = button;
    dialog.showModal();
  } else if (button.hasAttribute('data-nav')) {
    document.querySelectorAll('[data-nav]').forEach(item => item.removeAttribute('aria-current'));
    button.setAttribute('aria-current', 'page');
    note.textContent = `Образец выбранного раздела: «${button.dataset.nav}». Здесь проверяется только навигация; переходы подключим при переносе системы в приложение.`;
  } else if (button.hasAttribute('data-industry')) {
    filters.industry = button.dataset.industry;
    document.querySelectorAll('[data-industry]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    applyFilters();
  } else if (button.hasAttribute('data-sample-action')) {
    note.textContent = `«${button.dataset.sampleAction}» — образец кнопки. Данные не отправлялись и не сохранялись.`;
  }
});

document.querySelector('#sample-level').addEventListener('change', event => {
  filters.level = event.target.value;
  applyFilters();
});

document.querySelectorAll('[name="ui-size"]').forEach(input => input.addEventListener('change', () => {
  document.documentElement.style.setProperty('--ui-test-size', `${input.value}px`);
  note.textContent = `Verdana ${input.value} px в кнопках, навигации и фильтрах. Заголовки Georgia Bold и поле ввода не меняются.`;
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
  renderTask(tasks.find(task => task.id === 'task_service') || tasks[0]);
  note.textContent = isPreview ? 'Статический просмотр: примеры из файла проекта. Изменения не сохраняются.' : 'Демо-задача и её рейтинг загружены через API. Изменения не сохраняются.';
} catch (error) {
  taskSample.innerHTML = `<p class="load-message" role="alert">Не удалось загрузить пример: ${escape(error.message)}</p>`;
  ratingSample.innerHTML = '<p class="component-note">Рейтинг недоступен. Пример не подменяется выдуманными данными.</p>';
} finally {
  taskSample.setAttribute('aria-busy', 'false');
}
