import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPlatformStore } from '../../src/platform/store.mjs';
import { applyToOrder, createOrder, decideApplication, getOrder, listApplications, listOrders, listOwnOrders, transitionOrder, updateOrder } from '../../src/platform/orders.mjs';
import { temporaryDirectory } from './helpers.mjs';

const input = { title: 'Учёт заявок', category: 'Услуги', description: 'Нужен понятный учёт входящих обращений.' };
const user = (id, activeRole) => ({
  id, activeRole, name: id, email: `${id}@private.example`, contacts: 'PRIVATE_CONTACT', passwordHash: 'PRIVATE_HASH',
  business: { companyName: `Компания ${id}`, industry: 'Услуги' }, student: { skills: [], portfolio: [] },
});

async function setup(t) {
  const file = join(await temporaryDirectory(t), 'platform.json');
  const store = await createPlatformStore(file);
  await store.mutate(state => state.users.push(user('owner', 'business'), user('other', 'business'), user('student', 'student'), user('student2', 'student')));
  return { store, file };
}

async function snapshot(store, file) {
  return { state: store.read(), bytes: await readFile(file) };
}

async function unchanged(store, file, before) {
  assert.deepEqual(store.read(), before.state);
  assert.deepEqual(await readFile(file), before.bytes);
}

const rejected = (promise, status) => assert.rejects(promise, error => error.status === status);
const apply = (store, orderId, studentId = 'student') => applyToOrder(store, studentId, orderId, { message: 'Могу собрать и проверить прототип.' });

async function started(store) {
  const order = await createOrder(store, 'owner', input);
  const application = await apply(store, order.id);
  return decideApplication(store, 'owner', application.id, { status: 'accepted', version: order.version });
}

test('business creates a separate open order with server fields and a public projection without account secrets', async t => {
  const { store } = await setup(t);
  const order = await createOrder(store, 'owner', { title: ` ${input.title} `, category: ' Услуги ', description: ` ${input.description} ` });
  assert.equal(order.title, input.title);
  assert.equal(order.category, 'Услуги');
  assert.equal(order.description, input.description);
  assert.equal(order.ownerId, 'owner');
  assert.equal(order.status, 'open');
  assert.equal(order.version, 1);
  assert.deepEqual(order.attachments, []);
  assert.equal(order.createdAt, order.publishedAt);
  assert.equal(order.createdAt, order.updatedAt);
  assert.deepEqual(order.history, [{ from: null, to: 'open', actorId: 'owner', at: order.createdAt, evidence: '' }]);
  const publicResult = getOrder(store, order.id);
  assert.equal(publicResult.owner.companyName, 'Компания owner');
  assert.equal(publicResult.rating.score,0);
  assert.deepEqual(publicResult.confirmedFields,[]);
  for (const key of ['email', 'contacts', 'passwordHash', 'sessions', 'history', 'published']) {
    assert.ok(!Object.hasOwn(publicResult, key));
    assert.ok(!Object.hasOwn(publicResult.owner, key));
  }
  assert.ok(!JSON.stringify(publicResult).includes('PRIVATE_'));
  publicResult.attachments.push('forged-file');
  assert.deepEqual(getOrder(store, order.id).attachments, []);
});

test('order inputs reject forged fields and invalid lengths while accepting their stated boundaries', async t => {
  const { store, file } = await setup(t);
  const before = await snapshot(store, file);
  for (const patch of [
    { title: '' }, { title: false }, { title: 't'.repeat(161) }, { description: null }, { description: 'd'.repeat(4001) },
    { category: 'Unknown' }, { category: [] }, { ownerId: 'other' }, { status: 'completed' }, { role: 'business' }, { attachments: ['file'] },
  ]) {
    await rejected(createOrder(store, 'owner', { ...input, ...patch }), 400);
    await unchanged(store, file, before);
  }
  const maximum = await createOrder(store, 'owner', { ...input, title: 'я'.repeat(160), description: 'д'.repeat(4000) });
  assert.equal(maximum.title.length, 160);
  assert.equal(maximum.description.length, 4000);
  const secondBefore = await snapshot(store, file);
  for (const body of [{ message: '' }, { message: false }, { message: 'x'.repeat(4001) }, { message: 'Текст', studentId: 'student2' }, { message: 'Текст', role: 'student' }]) {
    await rejected(applyToOrder(store, 'student', maximum.id, body), 400);
    await unchanged(store, file, secondBefore);
  }
});

