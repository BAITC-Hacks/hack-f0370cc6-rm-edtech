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

async function request(url, method, body) {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { response, body: await response.json() };
}

const business = { role: 'business', businessId: 'business_demo' };
const input = {
  role: 'team', teamId: 'team_orbit', idea: 'Доска учёта обращений',
  plan: 'Уточним статусы, соберём прототип и проверим на тестовых обращениях.',
  duration: '10 дней', link: 'https://example.com/orbit-demo',
};
const propose = (url, taskId = 'task_service', patch = {}) => request(`${url}/api/tasks/${taskId}/proposals`, 'POST', { ...input, ...patch });
const decide = (url, proposalId, status = 'accepted', patch = {}) => request(`${url}/api/proposals/${proposalId}`, 'PATCH', { ...business, status, ...patch });
const milestone = (url, proposalId, key = 'prototype', patch = {}) => request(`${url}/api/proposals/${proposalId}/milestones`, 'POST', {
  ...business, key, evidence: 'Проверили поиск и статусы на десяти синтетических заявках.', ...patch,
});
const state = async url => (await fetch(`${url}/api/state`)).json();
const points = (snapshot, teamId = 'team_orbit') => snapshot.teams.find(team => team.id === teamId).points;

async function before(app, file) {
  return { state: app.store.read(), bytes: await readFile(file) };
}

async function unchanged(app, file, snapshot) {
  assert.deepEqual(app.store.read(), snapshot.state);
  assert.deepEqual(await readFile(file), snapshot.bytes);
}

async function accepted(url, patch = {}) {
  const created = await propose(url, 'task_service', patch);
  assert.equal(created.response.status, 201);
  const result = await decide(url, created.body.proposal.id);
  assert.equal(result.response.status, 200);
  return result.body.proposal;
}

test('zero-score task accepts multiple teams and awards 50 then 150 points only for confirmed work', async t => {
  const { url } = await setup(t);
  const created = await request(`${url}/api/tasks`, 'POST', { ...business, raw: 'Теряются заявки.', industry: 'Услуги' });
  assert.equal(created.response.status, 201);
  const confirmed = await request(`${url}/api/tasks/${created.body.task.id}`, 'PUT', {
    ...business, version: 1, industry: 'Услуги', fields: { title: 'Учёт заявок' }, confirmed: true,
  });
  assert.equal(confirmed.response.status, 200);
  const published = await request(`${url}/api/tasks/${created.body.task.id}/publish`, 'POST', { ...business, version: confirmed.body.task.version });
  assert.equal(published.response.status, 200);
  assert.equal(published.body.task.rating.score, 0);
  const first = await propose(url, created.body.task.id);
  const second = await propose(url, created.body.task.id, { teamId: 'team_nomad' });
  for (const result of [first, second]) {
    assert.equal(result.response.status, 201);
    assert.equal(result.body.proposal.status, 'pending');
    assert.deepEqual(result.body.proposal.milestones, []);
    assert.match(result.body.proposal.id, /^proposal_[\da-f-]+$/);
    assert.ok(Number.isFinite(Date.parse(result.body.proposal.createdAt)));
    assert.equal((await decide(url, result.body.proposal.id)).response.status, 200);
  }
  let snapshot = await state(url);
  assert.ok(snapshot.teams.every(team => team.points === 0));
  assert.ok([first.body.proposal.id, second.body.proposal.id].every(id => snapshot.proposals.find(item => item.id === id).status === 'accepted'));

  const prototype = await milestone(url, first.body.proposal.id, 'prototype', { evidence: '  Прототип прошёл согласованный сценарий.  ' });
  assert.equal(prototype.response.status, 200);
  assert.equal(prototype.body.team.points, 50);
  assert.equal(prototype.body.proposal.milestones[0].evidence, 'Прототип прошёл согласованный сценарий.');
  assert.equal(prototype.body.proposal.milestones[0].confirmedBy, 'business_demo');
  assert.equal(prototype.body.proposal.milestones[0].points, 50);
  const repeated = await milestone(url, first.body.proposal.id, 'prototype', { evidence: 'Попытка заменить доказательство.' });
  assert.deepEqual(repeated.body, prototype.body);
  const final = await milestone(url, first.body.proposal.id, 'result', { evidence: 'Согласованный результат принят на тестовых данных.' });
  assert.equal(final.response.status, 200);
  assert.equal(final.body.team.points, 150);
  assert.deepEqual(final.body.proposal.milestones.map(item => [item.key, item.points]), [['prototype', 50], ['result', 100]]);
  snapshot = await state(url);
  assert.equal(points(snapshot), 150);
  assert.equal(points(snapshot, 'team_nomad'), 0);
});

