import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { createApplication } from '../../server.mjs';
import { temporaryDirectory } from './helpers.mjs';

const origin = 'http://127.0.0.1:3000';
async function setup(t, options = {}) {
  const dataFile = join(await temporaryDirectory(t), 'legacy.json');
  const app = await createApplication({dataFile, origin, ...options});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    const closed = new Promise(resolve => app.server.close(resolve));
    app.server.closeAllConnections();
    await closed;
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return {app, url};
}

function browser(url) {
  const jar = new Map();
  let csrfToken = '';
  return {
    async request(path, method = 'GET', body, overrides = {}) {
      const headers = {Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...overrides};
      if (!['GET', 'HEAD'].includes(method)) {
        headers.Origin ??= origin;
        headers['X-CSRF-Token'] ??= csrfToken;
        headers['Content-Type'] ??= 'application/json';
      }
      const response = await fetch(url + path, {method, headers, body:body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), redirect:'manual'});
      for (const cookie of response.headers.getSetCookie()) {
        const [entry] = cookie.split(';');
        const index = entry.indexOf('=');
        if (/Max-Age=0(?:;|$)/.test(cookie)) jar.delete(entry.slice(0, index));
        else jar.set(entry.slice(0,index), entry.slice(index+1));
      }
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch { result = text; }
      if (result?.csrfToken) csrfToken = result.csrfToken;
      return {response, body:result, text};
    },
    async login(role = 'student') {
      await this.request('/api/v2/session');
      const result = await this.request('/api/v2/auth/demo', 'POST', {role});
      assert.equal(result.response.status, 200);
      return result.body.user;
    },
    cookie() { return [...jar].map(([key, value]) => `${key}=${value}`).join('; '); },
  };
}

test('v2 session provides guest CSRF and truthful metadata while demo and Google stay disabled by default', async t => {
  const {app, url} = await setup(t);
  const client = browser(url);
  const session = await client.request('/api/v2/session');
  assert.equal(session.body.user, null);
  assert.match(session.body.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.body.meta.googleEnabled, false);
  assert.equal(session.body.meta.demoEnabled, false);
  assert.ok(session.response.headers.getSetCookie()[0].includes('HttpOnly; SameSite=Lax'));
  assert.equal((await client.request('/api/v2/auth/demo', 'POST', {role:'student'})).response.status, 503);
  assert.equal((await client.request('/api/v2/auth/google/start')).response.status, 503);
  assert.equal((await client.request('/api/v2/profile')).response.status, 401);
  assert.equal((await client.request('/api/v2/orders', 'POST', {title:'Task',category:'Услуги',description:'Need'})).response.status, 401);
  assert.equal(app.platformStore.read().users.length, 0);
  assert.equal((await client.request('/api/state')).body.tasks.length, 5);
});

test('explicit local demo binds one private account to the browser and separates other browsers and legacy storage', async t => {
  const {app, url} = await setup(t, {allowDemo:true});
  const first = browser(url), second = browser(url);
  const student = await first.login();
  assert.equal(student.isDemo, true);
  assert.equal(student.emailVerified, false);
  const switched = await first.request('/api/v2/profile', 'PATCH', {version:student.version, activeRole:'business'});
  assert.equal(switched.body.user.id, student.id);
  const own = await first.request('/api/v2/orders/mine');
  assert.equal(own.body.orders.length, 1);
  assert.equal(own.body.orders[0].ownerId, student.id);
  const other = await second.login('business');
  assert.notEqual(other.id, student.id);
  assert.equal((await second.request(`/api/v2/orders/${own.body.orders[0].id}/status`, 'PATCH', {version:1,status:'closed'})).response.status, 403);
  await first.request('/api/v2/auth/logout', 'POST', {});
  assert.equal((await first.request('/api/v2/session')).body.user, null);
  assert.equal((await first.login('business')).id, student.id);
  assert.equal((await first.request('/api/v2/auth/demo', 'POST', {role:'student',userId:other.id})).response.status, 400);
  assert.equal(app.store.read().tasks.length, 5);
  assert.ok(app.platformStore.read().sessions.every(session => !Object.hasOwn(session,'sessionToken')));
});

