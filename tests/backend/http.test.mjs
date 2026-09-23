import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
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
  const done = new Promise((resolve,reject) => app.server.close(error => error ? reject(error) : resolve()));
  app.server.closeAllConnections();
  await done;
}
async function setup(t, options = {}) {
  const file = join(await temporaryDirectory(t), 'db.json');
  const app = await createApplication({dataFile:file, ...options});
  const url = await listen(app);
  t.after(() => close(app));
  return {app, url, file};
}

test('state returns complete contract metadata, server ratings and derived points', async t => {
  const {url} = await setup(t);
  const response = await fetch(`${url}/api/state`);
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/application\/json; charset=utf-8/);
  const state = await response.json();
  assert.deepEqual(Object.keys(state).sort(), ['drafts','meta','proposals','tasks','teams']);
  assert.deepEqual(state.tasks.map(task=>task.rating.score), [100,90,65,45,20]);
  assert.ok(state.teams.every(team=>team.points===0));
  assert.equal(state.meta.fields.length,11);
  assert.equal(state.meta.aiMode,'local');
});

test('HTTP catalog applies filters, keeps weak published cards and hides private drafts', async t => {
  const {app,url} = await setup(t);
  await app.store.mutate(state => {state.tasks[0].published=false;});
  const read = async path => (await fetch(url+path)).json();
  assert.deepEqual((await read('/api/catalog')).tasks.map(task=>task.rating.score), [90,65,45,20]);
  assert.equal((await read('/api/catalog?level=draft')).tasks[0].id,'task_service');
  const params = new URLSearchParams({query:'  КАРТЫ  ',industry:'Туризм',level:'working'});
  assert.equal((await read(`/api/catalog?${params}`)).tasks[0].id,'task_tour');
  assert.equal((await read('/api/state')).tasks.length,5);
  assert.equal((await read('/api/catalog?query=no-such-task')).tasks.length,0);
});

test('invalid filters return contract errors, and future endpoints are not fake successes', async t => {
  const {url} = await setup(t);
  for (const query of ['level=bad','industry=bad','level=draft&level=ready','unknown=x']) {
    const response = await fetch(`${url}/api/catalog?${query}`);
    assert.equal(response.status,400);
    assert.equal((await response.json()).error.code,'VALIDATION_ERROR');
  }
  const method = await fetch(`${url}/api/state`,{method:'POST'});
  assert.equal(method.status,405);
  assert.equal(method.headers.get('allow'),'GET');
  const future = await fetch(`${url}/api/ai/analyze`,{method:'POST'});
  assert.equal(future.status,404);
  assert.equal((await future.json()).error.code,'NOT_FOUND');
});

test('static serving preserves frontend assets and correct module MIME without exposing source', async t => {
  const {url} = await setup(t);
  for (const [path,type] of [['/','text/html'],['/api.js','text/javascript'],['/styles.css','text/css']]) {
    const response = await fetch(url+path);
    assert.equal(response.status,200);
    assert.ok(response.headers.get('content-type').startsWith(type));
  }
  const head = await fetch(`${url}/api.js`,{method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(await head.text(),'');
  for (const path of ['/server.mjs','/src/store.mjs','/data/state.json']) assert.equal((await fetch(url+path)).status,404);
  for (const path of ['/.env','/%2e%2e%2fserver.mjs','/..%5cserver.mjs','/api.js:secret']) assert.equal((await fetch(url+path)).status,403);
  assert.equal((await fetch(`${url}/bad%ZZ`)).status,400);
});

test('missing public index shows technical text and API still works', async t => {
  const {url} = await setup(t,{publicDir:join(await temporaryDirectory(t),'missing-public')});
  const response = await fetch(url);
  assert.equal(response.status,200);
  assert.match(await response.text(),/API работает/);
  assert.equal((await fetch(`${url}/api/catalog`)).status,200);
});

test('server reopens the same persisted file without reseeding or changing publication dates', async t => {
  const {app,url,file} = await setup(t);
  const before = await (await fetch(`${url}/api/state`)).json();
  await app.store.mutate(state => {state.tasks[0].fields.data='';});
  await close(app);
  const reopened = await createApplication({dataFile:file});
  const nextUrl = await listen(reopened);
  t.after(()=>close(reopened));
  const after = await (await fetch(`${nextUrl}/api/state`)).json();
  assert.equal(after.tasks[0].rating.score,80);
  assert.equal(after.tasks[0].publishedAt,before.tasks[0].publishedAt);
});

test('unchanged frontend transport loads live API instead of preview data', async t => {
  const {url} = await setup(t);
  const nativeFetch = globalThis.fetch;
  const oldLocation = globalThis.location;
  const requested = [];
  globalThis.location = {search:''};
  globalThis.fetch = (path, options) => { requested.push(path); return nativeFetch(new URL(path,url),options); };
  try {
    const client = await import('../../public/api.js?backend-integration');
    const state = await client.loadState();
    const weak = await client.loadCatalog({level:'draft'});
    assert.equal(state.teams.length,5);
    assert.equal(weak[0].rating.score,20);
    assert.deepEqual(requested, ['/api/state','/api/catalog?level=draft']);
  } finally {
    globalThis.fetch = nativeFetch;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
  }
});
