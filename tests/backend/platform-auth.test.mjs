import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGoogleAuth, AuthError, AUTH_STATE_TTL_MS, SESSION_TTL_MS } from '../../src/platform/auth.mjs';
import { createPlatformStore } from '../../src/platform/store.mjs';
import { temporaryDirectory } from './helpers.mjs';

const CLIENT_ID = 'fake-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'fake-test-only-client-secret';
const ACCESS_TOKEN = 'fake-test-only-access-token';
const REFRESH_TOKEN = 'fake-test-only-refresh-token';
const CODE = 'fake-test-only-authorization-code';
const PROVIDER_DIAGNOSTIC = 'fake-private-provider-diagnostic';
const REDIRECT_URI = 'http://localhost:3000/api/v2/auth/google/callback';
const config = {clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI};
const googleUser = {sub: 'google-subject-123', email: 'student@example.com', email_verified: true, name: 'Имя Google', picture: 'https://example.com/photo.png'};
const json = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});

function fakeGoogle({user = googleUser, requests = []} = {}) {
  return async (url, options) => {
    requests.push({url, options});
    if (url === 'https://oauth2.googleapis.com/token') return json({access_token: ACCESS_TOKEN, token_type: 'Bearer', refresh_token: REFRESH_TOKEN, id_token: 'not-a-valid-JWT-and-never-used'});
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return json(user);
    assert.fail('Auth must call a fixed Google endpoint');
  };
}

async function setup(t, overrides = {}) {
  const file = join(await temporaryDirectory(t), 'platform.json');
  const store = await createPlatformStore(file);
  let time = Date.parse('2026-09-23T10:00:00.000Z');
  const requests = [];
  const auth = createGoogleAuth({store, ...config, now: () => time, fetchImpl: fakeGoogle({requests}), ...overrides});
  return {auth, store, file, requests, advance: milliseconds => { time += milliseconds; }, now: () => time};
}

function attempt(auth, options) {
  const start = auth.begin(options);
  return {...start, state: new URL(start.url).searchParams.get('state'), code: CODE};
}

function expectedError(status, code) {
  return error => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    for (const secret of [CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN, CODE, PROVIDER_DIAGNOSTIC]) assert.equal(error.message.includes(secret), false);
    return true;
  };
}

test('begin uses distinct browser-bound state, minimal Google scopes and PKCE without exposing secrets', async t => {
  const {auth, store, requests} = await setup(t);
  const first = attempt(auth, {role: 'business', returnTo: '/orders?mine=1'});
  const second = attempt(auth);
  const url = new URL(first.url);
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('access_type'), 'online');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.state, first.stateCookie);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.stateCookie, second.stateCookie);
  assert.equal(first.url.includes(CLIENT_SECRET), false);
  assert.equal(first.url.includes(first.stateCookie), false);
  assert.equal(requests.length, 0);
  assert.deepEqual(store.read().users, []);
  assert.deepEqual(store.read().sessions, []);
});

test('callback verifies the Google user, consumes PKCE and persists only a hashed seven-day session', async t => {
  const {auth, store, file, requests, now} = await setup(t);
  const login = attempt(auth, {role: 'business', returnTo: '/orders?mine=1'});
  const result = await auth.callback(login);
  assert.equal(result.returnTo, '/orders?mine=1');
  assert.equal(result.user.activeRole, 'business');
  assert.equal(result.user.emailVerified, true);
  assert.equal(result.user.email, googleUser.email);
  assert.equal(result.user.name, googleUser.name);
  assert.equal(result.user.googleSubject, undefined);
  assert.deepEqual(result.user.student, {skills: [], portfolio: []});
  assert.deepEqual(result.user.business, {companyName: '', industry: ''});
  assert.equal(result.user.version, 1);
  assert.match(result.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(requests.length, 2);
  const exchange = requests[0];
  assert.equal(exchange.url, 'https://oauth2.googleapis.com/token');
  assert.equal(exchange.options.method, 'POST');
  assert.equal(exchange.options.redirect, 'error');
  const body = new URLSearchParams(exchange.options.body);
  assert.equal(body.get('client_secret'), CLIENT_SECRET);
  assert.equal(body.get('code'), CODE);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('redirect_uri'), REDIRECT_URI);
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), new URL(login.url).searchParams.get('code_challenge'));
  assert.equal(requests[1].url, 'https://openidconnect.googleapis.com/v1/userinfo');
  assert.equal(requests[1].options.headers.Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(requests[1].options.redirect, 'error');
  const saved = store.read();
  assert.equal(saved.users[0].googleSubject, googleUser.sub);
  assert.deepEqual(saved.sessions[0], {
    tokenHash: createHash('sha256').update(result.sessionToken).digest('hex'), userId: result.user.id,
    createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + SESSION_TTL_MS).toISOString(),
  });
  const onDisk = await readFile(file, 'utf8');
  for (const secret of [result.sessionToken, CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN, CODE, login.state, login.stateCookie, body.get('code_verifier')]) assert.equal(onDisk.includes(secret), false);
  assert.deepEqual(auth.session(result.sessionToken), result.user);
  const mutable = auth.session(result.sessionToken);
  mutable.student.skills.push('mutated outside the store');
  assert.deepEqual(auth.session(result.sessionToken).student.skills, []);
});