test('mutations reject foreign origins, cross-site fetches and forged CSRF without writes', async t => {
  const {app, url} = await setup(t, {allowDemo:true});
  const client = browser(url);
  const user = await client.login('business');
  const before = app.platformStore.read();
  for (const headers of [{Origin:'https://evil.example'}, {'X-CSRF-Token':'x'.repeat(43)}, {'Sec-Fetch-Site':'cross-site'}]) {
    const result = await client.request('/api/v2/profile', 'PATCH', {version:user.version,name:'Forged'}, headers);
    assert.equal(result.response.status, 403);
    assert.equal(result.body.error.code, 'FORBIDDEN');
    assert.deepEqual(app.platformStore.read(), before);
  }
  assert.equal((await client.request('/api/v2/session','GET',undefined,{Origin:'https://evil.example'})).response.status,403);
  const wrongMethod = await client.request('/api/v2/orders','DELETE',{});
  assert.equal(wrongMethod.response.status,405);
  assert.equal(wrongMethod.response.headers.get('allow'),'GET, POST');
});

test('HTTP executes solo application, manual selection, completion and public review without exposing evidence', async t => {
  const {url} = await setup(t,{allowDemo:true});
  const owner = browser(url), student = browser(url);
  await owner.login('business');
  const person = await student.login('student');
  const created = await owner.request('/api/v2/orders','POST',{title:'Учёт заявок',category:'Услуги',description:'Собрать прототип.'});
  assert.equal(created.response.status,201);
  let order=created.body.order;
  assert.equal(order.rating.score,0);
  const applied=await student.request(`/api/v2/orders/${order.id}/applications`,'POST',{message:'Соберу и проверю прототип.'});
  assert.equal(applied.response.status,201);
  const applications=await owner.request(`/api/v2/orders/${order.id}/applications`);
  assert.equal(applications.body.applications[0].student.id,person.id);
  assert.ok(!Object.hasOwn(applications.body.applications[0].student,'email'));
  const selected=await owner.request(`/api/v2/applications/${applied.body.application.id}`,'PATCH',{status:'accepted',version:order.version});
  assert.equal(selected.response.status,200);
  order=selected.body.order;
  assert.equal(order.status,'in_progress');
  const own=await student.request('/api/v2/applications/mine');
  assert.ok(own.body.applications.some(application=>application.order.id===order.id));
  const completed=await owner.request(`/api/v2/orders/${order.id}/status`,'PATCH',{status:'completed',version:order.version,evidence:'PRIVATE_EVIDENCE'});
  assert.equal(completed.response.status,200);
  const review=await owner.request(`/api/v2/orders/${order.id}/reviews`,'POST',{studentId:person.id,text:'Прототип принят.'});
  assert.equal(review.response.status,201);
  const publicPage=await browser(url).request(`/api/v2/profiles/${person.id}`);
  assert.equal(publicPage.body.reviews.length,1);
  assert.ok(!publicPage.text.includes('PRIVATE_EVIDENCE'));
  assert.ok(!Object.hasOwn(publicPage.body.profile,'email'));
});

test('raw attachments require authenticated ownership and download safely with UTF-8 filenames', async t => {
  const {url} = await setup(t,{allowDemo:true});
  const owner=browser(url), student=browser(url), other=browser(url);
  await owner.login('business'); await student.login(); await other.login('business');
  const own=await owner.request('/api/v2/orders/mine');
  const order=own.body.orders[0];
  const headers={'Content-Type':'text/plain','X-File-Name':encodeURIComponent('Задание.txt'),'X-Order-Version':String(order.version)};
  assert.equal((await other.request(`/api/v2/orders/${order.id}/files`,'POST',Buffer.from('private'),headers)).response.status,403);
  const uploaded=await owner.request(`/api/v2/orders/${order.id}/files`,'POST',Buffer.from('Тестовое задание'),headers);
  assert.equal(uploaded.response.status,201);
  const file=uploaded.body.file;
  const guest=await browser(url).request(`/api/v2/files/${file.id}`);
  assert.equal(guest.response.status,401);
  const downloaded=await student.request(`/api/v2/files/${file.id}`);
  assert.equal(downloaded.response.status,200);
  assert.equal(downloaded.body,'Тестовое задание');
  assert.match(downloaded.response.headers.get('content-disposition'),/attachment; filename="download.txt"; filename\*=UTF-8''/);
  assert.equal(downloaded.response.headers.get('x-content-type-options'),'nosniff');
  assert.equal((await other.request(`/api/v2/files/${file.id}`)).response.status,403);
  const detail=await student.request(`/api/v2/orders/${order.id}`);
  assert.equal(detail.body.files.length,1);
  assert.ok(!Object.hasOwn(detail.body.files[0],'contentBase64'));
  const removed=await owner.request(`/api/v2/files/${file.id}`,'DELETE',{version:uploaded.body.orderVersion});
  assert.equal(removed.response.status,200);
  assert.equal((await student.request(`/api/v2/files/${file.id}`)).response.status,404);
});
