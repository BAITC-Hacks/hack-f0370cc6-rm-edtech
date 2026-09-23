import { cleanFields, enrich, id, INDUSTRIES, now, text, ValidationError } from './domain.mjs';

export async function createDraft(store, body) {
  // A demo identity, not authentication; only the known business is supported by this MVP.
  if (body.role !== 'business' || body.businessId !== 'business_demo') {
    throw new ValidationError('Создание задачи доступно демонстрационному бизнесу.', 403);
  }
  const keys = new Set(['role', 'businessId', 'raw', 'industry']);
  if (Object.keys(body).some(key => !keys.has(key))) throw new ValidationError('Неизвестное поле запроса.');
  const raw = text(body.raw, 'Описание потребности', {required:true, max:4000});
  const industry = text(body.industry, 'Отрасль', {required:true, max:100});
  if (!INDUSTRIES.includes(industry)) throw new ValidationError('Неизвестная отрасль.');
  return store.mutate(state => {
    const createdAt = now();
    const task = {
      id: id('task'), businessId: 'business_demo', raw, industry,
      company: 'Мой бизнес', initials: 'МБ', color: 'sky', tags: [],
      fields: cleanFields(), confirmedFields: [], confirmedAt: null,
      published: false, publishedAt: null, createdAt, updatedAt: createdAt, version: 1,
    };
    state.tasks.push(task);
    return enrich(task);
  });
}
