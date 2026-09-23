import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { createApplication } from '../../server.mjs';
import { temporaryDirectory } from './helpers.mjs';
import { request } from 'node:http';
import { MAX_JSON_BYTES } from '../../src/http-json.mjs';
import { readFile } from 'node:fs/promises';
import { FALLBACK_WARNING } from '../../src/ai/analyze.mjs';

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
  const future = await fetch(`${url}/api/tasks/future/publish`,{method:'POST'});
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

const draftInput = {role:'business', businessId:'business_demo', raw:'Нужен учёт заявок из разных каналов.', industry:'Услуги'};
const postDraft = (url, body = draftInput) => fetch(`${url}/api/tasks`, {
  method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
});

test('POST creates a server-owned unpublished draft and persists it across server restarts', async t => {
  const {app,url,file} = await setup(t);
  const response = await postDraft(url,{...draftInput,raw:`  ${draftInput.raw}  `});
  assert.equal(response.status,201);
  const {task} = await response.json();
  assert.match(task.id,/^task_[\da-f-]+$/);
  assert.equal(task.raw,draftInput.raw);
  assert.equal(task.company,'Мой бизнес');
  assert.equal(task.businessId,'business_demo');
  assert.ok(Object.values(task.fields).every(value=>value===''));
  assert.deepEqual(task.confirmedFields,[]);
  assert.equal(task.confirmedAt,null);
  assert.equal(task.published,false);
  assert.equal(task.publishedAt,null);
  assert.equal(task.version,1);
  assert.equal(task.rating.score,0);
  assert.equal(task.rating.level.key,'draft');
  assert.equal(task.createdAt,task.updatedAt);
  assert.ok(Number.isFinite(Date.parse(task.createdAt)));
  assert.equal((await (await fetch(`${url}/api/catalog`)).json()).tasks.length,5);
  await close(app);
  const reopened = await createApplication({dataFile:file});
  const nextUrl = await listen(reopened);
  t.after(()=>close(reopened));
  const state = await (await fetch(`${nextUrl}/api/state`)).json();
  assert.deepEqual(state.tasks.find(item=>item.id===task.id),task);
});

test('POST rejects wrong identity, invalid values and injected server-owned fields without writes', async t => {
  const {app,url} = await setup(t);
  for (const patch of [{role:'team'}, {businessId:'other'}, {role:null}]) {
    assert.equal((await postDraft(url,{...draftInput,...patch})).status,403);
  }
  for (const patch of [{raw:''}, {raw:'   '}, {raw:null}, {raw:5}, {raw:'x'.repeat(4001)},
    {industry:''}, {industry:'unknown'}, {industry:[]}, {rating:{score:100}}, {published:true},
    {fields:{title:'Injected'}}, {confirmedFields:['data']}, {id:'chosen-by-client'}]) {
    const response = await postDraft(url,{...draftInput,...patch});
    assert.equal(response.status,400,JSON.stringify(patch));
    assert.equal((await response.json()).error.code,'VALIDATION_ERROR');
  }
  assert.equal(app.store.read().tasks.length,5);
});

test('POST accepts the maximum description and serializes concurrent draft writes', async t => {
  const {app,url} = await setup(t);
  const responses = await Promise.all(Array.from({length:4},(_,i)=>postDraft(url,{...draftInput,raw:i ? `Task ${i}` : 'я'.repeat(4000)})));
  const ids = [];
  for (const response of responses) {
    assert.equal(response.status,201);
    ids.push((await response.json()).task.id);
  }
  assert.equal(new Set(ids).size,4);
  assert.equal(app.store.read().tasks.length,9);
  assert.equal((await (await fetch(`${url}/api/catalog`)).json()).tasks.length,5);
});

