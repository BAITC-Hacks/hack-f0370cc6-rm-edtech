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
