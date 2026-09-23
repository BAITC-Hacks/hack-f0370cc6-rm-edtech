import { cleanFields, id, INDUSTRIES, now, rate, requireFound, text, ValidationError } from '../domain.mjs';

const statuses = ['open', 'in_progress', 'completed', 'closed'];

function knownKeys(body, keys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Ожидается объект запроса.');
  if (Object.keys(body).some(key => !keys.includes(key))) throw new ValidationError('Неизвестное поле запроса.');
}

function actor(state, userId, role) {
  const user = state.users.find(user => user.id === userId);
  if (!user) throw new ValidationError('Войдите в аккаунт.', 401);
  if (role && user.activeRole !== role) throw new ValidationError(`Переключитесь в режим ${role === 'business' ? 'бизнеса' : 'студента'}.`, 403);
  return user;
}

function ownedOrder(state, userId, orderId) {
  actor(state, userId, 'business');
  const order = requireFound(state.orders, orderId, 'Задача');
  if (order.ownerId !== userId) throw new ValidationError('Это действие доступно владельцу задачи.', 403);
  return order;
}

function validVersion(version) {
  if (!Number.isSafeInteger(version) || version < 1) throw new ValidationError('Укажите целую положительную версию задачи.');
}

function currentVersion(order, version) {
  if (order.version !== version) throw new ValidationError('Задача уже изменена. Перечитайте её перед действием.', 409);
}

function publicOrder(state, order) {
  const owner = state.users.find(user => user.id === order.ownerId);
  return {
    id: order.id, ownerId: order.ownerId, title: order.title, category: order.category,
    description: order.description, status: order.status, version: order.version,
    attachments: [...order.attachments], createdAt: order.createdAt,
    publishedAt: order.publishedAt, updatedAt: order.updatedAt,
    fields: order.fields ?? cleanFields({title:order.title,context:order.description}),
    confirmedFields: order.confirmedFields ?? [], confirmedAt: order.confirmedAt ?? null,
    rating: rate(order), isDemo: Boolean(order.isDemo),
    owner: { id: order.ownerId, name: owner?.name ?? '', companyName: owner?.business?.companyName ?? '', industry: owner?.business?.industry ?? '' },
  };
}

function changeStatus(order, status, userId, at, evidence = '') {
  if (order.status === status) return;
  order.history.push({ from: order.status, to: status, actorId: userId, at, evidence });
  order.status = status;
}

export async function createOrder(store, userId, body) {
  knownKeys(body, ['title', 'category', 'description', 'fields', 'confirmed']);
  const title = text(body.title, 'Название задачи', { required: true, max: 160 });
  const category = text(body.category, 'Категория', { required: true, max: 100 });
  if (!INDUSTRIES.includes(category)) throw new ValidationError('Неизвестная категория.');
  const description = text(body.description, 'Описание задачи', { required: true, max: 4000 });
  const fields = cleanFields(body.fields ?? {title,context:description});
  if (body.fields !== undefined && body.confirmed !== true) throw new ValidationError('Подтвердите введённые условия перед публикацией.');
  if (body.confirmed !== undefined && body.confirmed !== true) throw new ValidationError('Подтверждение должно быть явным.');
  if (fields.title && fields.title !== title) throw new ValidationError('Название в условиях должно совпадать с названием заказа.');
  fields.title = title;
  return store.mutate(state => {
    actor(state, userId, 'business');
    const createdAt = now();
    const order = {
      id: id('order'), ownerId: userId, title, category, description, status: 'open',
      version: 1, attachments: [], createdAt, publishedAt: createdAt, updatedAt: createdAt,
      history: [{ from: null, to: 'open', actorId: userId, at: createdAt, evidence: '' }],
      fields, confirmedFields:body.confirmed === true ? Object.keys(fields).filter(key=>fields[key]) : [],
      confirmedAt:body.confirmed === true ? createdAt : null,
    };
    state.orders.push(order);
    return {...order,rating:rate(order)};
  });
}

export function listOrders(store, filters = {}) {
  knownKeys(filters, ['category', 'query']);
  const category = text(filters.category, 'Категория', { max: 100 });
  if (category && !INDUSTRIES.includes(category)) throw new ValidationError('Неизвестная категория.');
  const query = text(filters.query, 'Поиск', { max: 4000 }).toLocaleLowerCase('ru');
  const state = store.read();
  return state.orders.filter(order => order.status === 'open')
    .map(order => publicOrder(state, order))
    .filter(order => (!category || order.category === category) && (!query ||
      `${order.title} ${order.description} ${order.category} ${order.owner.companyName}`.toLocaleLowerCase('ru').includes(query)))
    .sort((a, b) => b.rating.score-a.rating.score || a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));
}

export function getOrder(store, orderId) {
  const state = store.read();
  return publicOrder(state, requireFound(state.orders, orderId, 'Задача'));
}