test('confirmed order conditions drive server readiness, preserve publication and allow a zero-score response',async t=>{
  const {store,file} = await setup(t);
  await rejected(createOrder(store,'owner',{...input,fields:{data:'Материалы'}}),400);
  const order = await createOrder(store,'owner',{...input,fields:{title:input.title},confirmed:true});
  assert.equal(order.rating.score,0);
  assert.equal(listOrders(store).find(item=>item.id===order.id).rating.score,0);
  await apply(store,order.id);
  const updated = await updateOrder(store,'owner',order.id,{...input,version:order.version,
    fields:{title:input.title,context:'Заявки в чатах',need:'Собрать обращения',data:'Обезличенные примеры',
      users:'Администратор',constraints:'Без личных данных',result:'Список обращений',success:'Каждое тестовое обращение найдено',
      contact:'В чате проекта',format:'Обсуждение раз в неделю',feedback:'Проверяет владелец'},confirmed:true});
  assert.equal(updated.rating.score,100);
  assert.equal(updated.publishedAt,order.publishedAt);
  assert.equal(getOrder(store,order.id).rating.score,100);
  const before = await snapshot(store,file);
  await rejected(updateOrder(store,'owner',order.id,{...input,version:1,fields:{title:input.title},confirmed:true}),409);
  await rejected(updateOrder(store,'other',order.id,{...input,version:2,fields:{title:input.title},confirmed:true}),403);
  await unchanged(store,file,before);
  const cleared = await updateOrder(store,'owner',order.id,{...input,version:2,fields:{title:input.title},confirmed:true});
  assert.equal(cleared.rating.score,0);
  assert.equal(cleared.fields.data,'');
  assert.equal(getOrder(await createPlatformStore(file),order.id).rating.score,0);
});

test('open catalog filters category and text, retains low readiness and resolves equal scores by publication date', async t => {
  const { store } = await setup(t);
  const orders = [];
  for (let index = 0; index < 4; index++) orders.push(await createOrder(store, 'owner', { ...input, title: `Учёт ${index}`, category: index === 3 ? 'Ритейл' : 'Услуги' }));
  await store.mutate(state => {
    state.orders[0].publishedAt = '2026-01-01T00:00:00.000Z';
    for (const order of state.orders.slice(1)) order.publishedAt = '2026-02-01T00:00:00.000Z';
  });
  const tied = orders.slice(1).map(order => order.id).sort();
  assert.deepEqual(listOrders(store).map(order => order.id), [orders[0].id, ...tied]);
  assert.deepEqual(listOrders(store, { category: 'Ритейл', query: '  УЧЁТ  ' }).map(order => order.id), [orders[3].id]);
  assert.equal(listOrders(store, { query: 'компания OWNER' }).length, 4);
  assert.equal(listOrders(store, { query: 'не существующая фраза' }).length, 0);
  await transitionOrder(store, 'owner', orders[0].id, { status: 'closed', version: 1 });
  const application = await apply(store, orders[1].id);
  await decideApplication(store, 'owner', application.id, { status: 'accepted', version: 1 });
  assert.deepEqual(new Set(listOrders(store).map(order => order.id)), new Set(orders.slice(2).map(order => order.id)));
  assert.equal(listOwnOrders(store, 'owner').length, 4);
  assert.equal(listOwnOrders(store, 'other').length, 0);
  for (const filters of [{ category: 'bad' }, { query: [] }, { unknown: 'field' }]) assert.throws(() => listOrders(store, filters), error => error.status === 400);
});

test('ownership and active roles come from the queued store state, not submitted identity', async t => {
  const { store, file } = await setup(t);
  await rejected(createOrder(store, 'student', input), 403);
  await rejected(createOrder(store, 'missing', input), 401);
  const order = await createOrder(store, 'owner', input);
  const before = await snapshot(store, file);
  await rejected(transitionOrder(store, 'other', order.id, { status: 'closed', version: 1 }), 403);
  await rejected(apply(store, order.id, 'other'), 403);
  await rejected(apply(store, 'missing-order'), 404);
  await unchanged(store, file, before);
  assert.throws(() => listOwnOrders(store, 'student'), error => error.status === 403);
  const switching = store.mutate(state => { state.users.find(user => user.id === 'owner').activeRole = 'student'; });
  const tooLate = createOrder(store, 'owner', input);
  await switching;
  await rejected(tooLate, 403);
  await rejected(apply(store, order.id, 'owner'), 403);
  assert.equal(store.read().orders.length, 1);
});

