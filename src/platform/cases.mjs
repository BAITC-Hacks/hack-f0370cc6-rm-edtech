import { id, now, text, ValidationError } from '../domain.mjs';

const editable = ['title', 'problem', 'approach', 'result', 'contribution', 'skills', 'orderId'];
const narrativeFields = ['title', 'problem', 'approach', 'result', 'contribution'];
export const CONTRIBUTION_SOURCE = 'Со слов участника';

function object(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) {
    throw new ValidationError('Проверьте поля кейса.');
  }
}

function userIn(state, userId, student = false) {
  const user = state.users.find(user => user.id === userId);
  if (!user) throw new ValidationError('Войдите в аккаунт.', 401);
  if (student && user.activeRole !== 'student') throw new ValidationError('Переключитесь в режим студента.', 403);
  return user;
}

function clean(input, partial = false) {
  const result = {};
  for (const key of narrativeFields) {
    if (partial && !Object.hasOwn(input, key)) continue;
    const value = input[key] ?? (partial ? undefined : '');
    if (typeof value !== 'string') throw new ValidationError(`${key}: ожидается текст.`);
    result[key] = text(value, key, { required: key === 'title', max: key === 'title' ? 160 : 4000 });
  }
  if (!partial || Object.hasOwn(input, 'skills')) {
    const skills = input.skills ?? [];
    if (!Array.isArray(skills) || skills.length > 30) throw new ValidationError('Укажите не более 30 навыков.');
    result.skills = [...new Set(skills.map(value => {
      if (typeof value !== 'string') throw new ValidationError('Навык должен быть строкой.');
      return text(value, 'Навык', { required: true, max: 80 });
    }))];
  }
  if (!partial || Object.hasOwn(input, 'orderId')) {
    if (input.orderId !== undefined && input.orderId !== null && typeof input.orderId !== 'string') {
      throw new ValidationError('Некорректная ссылка на задачу.');
    }
    result.orderId = input.orderId == null ? null : text(input.orderId, 'Задача', { required: true, max: 160 });
  }
  return result;
}

function requireLinkedParticipation(state, userId, orderId) {
  if (!orderId) return;
  const order = state.orders.find(order => order.id === orderId);
  if (!order) throw new ValidationError('Связанная задача не найдена.', 404);
  if (order.ownerId === userId || !state.applications.some(application => application.orderId === orderId &&
    application.studentId === userId && application.status === 'accepted')) {
    throw new ValidationError('Можно связать только задачу, для которой вас выбрал бизнес.', 403);
  }
}

function completionFor(state, userId, orderId) {
  const order = state.orders.find(order => order.id === orderId);
  if (!order || order.ownerId === userId || !['completed', 'closed'].includes(order.status)) return null;
  if (!state.applications.some(application => application.orderId === order.id &&
    application.studentId === userId && application.status === 'accepted')) return null;
  const event = order.history?.find(event => event.from === 'in_progress' && event.to === 'completed' &&
    event.actorId === order.ownerId && typeof event.evidence === 'string' && event.evidence.trim() &&
    Number.isFinite(Date.parse(event.at)));
  return event ? { order, event } : null;
}

function taskConfirmation(state, caseRecord) {
  const completion = completionFor(state, caseRecord.userId, caseRecord.orderId);
  if (!completion) return null;
  // This confirms a related order's result, NEVER arbitrary portfolio prose.
  // Private acceptance evidence is deliberately absent from the public case.
  return { orderId: completion.order.id, businessId: completion.order.ownerId,
    confirmedAt: completion.event.at, label: 'Связанный результат принят бизнесом' };
}

function projectCase(state, record) {
  return {
    id: record.id, userId: record.userId,
    ...Object.fromEntries(editable.map(key => [key, structuredClone(record[key])])),
    version: record.version, published: record.published, createdAt: record.createdAt, updatedAt: record.updatedAt,
    taskConfirmation: taskConfirmation(state, record), contributionSource: CONTRIBUTION_SOURCE,
  };
}