test('POST rejects malformed bodies, content types and oversized requests with structured errors', async t => {
  const {app,url} = await setup(t);
  for (const body of ['', '{', 'null', '[]', '123', '"text"']) {
    const response = await fetch(`${url}/api/tasks`,{method:'POST',headers:{'Content-Type':'application/json'},body});
    assert.equal(response.status,400);
    assert.equal((await response.json()).error.code,'VALIDATION_ERROR');
  }
  const contentType = await fetch(`${url}/api/tasks`,{method:'POST',body:JSON.stringify(draftInput)});
  assert.equal(contentType.status,400);
  const large = await fetch(`${url}/api/tasks`,{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(MAX_JSON_BYTES+1)});
  assert.equal(large.status,413);
  assert.equal((await large.json()).error.code,'PAYLOAD_TOO_LARGE');
  const get = await fetch(`${url}/api/tasks`);
  assert.equal(get.status,405);
  assert.equal(get.headers.get('allow'),'POST');
  assert.equal(app.store.read().tasks.length,5);
});

test('chunked JSON enforces size bound even without Content-Length', async t => {
  const {app,url} = await setup(t);
  const result = await new Promise((resolve,reject) => {
    const req = request(`${url}/api/tasks`,{method:'POST',headers:{'Content-Type':'application/json','Transfer-Encoding':'chunked'}},res=>{
      let body=''; res.on('data',chunk=>{body+=chunk;});
      res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
    });
    req.on('error',reject);
    req.write(' '.repeat(MAX_JSON_BYTES));
    req.end(' ');
  });
  assert.equal(result.status,413);
  assert.equal(result.body.error.code,'PAYLOAD_TOO_LARGE');
  assert.equal(app.store.read().tasks.length,5);
});

const postAnalysis = (url,body={raw:draftInput.raw,industry:draftInput.industry}) => fetch(`${url}/api/ai/analyze`,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
});

test('AI HTTP endpoint analyzes without writing, confirming or scoring saved tasks', async t => {
  const {app,url,file}=await setup(t);
  const before=app.store.read();
  const diskBefore=await readFile(file,'utf8');
  const response=await postAnalysis(url);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.mode,'local');
  assert.equal(body.fields.context,draftInput.raw);
  assert.ok(body.questions.length>=3);
  assert.ok(body.warnings.some(message=>message.includes('заглушка')));
  assert.deepEqual(app.store.read(),before);
  assert.equal(await readFile(file,'utf8'),diskBefore);
});

test('invalid analysis requests and methods use existing JSON error contract without writes', async t => {
  const {app,url,file}=await setup(t);
  const diskBefore=await readFile(file,'utf8');
  for (const body of [{}, {raw:draftInput.raw,industry:'bad'}, {raw:draftInput.raw,industry:'Услуги',answers:[]}]) {
    const response=await postAnalysis(url,body);
    assert.equal(response.status,400);
    const result=await response.json();
    assert.equal(result.error.code,'VALIDATION_ERROR');
    assert.deepEqual(result.error.fields,{});
  }
  const get=await fetch(`${url}/api/ai/analyze`);
  assert.equal(get.status,405);
  assert.equal(get.headers.get('allow'),'POST');
  const large=await postAnalysis(url,{raw:'x'.repeat(MAX_JSON_BYTES),industry:'Услуги'});
  assert.equal(large.status,413);
  assert.equal(app.store.read().tasks.length,5);
  assert.equal(await readFile(file,'utf8'),diskBefore);
});

test('invalid generated result falls back through HTTP without persisting or exposing diagnostics', async t => {
  const {app,url,file}=await setup(t,{analysisOptions:{generate:()=>'{invalid secret diagnostic'}});
  const before=app.store.read();
  const diskBefore=await readFile(file,'utf8');
  const response=await postAnalysis(url,{raw:draftInput.raw,industry:'Услуги',fields:{data:'Сведения человека'}});
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.fields.data,'Сведения человека');
  assert.ok(result.warnings.includes(FALLBACK_WARNING));
  assert.equal(JSON.stringify(result).includes('secret diagnostic'),false);
  assert.deepEqual(app.store.read(),before);
  assert.equal(await readFile(file,'utf8'),diskBefore);
});