test('callback state is browser-bound, expires at ten minutes and is one-use under concurrent replay', async t => {
  const {auth, requests, advance, store} = await setup(t);
  const login = attempt(auth);
  const otherBrowser = attempt(auth);
  for (const patch of [{state: otherBrowser.state}, {stateCookie: otherBrowser.stateCookie}, {stateCookie: ''}, {state: ''}]) {
    await assert.rejects(auth.callback({...login, ...patch}), expectedError(400, 'AUTH_STATE_INVALID'));
  }
  assert.equal(requests.length, 0);
  const results = await Promise.allSettled([auth.callback(login), auth.callback(login)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'AUTH_STATE_INVALID');
  assert.equal(store.read().users.length, 1);
  assert.equal(store.read().sessions.length, 1);
  await assert.rejects(auth.callback(login), expectedError(400, 'AUTH_STATE_INVALID'));
  const expired = attempt(auth);
  advance(AUTH_STATE_TTL_MS);
  await assert.rejects(auth.callback(expired), expectedError(400, 'AUTH_STATE_INVALID'));
  assert.equal(requests.length, 2);
});

test('unsafe redirect configuration, return addresses and roles are rejected without provider calls', async t => {
  const {auth, store, requests} = await setup(t);
  for (const redirectUri of ['http://example.com/callback', 'http://localhost.evil.test/callback', 'http://127.1/callback', 'http://2130706433/callback', 'https://name:secret@example.com/callback', 'https://example.com/callback?x=1', 'https://example.com/callback#x', 'https://example.com/callback?', 'https://example.com\\@evil.test/callback']) {
    assert.throws(() => createGoogleAuth({store, ...config, redirectUri}), expectedError(503, 'AUTH_NOT_CONFIGURED'));
  }
  for (const redirectUri of ['https://app.example.com/api/v2/auth/google/callback', 'http://127.0.0.1:3000/callback']) {
    assert.doesNotThrow(() => createGoogleAuth({store, ...config, redirectUri}));
  }
  for (const returnTo of ['https://evil.test', '//evil.test', '/\\evil.test', '/%2f%2fevil.test', '/orders%0d%0aInjected:yes', '/bad%encoding']) {
    assert.throws(() => auth.begin({returnTo}), expectedError(400, 'VALIDATION_ERROR'));
  }
  assert.throws(() => auth.begin({role: 'admin'}), expectedError(400, 'VALIDATION_ERROR'));
  assert.equal(requests.length, 0);
});

test('missing Google configuration disables login with 503 and does not create a demo identity', async t => {
  const {store} = await setup(t);
  let calls = 0;
  const auth = createGoogleAuth({store, fetchImpl: async () => { calls++; assert.fail('No Google call expected'); }});
  assert.throws(() => auth.begin(), expectedError(503, 'AUTH_NOT_CONFIGURED'));
  await assert.rejects(auth.callback({state: 'ignored', stateCookie: 'ignored', code: CODE}), expectedError(503, 'AUTH_NOT_CONFIGURED'));
  assert.equal(auth.session('missing'), null);
  assert.equal(calls, 0);
  assert.deepEqual(store.read().users, []);
});

test('provider failures consume the attempt, discard error bodies and do not leak or persist credentials', async t => {
  for (const stage of ['token', 'userinfo']) {
    let cancelled = false;
    let calls = 0;
    const {auth, store, file} = await setup(t, {fetchImpl: async url => {
      calls++;
      if (stage === 'userinfo' && url.endsWith('/token')) return json({access_token: ACCESS_TOKEN, token_type: 'Bearer'});
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(`${PROVIDER_DIAGNOSTIC} ${CLIENT_SECRET}`)); },
        cancel() { cancelled = true; },
      });
      return new Response(body, {status: 500});
    }});
    const before = await readFile(file, 'utf8');
    const login = attempt(auth);
    await assert.rejects(auth.callback(login), expectedError(502, 'AUTH_PROVIDER_ERROR'));
    assert.equal(cancelled, true);
    await assert.rejects(auth.callback(login), expectedError(400, 'AUTH_STATE_INVALID'));
    assert.equal(calls, stage === 'token' ? 1 : 2);
    assert.deepEqual(store.read().users, []);
    assert.deepEqual(store.read().sessions, []);
    assert.equal(await readFile(file, 'utf8'), before);
  }
});