function completeCase(record) {
  return narrativeFields.every(key => typeof record[key] === 'string' && record[key].trim());
}

export async function createCase(store, userId, input) {
  object(input, editable);
  const fields = clean(input);
  return store.mutate(state => {
    userIn(state, userId, true);
    requireLinkedParticipation(state, userId, fields.orderId);
    const createdAt = now();
    const record = { id: id('case'), userId, ...fields, version: 1, published: false, createdAt, updatedAt: createdAt };
    (state.cases ??= []).push(record);
    return projectCase(state, record);
  });
}

export async function updateCase(store, userId, caseId, input) {
  object(input, ['version', ...editable, 'published']);
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new ValidationError('Укажите текущую версию кейса.');
  if (Object.hasOwn(input, 'published') && typeof input.published !== 'boolean') throw new ValidationError('Укажите статус публикации true или false.');
  const patch = clean(input, true);
  return store.mutate(state => {
    userIn(state, userId, true);
    const record = (state.cases ?? []).find(record => record.id === caseId);
    if (!record) throw new ValidationError('Кейс не найден.', 404);
    if (record.userId !== userId) throw new ValidationError('Кейс редактирует только его автор.', 403);
    if (record.version !== input.version) throw new ValidationError('Кейс уже изменён. Перечитайте его.', 409);
    if (Object.hasOwn(patch, 'orderId')) requireLinkedParticipation(state, userId, patch.orderId);
    const next = { ...record, ...patch, published: input.published ?? record.published };
    if (next.published && !completeCase(next)) throw new ValidationError('Для публикации заполните задачу, подход, результат и личный вклад.');
    Object.assign(record, next, { version: record.version + 1, updatedAt: now() });
    return projectCase(state, record);
  });
}

export function listOwnCases(store, userId) {
  const state = store.read();
  userIn(state, userId);
  return (state.cases ?? []).filter(record => record.userId === userId)
    .map(record => projectCase(state, record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function listPublicCases(store, userId) {
  const state = store.read();
  if (!state.users.some(user => user.id === userId)) throw new ValidationError('Профиль не найден.', 404);
  return (state.cases ?? []).filter(record => record.userId === userId && record.published === true)
    .map(record => projectCase(state, record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function profileProgress(store, userId) {
  const state = store.read();
  const user = state.users.find(user => user.id === userId);
  if (!user) throw new ValidationError('Профиль не найден.', 404);
  // Declared product rules, not an AI judgement of a person's ability:
  // profile +10 once; complete published self-described cases +5 each, cap +20;
  // genuine business reviews +50 per distinct completed accepted order.
  const profileComplete = Boolean(user.name?.trim() && user.contacts?.trim() && user.student?.skills?.length);
  const publishedCases = (state.cases ?? []).filter(record => record.userId === userId && record.published === true && completeCase(record)).length;
  const reviewedOrders = new Set();
  for (const review of state.reviews) {
    if (review.studentId !== userId || typeof review.text !== 'string' || !review.text.trim()) continue;
    const completion = completionFor(state, userId, review.orderId);
    if (completion && review.authorId === completion.order.ownerId && review.completedAt === completion.event.at) {
      reviewedOrders.add(review.orderId);
    }
  }
  const breakdown = [
    { label: 'Заполненный профиль', points: profileComplete ? 10 : 0, source: 'profile' },
    { label: 'Опубликованные кейсы — со слов участника (до 20)', points: Math.min(20, publishedCases * 5), source: 'cases' },
    { label: 'Отзывы бизнеса по принятым результатам', points: reviewedOrders.size * 50, source: 'business_reviews' },
  ];
  const total = breakdown.reduce((sum, item) => sum + item.points, 0);
  return { total, rank: total >= 100 ? 'Опыт' : total >= 30 ? 'Практика' : 'Старт', breakdown };
}
