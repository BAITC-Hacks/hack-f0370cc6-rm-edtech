import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../../server.mjs';
import { temporaryDirectory } from './helpers.mjs';

async function listen(app) {
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  return `http://127.0.0.1:${app.server.address().port}`;
}

async function close(app) {
  if (!app.server.listening) return;
  const done = new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
  app.server.closeAllConnections();
  await done;
}

async function setup(t) {
  const file = join(await temporaryDirectory(t), 'db.json');
  const app = await createApplication({ dataFile: file });
  const url = await listen(app);
  t.after(() => close(app));
  return { app, url, file };
}

async function jsonRequest(url, method, body) {
  const response = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function draft(url) {
  const result = await jsonRequest(`${url}/api/tasks`, 'POST', {
    role: 'business', businessId: 'business_demo',
    raw: 'Нужен единый учёт заявок из разных каналов.', industry: 'Услуги',
  });
  assert.equal(result.response.status, 201);
  return result.body.task;
}

function confirmation(task, fields, overrides = {}) {
  return {
    role: 'business', businessId: 'business_demo', version: task.version,
    industry: task.industry, fields, confirmed: true, ...overrides,
  };
}

const put = (url, taskId, body) => jsonRequest(`${url}/api/tasks/${taskId}`, 'PUT', body);
const publication = task => ({ role: 'business', businessId: 'business_demo', version: task.version });
const publish = (url, task, overrides = {}) => jsonRequest(`${url}/api/tasks/${task.id}/publish`, 'POST', {
  ...publication(task), ...overrides,
});

async function snapshot(app, file) {
  return { state: app.store.read(), bytes: await readFile(file) };
}

async function unchanged(app, file, before) {
  assert.deepEqual(app.store.read(), before.state);
  assert.deepEqual(await readFile(file), before.bytes);
}

test('PUT confirms cleaned human fields, derives score and preserves an unpublished draft', async t => {
  const { url } = await setup(t);
  const initial = await draft(url);
  const started = Date.now();
  const { response, body: { task } } = await put(url, initial.id, confirmation(initial, {
    title: '  Единый учёт заявок  ', data: '  Обезличенная выгрузка обращений  ', context: ' \n ',
  }, { industry: 'Ритейл' }));

  assert.equal(response.status, 200);
  assert.equal(task.fields.title, 'Единый учёт заявок');
  assert.equal(task.fields.data, 'Обезличенная выгрузка обращений');
  assert.equal(task.fields.context, '');
  assert.deepEqual(Object.keys(task.fields).sort(), Object.keys(initial.fields).sort());
  assert.deepEqual([...task.confirmedFields].sort(), ['data', 'title']);
  assert.equal(task.rating.score, 20);
  assert.equal(task.rating.level.key, 'draft');
  assert.equal(task.industry, 'Ритейл');
  assert.equal(task.version, initial.version + 1);
  assert.equal(task.confirmedAt, task.updatedAt);
  assert.ok(Date.parse(task.confirmedAt) >= started && Date.parse(task.confirmedAt) <= Date.now());
  for (const key of ['id', 'businessId', 'raw', 'company', 'createdAt', 'published', 'publishedAt']) {
    assert.deepEqual(task[key], initial[key], key);
  }
  const catalog = await (await fetch(`${url}/api/catalog`)).json();
  assert.ok(!catalog.tasks.some(item => item.id === initial.id));
});

test('PUT replaces the full snapshot: omitted data loses 20 points and an empty draft remains valid', async t => {
  const { url } = await setup(t);
  const initial = await draft(url);
  const first = await put(url, initial.id, confirmation(initial, {
    title: 'Учёт обращений', data: 'Выгрузка обращений без персональных данных',
  }));
  assert.equal(first.response.status, 200);
  assert.equal(first.body.task.rating.score, 20);

  const second = await put(url, initial.id, confirmation(first.body.task, { title: 'Учёт обращений' }));
  assert.equal(second.response.status, 200);
  assert.equal(second.body.task.fields.data, '');
  assert.deepEqual(second.body.task.confirmedFields, ['title']);
  assert.equal(second.body.task.rating.score, 0);
  assert.equal(second.body.task.rating.missing[0].key, 'data');
  assert.equal(second.body.task.version, 3);

  const empty = await put(url, initial.id, confirmation(second.body.task, {}));
  assert.equal(empty.response.status, 200);
  assert.ok(Object.values(empty.body.task.fields).every(value => value === ''));
  assert.deepEqual(empty.body.task.confirmedFields, []);
  assert.equal(empty.body.task.rating.score, 0);
  assert.equal(empty.body.task.published, false);
});

test('PUT rejects invalid confirmation, field snapshots and forged server values without any write', async t => {
  const { app, url, file } = await setup(t);
  const initial = await draft(url);
  const before = await snapshot(app, file);
  const base = confirmation(initial, { title: 'Учёт обращений' });
  const patches = [
    { confirmed: undefined }, { confirmed: false }, { confirmed: 'true' }, { confirmed: 1 },
    { fields: undefined }, { fields: null }, { fields: [] }, { fields: 'text' },
    { fields: { title: null } }, { fields: { data: 42 } }, { fields: { unknown: 'x' } },
    { fields: { title: 'x'.repeat(161) } }, { industry: undefined }, { industry: 'unknown' },
    { rating: { score: 100 } }, { confirmedFields: ['data'] }, { confirmedAt: '2026-01-01' },
    { published: true }, { publishedAt: '2026-01-01' }, { updatedAt: '2026-01-01' },
    { raw: 'Подмена исходного описания' }, { id: 'chosen-by-client' },
    { version: undefined }, { version: '1' }, { version: 1.5 }, { version: 0 },
    { version: -1 }, { version: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const patch of patches) {
    const result = await put(url, initial.id, { ...base, ...patch });
    assert.equal(result.response.status, 400, JSON.stringify(patch));
    assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    await unchanged(app, file, before);
  }
});

test('PUT reports ownership, missing tasks and stale versions with contract errors and no writes', async t => {
  const { app, url, file } = await setup(t);
  const initial = await draft(url);
  const before = await snapshot(app, file);
  const base = confirmation(initial, { title: 'Учёт обращений' });
  const attempts = [
    [initial.id, { ...base, role: 'team' }, 403, 'FORBIDDEN'],
    [initial.id, { ...base, businessId: 'other' }, 403, 'FORBIDDEN'],
    ['task_missing', base, 404, 'NOT_FOUND'],
    [initial.id, { ...base, version: initial.version + 1 }, 409, 'CONFLICT'],
  ];
  for (const [taskId, body, status, code] of attempts) {
    const result = await put(url, taskId, body);
    assert.equal(result.response.status, status);
    assert.equal(result.body.error.code, code);
    assert.deepEqual(result.body.error.fields, {});
    await unchanged(app, file, before);
  }
});

test('PUT updates a published card and catalog ranking while preserving its publication date and title invariant', async t => {
  const { app, url, file } = await setup(t);
  const initial = app.store.read().tasks.find(task => task.id === 'task_coffee');
  const result = await put(url, initial.id, confirmation(initial, {
    title: initial.fields.title, data: 'Согласована обезличенная выгрузка продаж.',
  }));
  assert.equal(result.response.status, 200);
  assert.equal(result.body.task.rating.score, 20);
  assert.equal(result.body.task.published, true);
  assert.equal(result.body.task.publishedAt, initial.publishedAt);
  const catalog = await (await fetch(`${url}/api/catalog`)).json();
  assert.deepEqual(catalog.tasks.map(task => task.id), [
    'task_edu', 'task_tour', 'task_logistics', 'task_coffee', 'task_service',
  ]);
  assert.deepEqual(catalog.tasks.find(task => task.id === initial.id), result.body.task);

  const before = await snapshot(app, file);
  const invalid = await put(url, initial.id, confirmation(result.body.task, { title: '  ', data: 'Данные' }));
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  await unchanged(app, file, before);
});

test('concurrent PUT requests using the same version allow exactly one confirmation', async t => {
  const { app, url, file } = await setup(t);
  const initial = await draft(url);
  const results = await Promise.all([
    put(url, initial.id, confirmation(initial, { title: 'Первый снимок', data: 'Проверенные данные' })),
    put(url, initial.id, confirmation(initial, { title: 'Второй снимок', need: 'Уточнённая потребность' })),
  ]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  const winner = results.find(result => result.response.status === 200).body.task;
  const loser = results.find(result => result.response.status === 409);
  assert.equal(loser.body.error.code, 'CONFLICT');
  assert.equal(winner.version, 2);
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.deepEqual(state.tasks.find(task => task.id === initial.id), winner);
  const stored = app.store.read().tasks.find(task => task.id === initial.id);
  const onDisk = JSON.parse(await readFile(file, 'utf8')).tasks.find(task => task.id === initial.id);
  assert.deepEqual(onDisk, stored);
  assert.deepEqual(stored.fields, winner.fields);
  assert.equal(stored.version, 2);
});

test('confirmed fields, version and computed rating survive reopening the persisted store', async t => {
  const { app, url, file } = await setup(t);
  const initial = await draft(url);
  const result = await put(url, initial.id, confirmation(initial, {
    title: 'Учёт обращений', data: 'Синтетические обращения', success: 'Все тестовые обращения найдены',
  }));
  assert.equal(result.response.status, 200);
  assert.equal(result.body.task.rating.score, 35);
  await close(app);
  const reopened = await createApplication({ dataFile: file });
  const nextUrl = await listen(reopened);
  t.after(() => close(reopened));
  const state = await (await fetch(`${nextUrl}/api/state`)).json();
  assert.deepEqual(state.tasks.find(task => task.id === initial.id), result.body.task);
  const catalog = await (await fetch(`${nextUrl}/api/catalog`)).json();
  assert.ok(!catalog.tasks.some(task => task.id === initial.id));
});

test('task confirmation routes expose PUT as the only supported method without mutating state', async t => {
  const { app, url, file } = await setup(t);
  const before = await snapshot(app, file);
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const response = await fetch(`${url}/api/tasks/task_coffee`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'PUT');
    assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
  }
  await unchanged(app, file, before);
});

test('create, confirm and publish makes a title-only zero-score task available in the open catalog', async t => {
  const { url } = await setup(t);
  const initial = await draft(url);
  const confirmed = await put(url, initial.id, confirmation(initial, { title: 'Учёт заявок' }));
  assert.equal(confirmed.response.status, 200);
  const started = Date.now();
  const result = await publish(url, confirmed.body.task);
  assert.equal(result.response.status, 200);
  const task = result.body.task;
  assert.equal(task.published, true);
  assert.equal(task.rating.score, 0);
  assert.equal(task.rating.level.key, 'draft');
  assert.equal(task.version, confirmed.body.task.version + 1);
  assert.equal(task.publishedAt, task.updatedAt);
  assert.ok(Date.parse(task.publishedAt) >= started && Date.parse(task.publishedAt) <= Date.now());
  for (const key of ['fields', 'confirmedFields', 'confirmedAt', 'createdAt', 'raw', 'businessId']) {
    assert.deepEqual(task[key], confirmed.body.task[key], key);
  }
  const catalog = await (await fetch(`${url}/api/catalog`)).json();
  assert.deepEqual(catalog.tasks.at(-1), task);
  const filtered = await (await fetch(`${url}/api/catalog?level=draft`)).json();
  assert.ok(filtered.tasks.some(item => item.id === task.id));
});

test('publication rejects missing titles and unconfirmed current fields without writing', async t => {
  const { app, url, file } = await setup(t);
  const initial = await draft(url);
  let before = await snapshot(app, file);
  assert.equal((await publish(url, initial)).response.status, 400);
  await unchanged(app, file, before);

  const confirmed = await put(url, initial.id, confirmation(initial, { data: 'Примеры заявок' }));
  assert.equal(confirmed.response.status, 200);
  before = await snapshot(app, file);
  assert.equal((await publish(url, confirmed.body.task)).response.status, 400);
  await unchanged(app, file, before);

  const titled = await put(url, initial.id, confirmation(confirmed.body.task, { title: 'Учёт заявок' }));
  assert.equal(titled.response.status, 200);
  for (const patch of [
    { confirmedAt: null },
    { confirmedFields: [] },
    { fields: { ...titled.body.task.fields, data: 'Ещё не подтверждённые сведения' } },
  ]) {
    await app.store.mutate(state => {
      const task = state.tasks.find(item => item.id === initial.id);
      const { rating, ...stored } = titled.body.task;
      Object.assign(task, stored, patch);
    });
    before = await snapshot(app, file);
    const rejected = await publish(url, titled.body.task);
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
    await unchanged(app, file, before);
  }
});

test('publication validates request ownership, version and server-owned fields with no writes', async t => {
  const { app, url, file } = await setup(t);
  const initial = await draft(url);
  const before = await snapshot(app, file);
  for (const patch of [
    { version: undefined }, { version: null }, { version: '1' }, { version: 0 },
    { version: -1 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { published: true }, { publishedAt: '2026-01-01' }, { rating: { score: 100 } },
    { fields: { title: 'Подмена карточки' } }, { confirmed: true },
  ]) {
    const result = await publish(url, initial, patch);
    assert.equal(result.response.status, 400, JSON.stringify(patch));
    assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    await unchanged(app, file, before);
  }
  for (const [task, patch, status, code] of [
    [initial, { role: 'team' }, 403, 'FORBIDDEN'],
    [initial, { businessId: 'other' }, 403, 'FORBIDDEN'],
    [initial, { version: initial.version + 1 }, 409, 'CONFLICT'],
    [{ ...initial, id: 'task_missing' }, {}, 404, 'NOT_FOUND'],
  ]) {
    const result = await publish(url, task, patch);
    assert.equal(result.response.status, status);
    assert.equal(result.body.error.code, code);
    assert.deepEqual(result.body.error.fields, {});
    await unchanged(app, file, before);
  }
});

test('publication routes allow only POST and leave state unchanged for other methods', async t => {
  const { app, url, file } = await setup(t);
  const before = await snapshot(app, file);
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
    const response = await fetch(`${url}/api/tasks/task_coffee/publish`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
    if (method === 'HEAD') assert.equal(await response.text(), '');
    else assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
  }
  await unchanged(app, file, before);
});

test('published task and its rating remain available after reopening the persisted store', async t => {
  const { app, url, file } = await setup(t);
  const initial = await draft(url);
  const confirmed = await put(url, initial.id, confirmation(initial, { title: 'Учёт заявок', data: 'Примеры' }));
  const result = await publish(url, confirmed.body.task);
  assert.equal(result.response.status, 200);
  assert.equal(result.body.task.rating.score, 20);
  await close(app);
  const reopened = await createApplication({ dataFile: file });
  const nextUrl = await listen(reopened);
  t.after(() => close(reopened));
  const catalog = await (await fetch(`${nextUrl}/api/catalog`)).json();
  assert.deepEqual(catalog.tasks.find(task => task.id === initial.id), result.body.task);
});

test('publication retry preserves dates, version and ordering among equal-score cards', async t => {
  const { app, url, file } = await setup(t);
  const initial = await draft(url);
  const confirmed = await put(url, initial.id, confirmation(initial, { title: 'Учёт заявок', data: 'Примеры' }));
  const first = await publish(url, confirmed.body.task);
  assert.equal(first.response.status, 200);
  const before = await snapshot(app, file);
  const stale = await publish(url, confirmed.body.task);
  assert.equal(stale.response.status, 409);
  await unchanged(app, file, before);
  const repeated = await publish(url, first.body.task);
  assert.equal(repeated.response.status, 200);
  assert.deepEqual(repeated.body.task, first.body.task);
  await unchanged(app, file, before);

  const older = app.store.read().tasks.find(task => task.id === 'task_service');
  assert.equal((await publish(url, older)).response.status, 200);
  await unchanged(app, file, before);
  const catalog = await (await fetch(`${url}/api/catalog`)).json();
  assert.deepEqual(catalog.tasks.filter(task => task.rating.score === 20).map(task => task.id), [older.id, initial.id]);
});

test('concurrent confirmation and publication of the same version commit exactly one action', async t => {
  const { app, url, file } = await setup(t);
  const initial = await draft(url);
  const confirmed = await put(url, initial.id, confirmation(initial, { title: 'Учёт заявок' }));
  const task = confirmed.body.task;
  const results = await Promise.all([
    put(url, task.id, confirmation(task, { title: 'Уточнённый учёт заявок', data: 'Примеры заявок' })),
    publish(url, task),
  ]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  assert.equal(results.find(result => result.response.status === 409).body.error.code, 'CONFLICT');
  const winner = results.find(result => result.response.status === 200).body.task;
  assert.equal(winner.version, task.version + 1);
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.deepEqual(state.tasks.find(item => item.id === task.id), winner);
  const stored = app.store.read().tasks.find(item => item.id === task.id);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).tasks.find(item => item.id === task.id), stored);
  const catalog = await (await fetch(`${url}/api/catalog`)).json();
  assert.equal(catalog.tasks.some(item => item.id === task.id), winner.published);
});

test('simultaneous first publications increment the version once and accept a fresh-version retry', async t => {
  const { url } = await setup(t);
  const initial = await draft(url);
  const confirmed = await put(url, initial.id, confirmation(initial, { title: 'Учёт заявок' }));
  const results = await Promise.all([publish(url, confirmed.body.task), publish(url, confirmed.body.task)]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  const winner = results.find(result => result.response.status === 200).body.task;
  assert.equal(winner.version, 3);
  const repeated = await publish(url, winner);
  assert.equal(repeated.response.status, 200);
  assert.deepEqual(repeated.body.task, winner);
});