test('proposal input rejects missing values, invalid types, unsafe URLs and forged server fields without writes', async t => {
  const { app, url, file } = await setup(t);
  const snapshot = await before(app, file);
  const patches = [
    ...['idea', 'plan', 'duration', 'link', 'teamId'].flatMap(key => [{ [key]: '' }, { [key]: null }, { [key]: false }, { [key]: undefined }]),
    { idea: 'x'.repeat(4001) }, { plan: 'x'.repeat(4001) }, { duration: 'x'.repeat(501) }, { link: `https://example.com/${'x'.repeat(2048)}` },
    { id: 'forged' }, { taskId: 'task_coffee' }, { status: 'accepted' }, { points: 100 }, { milestones: [] }, { createdAt: '2026-01-01' },
    ...['/relative', '//example.com', 'https:example.com', 'javascript:alert(1)', 'file:///tmp/demo',
      'ftp://example.com', 'https://user:password@example.com', 'https://user@example.com',
      'https://exa mple.com', 'https://example.com/a\nb', 'https://example.com\\evil'].map(link => ({ link })),
  ];
  for (const patch of patches) {
    const result = await propose(url, 'task_service', patch);
    assert.equal(result.response.status, 400, JSON.stringify(patch));
    assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    await unchanged(app, file, snapshot);
  }
});

test('proposal requires an existing demo team and a published task but never a minimum score', async t => {
  const { app, url, file } = await setup(t);
  const draft = await request(`${url}/api/tasks`, 'POST', { ...business, raw: 'Нужен учёт.', industry: 'Услуги' });
  assert.equal(draft.response.status, 201);
  const snapshot = await before(app, file);
  for (const [taskId, patch, status, code] of [
    ['task_service', { role: 'business' }, 403, 'FORBIDDEN'],
    ['task_service', { role: undefined }, 403, 'FORBIDDEN'],
    ['task_service', { teamId: 'team_missing' }, 404, 'NOT_FOUND'],
    ['task_missing', {}, 404, 'NOT_FOUND'],
    [draft.body.task.id, {}, 400, 'VALIDATION_ERROR'],
  ]) {
    const result = await propose(url, taskId, patch);
    assert.equal(result.response.status, status);
    assert.equal(result.body.error.code, code);
    await unchanged(app, file, snapshot);
  }
});

test('business can change decisions before milestones, accept several, reject all and receive further proposals', async t => {
  const { url } = await setup(t);
  const first = await accepted(url);
  const second = await accepted(url, { teamId: 'team_nomad' });
  const third = await propose(url);
  assert.equal(third.response.status, 201);
  assert.notEqual(third.body.proposal.id, first.id);
  assert.equal(third.body.proposal.status, 'pending');
  for (const proposal of [first, second]) assert.equal((await decide(url, proposal.id, 'rejected')).response.status, 200);
  let snapshot = await state(url);
  assert.equal(snapshot.proposals.find(item => item.id === third.body.proposal.id).status, 'pending');
  assert.equal(snapshot.proposals.find(item => item.id === first.id).status, 'rejected');
  assert.equal(snapshot.proposals.find(item => item.id === second.id).status, 'rejected');
  assert.equal((await decide(url, first.id, 'accepted')).response.status, 200);
  snapshot = await state(url);
  assert.ok(snapshot.teams.every(team => team.points === 0));
});

test('decision validates owner, target, status and known fields without changing proposals or points', async t => {
  const { app, url, file } = await setup(t);
  const snapshot = await before(app, file);
  for (const [proposalId, patch, status, code] of [
    ['proposal_1', { role: 'team' }, 403, 'FORBIDDEN'],
    ['proposal_1', { businessId: 'other' }, 403, 'FORBIDDEN'],
    ['proposal_missing', {}, 404, 'NOT_FOUND'],
    ...[{ status: 'pending' }, { status: true }, { status: undefined }, { points: 100 }, { teamId: 'team_nomad' }, { milestones: [] }]
      .map(patch => ['proposal_1', patch, 400, 'VALIDATION_ERROR']),
  ]) {
    const result = await decide(url, proposalId, 'accepted', patch);
    assert.equal(result.response.status, status);
    assert.equal(result.body.error.code, code);
    assert.deepEqual(result.body.error.fields, {});
    await unchanged(app, file, snapshot);
  }
});

test('milestones require accepted proposals, prototype before result, owner and genuine nonempty evidence input', async t => {
  const { app, url, file } = await setup(t);
  const ready = await accepted(url);
  const snapshot = await before(app, file);
  for (const [proposalId, key, patch, status, code] of [
    ['proposal_1', 'prototype', {}, 409, 'CONFLICT'],
    [ready.id, 'result', {}, 409, 'CONFLICT'],
    [ready.id, 'prototype', { role: 'team' }, 403, 'FORBIDDEN'],
    [ready.id, 'prototype', { businessId: 'other' }, 403, 'FORBIDDEN'],
    ['proposal_missing', 'prototype', {}, 404, 'NOT_FOUND'],
    [ready.id, 'unknown', {}, 400, 'VALIDATION_ERROR'],
    ...[{ evidence: '' }, { evidence: ' \n ' }, { evidence: false }, { evidence: null }, { evidence: undefined },
      { evidence: 'x'.repeat(4001) }, { points: 1000 }, { confirmedBy: 'business_demo' }, { confirmedAt: '2026-01-01' }, { milestones: [] }]
      .map(patch => [ready.id, 'prototype', patch, 400, 'VALIDATION_ERROR']),
  ]) {
    const result = await milestone(url, proposalId, key, patch);
    assert.equal(result.response.status, status, JSON.stringify(patch));
    assert.equal(result.body.error.code, code);
    await unchanged(app, file, snapshot);
  }
  assert.ok((await state(url)).teams.every(team => team.points === 0));
});