test('invalid provider JSON, missing tokens and unverified identity cannot create users', async t => {
  const fixtures = [
    {token: '<invalid secret>', status: 502, code: 'AUTH_PROVIDER_ERROR'},
    {token: {}, status: 502, code: 'AUTH_PROVIDER_ERROR'},
    {token: {access_token: ACCESS_TOKEN, token_type: 'Other'}, status: 502, code: 'AUTH_PROVIDER_ERROR'},
    {user: {...googleUser, sub: ''}, status: 502, code: 'AUTH_PROVIDER_ERROR'},
    {user: {...googleUser, email: 'not-email'}, status: 502, code: 'AUTH_PROVIDER_ERROR'},
    {user: {...googleUser, email_verified: false}, status: 403, code: 'AUTH_EMAIL_UNVERIFIED'},
    {user: {...googleUser, email_verified: 'true'}, status: 403, code: 'AUTH_EMAIL_UNVERIFIED'},
  ];
  for (const fixture of fixtures) {
    const {auth, store} = await setup(t, {fetchImpl: async url => {
      if (url.endsWith('/token')) return typeof fixture.token === 'string' ? new Response(fixture.token) : json(fixture.token ?? {access_token: ACCESS_TOKEN, token_type: 'Bearer'});
      return json(fixture.user);
    }});
    await assert.rejects(auth.callback(attempt(auth)), expectedError(fixture.status, fixture.code));
    assert.deepEqual(store.read().users, []);
    assert.deepEqual(store.read().sessions, []);
  }
});

test('provider bodies enforce declared and streamed size limits with early cancellation', async t => {
  for (const declared of [true, false]) {
    let pulls = 0;
    let cancelled = false;
    const {auth, store} = await setup(t, {fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(pulls === 1 ? 65536 : 1)); },
      cancel() { cancelled = true; },
    }, {highWaterMark: 0}), {headers: declared ? {'Content-Length': '65537'} : {}})});
    await assert.rejects(auth.callback(attempt(auth)), expectedError(502, 'AUTH_PROVIDER_ERROR'));
    assert.equal(cancelled, true);
    assert.equal(pulls, declared ? 0 : 2);
    assert.deepEqual(store.read().users, []);
  }
});

test('provider timeout aborts stalled requests and safely consumes the attempt', async t => {
  let signal;
  const {auth, store} = await setup(t, {timeoutMs: 10, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error(PROVIDER_DIAGNOSTIC)), {once: true}));
  }});
  const login = attempt(auth);
  await assert.rejects(auth.callback(login), expectedError(502, 'AUTH_PROVIDER_ERROR'));
  assert.equal(signal.aborted, true);
  await assert.rejects(auth.callback(login), expectedError(400, 'AUTH_STATE_INVALID'));
  assert.deepEqual(store.read().sessions, []);
});