export function listOwnOrders(store, userId) {
  const state = store.read();
  actor(state, userId, 'business');
  return state.orders.filter(order => order.ownerId === userId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .map(order=>({...order,rating:rate(order)}));
}

export async function updateOrder(store, userId, orderId, body) {
  knownKeys(body,['version','title','category','description','fields','confirmed']);
  validVersion(body.version);
  if (body.confirmed !== true || !Object.hasOwn(body,'fields')) throw new ValidationError('Проверьте и подтвердите полный снимок условий.');
  const title = text(body.title,'Название задачи',{required:true,max:160});
  const description = text(body.description,'Описание задачи',{required:true,max:4000});
  const category = text(body.category,'Категория',{required:true,max:100});
  if (!INDUSTRIES.includes(category)) throw new ValidationError('Неизвестная категория.');
  const fields = cleanFields(body.fields);
  if (fields.title && fields.title !== title) throw new ValidationError('Название в условиях должно совпадать с названием заказа.');
  fields.title = title;
  const version = body.version;
  return store.mutate(state=>{
    const order = ownedOrder(state,userId,orderId);
    currentVersion(order,version);
    if (order.status !== 'open') throw new ValidationError('Условия можно редактировать до начала работы.',409);
    Object.assign(order,{title,category,description,fields,
      confirmedFields:Object.keys(fields).filter(key=>fields[key]),confirmedAt:now(),updatedAt:now(),version:order.version+1});
    return {...order,rating:rate(order)};
  });
}

export async function applyToOrder(store, userId, orderId, body) {
  knownKeys(body, ['message']);
  const message = text(body.message, 'Сообщение бизнесу', { required: true, max: 4000 });
  return store.mutate(state => {
    actor(state, userId, 'student');
    const order = requireFound(state.orders, orderId, 'Задача');
    if (order.ownerId === userId) throw new ValidationError('Нельзя откликнуться на собственную задачу.', 403);
    if (order.status !== 'open') throw new ValidationError('Приём новых откликов доступен у открытой задачи.', 409);
    if (state.applications.some(application => application.orderId === orderId && application.studentId === userId &&
      ['pending', 'accepted'].includes(application.status))) {
      throw new ValidationError('У вас уже есть активный отклик на эту задачу.', 409);
    }
    const createdAt = now();
    const application = {
      id: id('application'), orderId, studentId: userId, message, status: 'pending', createdAt, updatedAt: createdAt,
    };
    state.applications.push(application);
    return application;
  });
}

export function listApplications(store, userId, orderId) {
  const state = store.read();
  const user = actor(state, userId);
  const order = requireFound(state.orders, orderId, 'Задача');
  if (user.activeRole === 'business' && order.ownerId !== userId) throw new ValidationError('Отклики доступны владельцу задачи.', 403);
  if (!['business', 'student'].includes(user.activeRole)) throw new ValidationError('Выберите режим студента или бизнеса.', 403);
  return state.applications.filter(application => application.orderId === orderId &&
    (user.activeRole === 'business' || application.studentId === userId));
}

export async function decideApplication(store, userId, applicationId, body) {
  knownKeys(body, ['status', 'version']);
  if (!['accepted', 'rejected'].includes(body.status)) throw new ValidationError('Выберите принятие или отклонение отклика.');
  validVersion(body.version);
  return store.mutate(state => {
    const application = requireFound(state.applications, applicationId, 'Заявка');
    const order = ownedOrder(state, userId, application.orderId);
    currentVersion(order, body.version);
    if (!['open', 'in_progress'].includes(order.status)) throw new ValidationError('Решения по завершённой или закрытой задаче зафиксированы.', 409);
    if (application.status === body.status) return { application, order };
    const at = now();
    application.status = body.status;
    application.updatedAt = at;
    if (body.status === 'accepted') changeStatus(order, 'in_progress', userId, at);
    else if (order.status === 'in_progress' && !state.applications.some(item => item.orderId === order.id && item.status === 'accepted')) {
      // Proposal for API v2: removing the last selected participant reopens the same publication.
      changeStatus(order, 'open', userId, at);
    }
    order.version += 1;
    order.updatedAt = at;
    return { application, order };
  });
}

export async function transitionOrder(store, userId, orderId, body) {
  knownKeys(body, ['status', 'version', 'evidence']);
  if (!statuses.includes(body.status)) throw new ValidationError('Неизвестный статус задачи.');
  validVersion(body.version);
  const evidence = text(body.evidence, 'Результат проверки или причина закрытия', { max: 4000 });
  return store.mutate(state => {
    const order = ownedOrder(state, userId, orderId);
    currentVersion(order, body.version);
    if (order.status === body.status) return order;
    const allowed = { open: ['closed'], in_progress: ['completed', 'closed'], completed: ['closed'], closed: [] };
    if (!allowed[order.status]?.includes(body.status)) throw new ValidationError('Такой переход статуса недоступен.', 409);
    if (order.status === 'in_progress' && !evidence) throw new ValidationError('Опишите принятый результат или причину закрытия.');
    const at = now();
    changeStatus(order, body.status, userId, at, evidence);
    order.version += 1;
    order.updatedAt = at;
    return order;
  });
}
