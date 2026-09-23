// Transport only. Ratings always come from the backend or the exported preview fixture.
export const isPreview = new URLSearchParams(location.search).get('preview') === '1';
let previewState;

async function getJSON(url, signal) {
  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
  let body;
  try { body = await response.json(); }
  catch { throw new Error('Сервер вернул ответ в неожиданном формате.'); }
  if (!response.ok) throw new Error(body?.error?.message || `Не удалось загрузить данные (${response.status}).`);
  return body;
}

function checkTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.some(t => !t || typeof t.id !== 'string' || !t.fields || !t.rating || !Number.isFinite(t.rating.score) || t.rating.score < 0 || t.rating.score > 100 || !t.rating.level || !Array.isArray(t.rating.breakdown) || !Array.isArray(t.rating.missing))) {
    throw new Error('Формат карточек не совпадает с контрактом API.');
  }
  return tasks;
}

export async function loadState() {
  const data = await getJSON(isPreview ? '/preview-data.json' : '/api/state');
  checkTasks(data.tasks);
  if (!Array.isArray(data.teams) || !Array.isArray(data.proposals) || !Array.isArray(data.meta?.industries)) throw new Error('Не удалось прочитать команды и настройки каталога.');
  if (isPreview) previewState = data;
  return data;
}

export async function loadCatalog(filters = {}, signal) {
  if (isPreview) {
    if (!previewState) await loadState();
    const query = (filters.query || '').toLocaleLowerCase('ru').trim();
    return previewState.tasks.filter(t => t.published)
      .filter(t => !filters.industry || t.industry === filters.industry)
      .filter(t => !filters.level || t.rating.level.key === filters.level)
      .filter(t => !query || `${Object.values(t.fields).join(' ')} ${t.company} ${t.industry} ${(t.tags || []).join(' ')}`.toLocaleLowerCase('ru').includes(query))
      .sort((a, b) => b.rating.score - a.rating.score || String(a.publishedAt).localeCompare(String(b.publishedAt)));
  }
  const params = new URLSearchParams();
  for (const key of ['query', 'industry', 'level']) if (filters[key]) params.set(key, filters[key]);
  const data = await getJSON(`/api/catalog${params.size ? `?${params}` : ''}`, signal);
  // Fail closed if an endpoint accidentally returns a private draft.
  return checkTasks(data.tasks).filter(t => t.published === true);
}

export async function createTask({ raw, industry }) {
  if (isPreview) throw new Error('В режиме просмотра черновики не сохраняются. Откройте приложение без preview.');
  let response;
  try {
    response = await fetch('/api/tasks', {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'business', businessId: 'business_demo', raw, industry }),
    });
  } catch {
    throw Object.assign(new Error('Ответ о сохранении не получен. Проверьте черновики перед повторной отправкой.'), { uncertain: true });
  }
  let body;
  try { body = await response.json(); }
  catch { throw Object.assign(new Error('Не удалось прочитать подтверждение сохранения. Проверьте черновики.'), { uncertain: true }); }
  if (!response.ok) throw Object.assign(new Error(body?.error?.message || 'Не удалось сохранить черновик.'), { uncertain: response.status >= 500 });
  try {
    const [task] = checkTasks([body.task]);
    if (response.status !== 201 || task.published !== false || task.businessId !== 'business_demo') throw new Error();
    return task;
  } catch { throw Object.assign(new Error('Ответ не содержит корректный черновик. Проверьте сохранённые задачи.'), { uncertain: true }); }
}