test('simultaneous verified callbacks deduplicate by Google subject and issue separate fresh sessions', async t => {
  const {auth, store} = await setup(t);
  const [first, second] = await Promise.all([auth.callback(attempt(auth)), auth.callback(attempt(auth))]);
  assert.equal(first.user.id, second.user.id);
  assert.notEqual(first.sessionToken, second.sessionToken);
  assert.equal(store.read().users.length, 1);
  assert.equal(store.read().sessions.length, 2);
  assert.equal(auth.session(first.sessionToken).id, auth.session(second.sessionToken).id);
});

test('email never merges subjects, while repeat login preserves edited profile and updates verified email/role', async t => {
  const {auth, store, now} = await setup(t);
  const first = await auth.callback(attempt(auth));
  await store.mutate(data => {
    Object.assign(data.users[0], {name: 'Имя пользователя', contacts: 'Мой контакт', photoUrl: 'https://example.com/edited.png'});
    data.users[0].student.skills = ['JavaScript'];
    data.users[0].business.companyName = 'Мой бизнес';
  });
  const changed = createGoogleAuth({store, ...config, now, fetchImpl: fakeGoogle({user: {...googleUser, email: 'new@example.com'}})});
  const again = await changed.callback(attempt(changed, {role: 'business'}));
  assert.equal(again.user.id, first.user.id);
  assert.equal(again.user.name, 'Имя пользователя');
  assert.equal(again.user.contacts, 'Мой контакт');
  assert.equal(again.user.photoUrl, 'https://example.com/edited.png');
  assert.deepEqual(again.user.student.skills, ['JavaScript']);
  assert.equal(again.user.business.companyName, 'Мой бизнес');
  assert.equal(again.user.email, 'new@example.com');
  assert.equal(again.user.activeRole, 'business');
  assert.equal(again.user.version, 2);
  const different = createGoogleAuth({store, ...config, now, fetchImpl: fakeGoogle({user: {...googleUser, sub: 'other-google-subject', email: 'new@example.com'}})});
  const another = await different.callback(attempt(different));
  assert.notEqual(another.user.id, first.user.id);
  assert.equal(store.read().users.length, 2);
});

test('sessions survive store/auth restart, expire exactly at seven days, and logout revokes only its token', async t => {
  const {auth, store, file, now, advance} = await setup(t);
  const first = await auth.callback(attempt(auth));
  const second = await auth.callback(attempt(auth));
  const reopened = await createPlatformStore(file);
  const restarted = createGoogleAuth({store: reopened, ...config, now, fetchImpl: fakeGoogle()});
  assert.deepEqual(restarted.session(first.sessionToken), first.user);
  assert.equal(await restarted.logout(first.sessionToken), true);
  assert.equal(await restarted.logout(first.sessionToken), false);
  assert.equal(restarted.session(first.sessionToken), null);
  assert.equal(restarted.session(second.sessionToken).id, first.user.id);
  const persistedLogout = createGoogleAuth({store: await createPlatformStore(file), ...config, now, fetchImpl: fakeGoogle()});
  assert.equal(persistedLogout.session(first.sessionToken), null);
  advance(SESSION_TTL_MS - 1);
  assert.ok(persistedLogout.session(second.sessionToken));
  advance(1);
  assert.equal(persistedLogout.session(second.sessionToken), null);
  assert.equal(persistedLogout.session('bad'), null);
  assert.equal(await persistedLogout.logout(undefined), false);
  // Original store is a distinct stale snapshot; auth persistence was checked through reopened stores.
  assert.equal(store.read().users.length, 1);
});

test('pending authorization does not survive process restart and Google picture URLs are sanitized', async t => {
  const {auth, store, now} = await setup(t);
  const pending = attempt(auth);
  const restarted = createGoogleAuth({store, ...config, now, fetchImpl: fakeGoogle({user: {...googleUser, picture: 'javascript:alert(1)'}})});
  await assert.rejects(restarted.callback(pending), expectedError(400, 'AUTH_STATE_INVALID'));
  const result = await restarted.callback(attempt(restarted));
  assert.equal(result.user.photoUrl, '');
});
