import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ownProfile } from './profile.mjs';

export const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROVIDER_BYTES = 64 * 1024;
const MAX_PENDING_STATES = 1000;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const opaque = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const isOpaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export class AuthError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

const unavailable = () => new AuthError('Вход через Google не настроен.', 503, 'AUTH_NOT_CONFIGURED');
const invalidState = () => new AuthError('Попытка входа недействительна или истекла. Начните вход заново.', 400, 'AUTH_STATE_INVALID');
const providerError = () => new AuthError('Не удалось подтвердить вход через Google. Попробуйте ещё раз.', 502, 'AUTH_PROVIDER_ERROR');

function configuration(clientId, clientSecret, redirectUri) {
  if ([clientId, clientSecret, redirectUri].every(value => value === undefined || value === '')) return null;
  if ([clientId, clientSecret, redirectUri].some(value => typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x20\x7f]/.test(value))) throw unavailable();
  if (clientId.length > 512 || clientSecret.length > 4096 || redirectUri.length > 2048 || /[\\?#]/.test(redirectUri)) throw unavailable();
  let url;
  try { url = new URL(redirectUri); } catch { throw unavailable(); }
  const localHTTP = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:\/|$)/.test(redirectUri);
  if (url.username || url.password || !url.hostname || (url.protocol !== 'https:' && !localHTTP)) throw unavailable();
  return {clientId, clientSecret, redirectUri};
}

function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length > 2000 || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) {
    throw new AuthError('Некорректный адрес возврата.', 400, 'VALIDATION_ERROR');
  }
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw new AuthError('Некорректный адрес возврата.', 400, 'VALIDATION_ERROR'); }
  if (decoded.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(decoded) || new URL(value, 'https://local.invalid').origin !== 'https://local.invalid') {
    throw new AuthError('Некорректный адрес возврата.', 400, 'VALIDATION_ERROR');
  }
  return value;
}

function identity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(value.sub) ||
      typeof value.email !== 'string' || value.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(value.email)) throw providerError();
  if (value.email_verified !== true) {
    throw new AuthError('Для входа нужен подтверждённый Google адрес электронной почты.', 403, 'AUTH_EMAIL_UNVERIFIED');
  }
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 160 || /[\x00-\x1f\x7f]/.test(value.name))) throw providerError();
  let photoUrl = '';
  if (typeof value.picture === 'string' && value.picture.length <= 2048 && !/[\\\x00-\x20\x7f]/.test(value.picture)) {
    try {
      const picture = new URL(value.picture);
      if (picture.protocol === 'https:' && !picture.username && !picture.password) photoUrl = value.picture;
    } catch { /* An unavailable optional picture does not prevent sign-in. */ }
  }
  return {googleSubject: value.sub, email: value.email, emailVerified: true, name: value.name?.trim() ?? '', photoUrl};
}

