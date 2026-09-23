import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile(new URL('../../public/preview-data.json', import.meta.url), 'utf8'));
const originalFetch = globalThis.fetch;
const originalLocation = globalThis.location;
let moduleId = 0;
const api = async (search = '') => {
  globalThis.location = { search };
  return import(`../../public/api.js?test=${moduleId++}`);
};
const response = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'Content-Type':'application/json'}});
after(() => { globalThis.fetch = originalFetch; if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation; });

test('explicit preview preserves low-rated published tasks and filters without an API', async () => {
  const urls = [];
  globalThis.fetch = async url => { urls.push(url); return response(fixture); };
  const client = await api('?preview=1');
  await client.loadState();
  assert.deepEqual((await client.loadCatalog()).map(t => t.rating.score), [100,90,65,45,20]);
  const weak = await client.loadCatalog({level:'draft'});
  assert.equal(weak.length, 1);
  assert.equal(weak[0].id, 'task_service');
  assert.equal((await client.loadCatalog({industry:'Туризм'})).length, 1);
  assert.equal((await client.loadCatalog({query:'несуществующая задача'})).length, 0);
  assert.deepEqual(urls, ['/preview-data.json']);
});

test('API mode encodes filters, preserves server scores and excludes private drafts', async () => {
  const urls = [];
  const publicTask = structuredClone(fixture.tasks[4]);
  publicTask.rating.score = 23; // The client must not replace a server calculation with its own.
  globalThis.fetch = async url => { urls.push(url); return response({tasks:[publicTask,{...fixture.tasks[0],id:'private',published:false}]}); };
  const client = await api();
  const tasks = await client.loadCatalog({query:'кофе & чай',industry:'Ритейл',level:'draft'});
  assert.equal(tasks.length,1);
  assert.equal(tasks[0].rating.score,23);
  const parsed = new URL(urls[0], 'http://localhost');
  assert.equal(parsed.pathname,'/api/catalog');
  assert.equal(parsed.searchParams.get('query'),'кофе & чай');
  assert.equal(parsed.searchParams.get('industry'),'Ритейл');
  assert.equal(parsed.searchParams.get('level'),'draft');
});

test('server failure stays an error instead of silently replacing real data with preview fixtures', async () => {
  const urls = [];
  globalThis.fetch = async url => { urls.push(url); return response({error:{code:'UNAVAILABLE',message:'Сервис временно недоступен'}},503); };
  const client = await api();
  await assert.rejects(client.loadState(), /Сервис временно недоступен/);
  assert.deepEqual(urls,['/api/state']);
});

test('malformed JSON and invalid score are rejected with readable errors', async () => {
  const client = await api();
  globalThis.fetch = async () => new Response('<html>error</html>');
  await assert.rejects(client.loadCatalog(), /неожиданном формате/);
  globalThis.fetch = async () => response({tasks:[{...fixture.tasks[0],rating:{...fixture.tasks[0].rating,score:150}}]});
  await assert.rejects(client.loadCatalog(), /контрактом API/);
});

test('catalog requests forward AbortSignal so obsolete searches can be cancelled', async () => {
  const client = await api();
  const controller = new AbortController();
  let received;
  globalThis.fetch = async (url, options) => { received=options.signal; return response({tasks:[]}); };
  await client.loadCatalog({},controller.signal);
  assert.equal(received,controller.signal);
});
