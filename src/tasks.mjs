import { cleanFields, enrich, id, INDUSTRIES, now, requireBusiness, requireFound, text, ValidationError } from './domain.mjs';

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

export async function confirmTask(store, taskId, body) {
  const keys = new Set(['role', 'businessId', 'version', 'industry', 'fields', 'confirmed']);
  if (Object.keys(body).some(key => !keys.has(key))) throw new ValidationError('Неизвестное поле запроса.');
  if (body.confirmed !== true) throw new ValidationError('Подтвердите сведения перед сохранением.');
  if (!Number.isSafeInteger(body.version) || body.version < 1) throw new ValidationError('Укажите целую положительную версию задачи.');
  if (!Object.hasOwn(body, 'fields')) throw new ValidationError('Передайте полный снимок полей карточки.');
  const fields = cleanFields(body.fields);
  const industry = text(body.industry, 'Отрасль', {required:true, max:100});
  if (!INDUSTRIES.includes(industry)) throw new ValidationError('Неизвестная отрасль.');
  return store.mutate(state => {
    const task = requireFound(state.tasks, taskId, 'Задача');
    requireBusiness(task, body);
    // Check the current version inside the write queue: a previous request may just have committed.
    if (body.version !== task.version) throw new ValidationError('Задача уже изменена. Перечитайте её перед сохранением; ваши правки можно сравнить с новой версией.', 409);
    if (task.published && !fields.title) throw new ValidationError('У опубликованной задачи должно оставаться название.');
    const confirmedAt = now();
    Object.assign(task, {
      industry, fields, confirmedFields: Object.keys(fields).filter(key => fields[key] !== ''),
      confirmedAt, updatedAt: confirmedAt, version: task.version + 1,
    });
    return enrich(task);
  });
}

export async function publishTask(store, taskId, body) {
  const keys = new Set(['role', 'businessId', 'version']);
  if (Object.keys(body).some(key => !keys.has(key))) throw new ValidationError('Неизвестное поле запроса.');
  if (!Number.isSafeInteger(body.version) || body.version < 1) throw new ValidationError('Укажите целую положительную версию задачи.');
  return store.mutate(state => {
    const task = requireFound(state.tasks, taskId, 'Задача');
    requireBusiness(task, body);
    if (body.version !== task.version) throw new ValidationError('Задача уже изменена. Перечитайте её перед публикацией.', 409);
    if (!task.fields.title?.trim()) throw new ValidationError('Укажите название задачи перед публикацией.');
    const confirmed = new Set(task.confirmedFields ?? []);
    const unconfirmed = Object.entries(task.fields).some(([key, value]) => value.trim() && !confirmed.has(key));
    if (!task.confirmedAt || unconfirmed) throw new ValidationError('Подтвердите текущие сведения карточки перед публикацией.');
    // A retry preserves the first publication date and therefore its position among equal scores.
    if (!task.published) {
      const publishedAt = now();
      Object.assign(task, { published: true, publishedAt, updatedAt: publishedAt, version: task.version + 1 });
    }
    return enrich(task);
  });
}