// Google server-side code flow and userinfo; ID tokens are deliberately neither read nor stored.
// https://developers.google.com/identity/protocols/oauth2/web-server
// https://developers.google.com/identity/openid-connect/openid-connect
export function createGoogleAuth({store, clientId, clientSecret, redirectUri, fetchImpl = fetch, now = () => Date.now(), timeoutMs = 10000} = {}) {
  if (!store || typeof store.read !== 'function' || typeof store.mutate !== 'function') throw new TypeError('Auth requires a platform store');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Invalid auth timeout');
  const config = configuration(clientId, clientSecret, redirectUri);
  const pending = new Map();

  function pruneStates() {
    const time = now();
    for (const [state, entry] of pending) if (entry.expiresAt <= time) pending.delete(state);
  }

  async function providerJSON(url, options) {
    const controller = new AbortController();
    let reader;
    let timer;
    const cancelReader = () => { if (reader) void reader.cancel().catch(() => {}); };
    try {
      return await Promise.race([
        (async () => {
          const response = await fetchImpl(url, {...options, redirect: 'error', signal: controller.signal});
          if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_PROVIDER_BYTES) {
            if (response.body) void response.body.cancel().catch(() => {});
            throw providerError();
          }
          reader = response.body.getReader();
          const chunks = [];
          let bytes = 0;
          try {
            while (true) {
              const {done, value} = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > MAX_PROVIDER_BYTES) { cancelReader(); throw providerError(); }
              chunks.push(Buffer.from(value));
            }
            return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
          } finally { reader.releaseLock(); reader = undefined; }
        })(),
        new Promise((_resolve, reject) => { timer = setTimeout(() => {
          cancelReader();
          controller.abort();
          reject(providerError());
        }, timeoutMs); }),
      ]);
    } catch { throw providerError(); }
    finally { clearTimeout(timer); cancelReader(); controller.abort(); }
  }

  function begin({role = 'student', returnTo = '/orders'} = {}) {
    if (!config) throw unavailable();
    if (!['student', 'business'].includes(role)) throw new AuthError('Неизвестная роль.', 400, 'VALIDATION_ERROR');
    returnTo = safeReturnTo(returnTo);
    pruneStates();
    if (pending.size >= MAX_PENDING_STATES) throw new AuthError('Слишком много попыток входа. Попробуйте позже.', 503, 'AUTH_BUSY');
    const state = opaque();
    const stateCookie = opaque();
    const verifier = opaque();
    pending.set(state, {cookieHash: hash(stateCookie), verifier, role, returnTo, expiresAt: now() + AUTH_STATE_TTL_MS});
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
      scope: 'openid email profile', access_type: 'online', state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    }).toString();
    return {url: url.toString(), stateCookie};
  }

  async function callback({state, stateCookie, code} = {}) {
    if (!config) throw unavailable();
    pruneStates();
    const entry = isOpaque(state) ? pending.get(state) : undefined;
    if (!entry || !isOpaque(stateCookie) || !timingSafeEqual(Buffer.from(entry.cookieHash, 'hex'), Buffer.from(hash(stateCookie), 'hex'))) throw invalidState();
    // Consume before any asynchronous work: parallel callbacks and provider-error replays fail.
    pending.delete(state);
    if (typeof code !== 'string' || !code || code.length > 4096 || /[\x00-\x20\x7f]/.test(code)) throw invalidState();
    const tokens = await providerJSON(TOKEN_URL, {
      method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
      body: new URLSearchParams({code, client_id: config.clientId, client_secret: config.clientSecret,
        redirect_uri: config.redirectUri, grant_type: 'authorization_code', code_verifier: entry.verifier}).toString(),
    });
    if (!tokens || typeof tokens.access_token !== 'string' || !/^[\x21-\x7e]{1,8192}$/.test(tokens.access_token) ||
      typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer') throw providerError();
    const verified = identity(await providerJSON(USERINFO_URL, {
      method: 'GET', headers: {Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json'},
    }));
    const sessionToken = opaque();
    const time = now();
    const timestamp = new Date(time).toISOString();
    return store.mutate(data => {
      let user = data.users.find(item => item.googleSubject === verified.googleSubject);
      if (!user) {
        user = {id: `user_${randomUUID()}`, ...verified, contacts: '', activeRole: entry.role,
          student: {skills: [], portfolio: []}, business: {companyName: '', industry: ''},
          version: 1, createdAt: timestamp, updatedAt: timestamp};
        data.users.push(user);
      } else if (user.email !== verified.email || !user.emailVerified || user.activeRole !== entry.role) {
        user.email = verified.email;
        user.emailVerified = true;
        user.activeRole = entry.role;
        user.version += 1;
        user.updatedAt = timestamp;
      }
      data.sessions = data.sessions.filter(item => Date.parse(item.expiresAt) > time);
      data.sessions.push({tokenHash: hash(sessionToken), userId: user.id, createdAt: timestamp,
        expiresAt: new Date(time + SESSION_TTL_MS).toISOString()});
      return {sessionToken, user: ownProfile(user), returnTo: entry.returnTo};
    });
  }

  function session(token) {
    if (!isOpaque(token)) return null;
    const data = store.read();
    const found = data.sessions.find(item => item.tokenHash === hash(token) && Date.parse(item.expiresAt) > now());
    if (!found) return null;
    const user = data.users.find(item => item.id === found.userId);
    return user ? ownProfile(user) : null;
  }

  async function logout(token) {
    if (!isOpaque(token)) return false;
    const tokenHash = hash(token);
    return store.mutate(data => {
      const index = data.sessions.findIndex(item => item.tokenHash === tokenHash);
      if (index < 0) return false;
      data.sessions.splice(index, 1);
      return true;
    });
  }

  return {begin, callback, session, logout};
}