test('a solo beginner can apply without skills, a team or points; active duplicates are serialized and rejection permits a new application', async t => {
  const { store } = await setup(t);
  const order = await createOrder(store, 'owner', input);
  const attempts = await Promise.allSettled([apply(store, order.id), apply(store, order.id)]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 409);
  const application = attempts.find(result => result.status === 'fulfilled').value;
  assert.equal(application.studentId, 'student');
  assert.equal(application.status, 'pending');
  assert.ok(!Object.hasOwn(application, 'teamId'));
  const decision = await decideApplication(store, 'owner', application.id, { status: 'rejected', version: 1 });
  assert.equal(decision.order.status, 'open');
  const repeated = await applyToOrder(store, 'student', order.id, { message: 'я'.repeat(4000) });
  assert.equal(repeated.message.length, 4000);
  assert.notEqual(repeated.id, application.id);
  assert.equal(listApplications(store, 'student', order.id).length, 2);
});

test('business may accept multiple applicants and removing the last selected student reopens the same publication', async t => {
  const { store, file } = await setup(t);
  const initial = await createOrder(store, 'owner', input);
  const first = await apply(store, initial.id);
  const second = await apply(store, initial.id, 'student2');
  const selected = await decideApplication(store, 'owner', first.id, { status: 'accepted', version: 1 });
  assert.equal(selected.order.status, 'in_progress');
  assert.equal(selected.order.version, 2);
  assert.deepEqual(listOrders(store), []);
  await rejected(apply(store, initial.id), 409);
  const both = await decideApplication(store, 'owner', second.id, { status: 'accepted', version: 2 });
  assert.equal(both.order.status, 'in_progress');
  const before = await snapshot(store, file);
  const repeat = await decideApplication(store, 'owner', second.id, { status: 'accepted', version: 3 });
  assert.deepEqual(repeat, both);
  await unchanged(store, file, before);
  await rejected(decideApplication(store, 'owner', second.id, { status: 'accepted', version: 2 }), 409);
  const one = await decideApplication(store, 'owner', first.id, { status: 'rejected', version: 3 });
  assert.equal(one.order.status, 'in_progress');
  const reopened = await decideApplication(store, 'owner', second.id, { status: 'rejected', version: 4 });
  assert.equal(reopened.order.status, 'open');
  assert.equal(reopened.order.publishedAt, initial.publishedAt);
  assert.deepEqual(reopened.order.history.map(event => [event.from, event.to]), [[null, 'open'], ['open', 'in_progress'], ['in_progress', 'open']]);
  assert.equal(listOrders(store).length, 1);
});

test('completion records owner evidence, keeps it private and freezes applicant decisions even after later closure', async t => {
  const { store, file } = await setup(t);
  const { order, application } = await started(store);
  const before = await snapshot(store, file);
  await rejected(transitionOrder(store, 'owner', order.id, { status: 'completed', version: order.version }), 400);
  await unchanged(store, file, before);
  const completed = await transitionOrder(store, 'owner', order.id, { status: 'completed', version: order.version, evidence: '  Проверен согласованный сценарий. PRIVATE_EVIDENCE  ' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.history.at(-1).evidence, 'Проверен согласованный сценарий. PRIVATE_EVIDENCE');
  assert.equal(completed.history.at(-1).actorId, 'owner');
  assert.equal(completed.history.at(-1).at, completed.updatedAt);
  assert.ok(!JSON.stringify(getOrder(store, order.id)).includes('PRIVATE_EVIDENCE'));
  assert.equal(listOwnOrders(store, 'owner')[0].history.at(-1).evidence, completed.history.at(-1).evidence);
  await rejected(decideApplication(store, 'owner', application.id, { status: 'rejected', version: completed.version }), 409);
  const closed = await transitionOrder(store, 'owner', order.id, { status: 'closed', version: completed.version });
  await rejected(decideApplication(store, 'owner', application.id, { status: 'accepted', version: closed.version }), 409);
  await rejected(transitionOrder(store, 'owner', order.id, { status: 'completed', version: closed.version, evidence: 'Нельзя восстановить.' }), 409);
  assert.equal(closed.history.length, completed.history.length + 1);
});

test('closing open work is allowed but closing work in progress requires a reason and has an idempotent fresh-version retry', async t => {
  const { store, file } = await setup(t);
  const initial = await createOrder(store, 'owner', input);
  const closed = await transitionOrder(store, 'owner', initial.id, { status: 'closed', version: 1 });
  assert.equal(closed.status, 'closed');
  const { order } = await started(store);
  await rejected(transitionOrder(store, 'owner', order.id, { status: 'closed', version: order.version, evidence: '  ' }), 400);
  const cancelled = await transitionOrder(store, 'owner', order.id, { status: 'closed', version: order.version, evidence: 'Приоритет бизнеса изменился.' });
  const before = await snapshot(store, file);
  const retry = await transitionOrder(store, 'owner', order.id, { status: 'closed', version: cancelled.version, evidence: 'Не заменять причину.' });
  assert.deepEqual(retry, cancelled);
  await unchanged(store, file, before);
  assert.equal(cancelled.history.at(-1).evidence, 'Приоритет бизнеса изменился.');
});

test('competing decisions using one order version commit once and a refreshed version allows the second selection', async t => {
  const { store } = await setup(t);
  const order = await createOrder(store, 'owner', input);
  const first = await apply(store, order.id);
  const second = await apply(store, order.id, 'student2');
  const attempts = await Promise.allSettled([first, second].map(application => decideApplication(store, 'owner', application.id, { status: 'accepted', version: 1 })));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 409);
  const pending = listApplications(store, 'owner', order.id).find(application => application.status === 'pending');
  const final = await decideApplication(store, 'owner', pending.id, { status: 'accepted', version: 2 });
  assert.equal(final.order.version, 3);
  assert.ok(listApplications(store, 'owner', order.id).every(application => application.status === 'accepted'));
  assert.equal(final.order.history.filter(event => event.to === 'in_progress').length, 1);
});