test('the first confirmed milestone locks rejection while repeated acceptance preserves the record', async t => {
  const { app, url, file } = await setup(t);
  const ready = await accepted(url);
  const first = await milestone(url, ready.id);
  assert.equal(first.response.status, 200);
  const snapshot = await before(app, file);
  const rejected = await decide(url, ready.id, 'rejected');
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, 'CONFLICT');
  await unchanged(app, file, snapshot);
  const repeated = await decide(url, ready.id, 'accepted');
  assert.equal(repeated.response.status, 200);
  assert.deepEqual(repeated.body.proposal, first.body.proposal);
  await unchanged(app, file, snapshot);
});

test('concurrent duplicate milestones return one persisted award and keep the first evidence', async t => {
  const { app, url, file } = await setup(t);
  const ready = await accepted(url);
  const results = await Promise.all([
    milestone(url, ready.id, 'prototype', { evidence: 'Проверка первого бизнес-запроса.' }),
    milestone(url, ready.id, 'prototype', { evidence: 'Повторный бизнес-запрос.' }),
  ]);
  assert.ok(results.every(result => result.response.status === 200));
  assert.deepEqual(results[0].body, results[1].body);
  assert.equal(results[0].body.proposal.milestones.length, 1);
  assert.equal(results[0].body.team.points, 50);
  const stored = app.store.read().proposals.find(proposal => proposal.id === ready.id);
  assert.equal(stored.milestones.length, 1);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).proposals.find(proposal => proposal.id === ready.id), stored);
});

test('racing rejection and first milestone cannot both commit', async t => {
  const { url } = await setup(t);
  const ready = await accepted(url);
  const results = await Promise.all([decide(url, ready.id, 'rejected'), milestone(url, ready.id)]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  const snapshot = await state(url);
  const saved = snapshot.proposals.find(proposal => proposal.id === ready.id);
  if (saved.status === 'rejected') {
    assert.deepEqual(saved.milestones, []);
    assert.equal(points(snapshot), 0);
  } else {
    assert.equal(saved.status, 'accepted');
    assert.equal(saved.milestones.length, 1);
    assert.equal(points(snapshot), 50);
  }
});

test('proposal history and derived team points survive reopening and retry without double awards', async t => {
  const { app, url, file } = await setup(t);
  const first = await accepted(url);
  const second = await accepted(url);
  assert.equal((await milestone(url, first.id)).response.status, 200);
  assert.equal((await milestone(url, first.id, 'result')).response.status, 200);
  const final = await milestone(url, second.id);
  assert.equal(final.response.status, 200);
  assert.equal(final.body.team.points, 200);
  const original = await state(url);
  await close(app);
  const reopened = await createApplication({ dataFile: file });
  const nextUrl = await listen(reopened);
  t.after(() => close(reopened));
  assert.deepEqual(await state(nextUrl), original);
  const snapshot = await before(reopened, file);
  const repeated = await milestone(nextUrl, first.id, 'result', { evidence: 'Не должно заменить принятое доказательство.' });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.team.points, 200);
  await unchanged(reopened, file, snapshot);
});

test('new proposal routes declare their supported methods and reject others without writes', async t => {
  const { app, url, file } = await setup(t);
  const snapshot = await before(app, file);
  for (const [path, allowed] of [
    ['/api/tasks/task_service/proposals', 'POST'],
    ['/api/proposals/proposal_1', 'PATCH'],
    ['/api/proposals/proposal_1/milestones', 'POST'],
  ]) {
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', allowed === 'POST' ? 'PATCH' : 'POST']) {
      const response = await fetch(url + path, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), allowed);
      if (method === 'HEAD') assert.equal(await response.text(), '');
      else assert.equal((await response.json()).error.code, 'METHOD_NOT_ALLOWED');
    }
  }
  await unchanged(app, file, snapshot);
});

test('proposal and milestone text accept boundary lengths and trim submitted values', async t => {
  const { url } = await setup(t);
  const link = `https://example.com/${'a'.repeat(2048 - 'https://example.com/'.length)}`;
  const result = await propose(url, 'task_service', {
    idea: ` ${'и'.repeat(4000)} `, plan: 'п'.repeat(4000), duration: 'д'.repeat(500), link: ` ${link} `,
  });
  assert.equal(result.response.status, 201);
  const proposal = result.body.proposal;
  assert.equal(proposal.idea.length, 4000);
  assert.equal(proposal.plan.length, 4000);
  assert.equal(proposal.duration.length, 500);
  assert.equal(proposal.link, link);
  assert.equal((await decide(url, proposal.id)).response.status, 200);
  const confirmed = await milestone(url, proposal.id, 'prototype', { evidence: ` ${'д'.repeat(4000)} ` });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.proposal.milestones[0].evidence.length, 4000);
});