test('application lists show every application only to its owner and only personal applications to a student', async t => {
  const { store } = await setup(t);
  const order = await createOrder(store, 'owner', input);
  const first = await apply(store, order.id);
  const second = await apply(store, order.id, 'student2');
  assert.deepEqual(listApplications(store, 'student', order.id).map(item => item.id), [first.id]);
  assert.deepEqual(listApplications(store, 'student2', order.id).map(item => item.id), [second.id]);
  assert.equal(listApplications(store, 'owner', order.id).length, 2);
  assert.ok(!JSON.stringify(listApplications(store, 'owner', order.id)).includes('PRIVATE_'));
  assert.throws(() => listApplications(store, 'other', order.id), error => error.status === 403);
  assert.throws(() => listApplications(store, 'missing-user', order.id), error => error.status === 401);
  assert.throws(() => getOrder(store, 'missing-order'), error => error.status === 404);
});

test('invalid decisions and transitions never change the order, applications or disk', async t => {
  const { store, file } = await setup(t);
  const order = await createOrder(store, 'owner', input);
  const application = await apply(store, order.id);
  const before = await snapshot(store, file);
  for (const patch of [{ version: 0 }, { version: '1' }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 }, { status: 'pending' }, { role: 'business' }]) {
    await rejected(decideApplication(store, 'owner', application.id, { status: 'accepted', version: 1, ...patch }), 400);
    await unchanged(store, file, before);
  }
  await rejected(decideApplication(store, 'other', application.id, { status: 'accepted', version: 1 }), 403);
  await rejected(decideApplication(store, 'owner', 'missing-application', { status: 'accepted', version: 1 }), 404);
  for (const patch of [{ version: undefined }, { status: 'unknown' }, { evidence: false }, { evidence: 'x'.repeat(4001) }, { actorId: 'other' }]) {
    await rejected(transitionOrder(store, 'owner', order.id, { status: 'closed', version: 1, ...patch }), 400);
  }
  for (const status of ['in_progress', 'completed']) await rejected(transitionOrder(store, 'owner', order.id, { status, version: 1, evidence: 'Обход приёмки.' }), 409);
  await unchanged(store, file, before);
});

test('new platform history, solo applications and publication dates survive persistence without creating legacy entities', async t => {
  const { store, file } = await setup(t);
  const { order } = await started(store);
  await transitionOrder(store, 'owner', order.id, { status: 'completed', version: order.version, evidence: 'Работа принята по согласованному сценарию.' });
  const before = store.read();
  const reopened = await createPlatformStore(file);
  assert.deepEqual(reopened.read(), before);
  assert.deepEqual(getOrder(reopened, order.id), getOrder(store, order.id));
  assert.deepEqual(listOwnOrders(reopened, 'owner'), listOwnOrders(store, 'owner'));
  assert.deepEqual(listApplications(reopened, 'student', order.id), listApplications(store, 'student', order.id));
  assert.equal(reopened.read().schemaVersion, 2);
  for (const key of ['tasks', 'teams', 'proposals']) assert.ok(!Object.hasOwn(reopened.read(), key));
});
