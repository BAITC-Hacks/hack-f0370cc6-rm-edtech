import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { FIELDS, INDUSTRIES, ValidationError } from '../domain.mjs';
import { readJSON } from '../http-json.mjs';
import { analyzeTask } from '../ai/analyze.mjs';
import { AuthError, createGoogleAuth, SESSION_TTL_MS } from './auth.mjs';
import { createDemoSession, seedPlatformDemo } from './demo.mjs';
import { getProfile, publicProfile, updateProfile } from './profile.mjs';
import { applyToOrder, createOrder, decideApplication, getOrder, listApplications, listOrders, listOwnOrders, transitionOrder, updateOrder } from './orders.mjs';
import { ATTACHMENT_LIMITS, createAttachment, deleteAttachment, getAttachment } from './files.mjs';
import { createReview, listStudentReviews } from './reviews.mjs';
import { createCase, updateCase, listOwnCases, listPublicCases, profileProgress } from './cases.mjs';

const COOKIE = { session: 'tasker_session', guest: 'tasker_guest', state: 'tasker_oauth' };
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const routes = [
  [/^\/api\/v2\/session$/, ['GET'], 'session'],
  [/^\/api\/v2\/auth\/google\/start$/, ['GET'], 'googleStart'],
  [/^\/api\/v2\/auth\/google\/callback$/, ['GET'], 'googleCallback'],
  [/^\/api\/v2\/auth\/demo$/, ['POST'], 'demo'],
  [/^\/api\/v2\/auth\/logout$/, ['POST'], 'logout'],
  [/^\/api\/v2\/profile$/, ['GET', 'PATCH'], 'profile'],
  [/^\/api\/v2\/profiles\/([^/]+)\/reviews$/, ['GET'], 'studentReviews'],
  [/^\/api\/v2\/profiles\/([^/]+)$/, ['GET'], 'publicProfile'],
  [/^\/api\/v2\/orders\/mine$/, ['GET'], 'ownOrders'],
  [/^\/api\/v2\/orders$/, ['GET', 'POST'], 'orders'],
  [/^\/api\/v2\/orders\/([^/]+)\/status$/, ['PATCH'], 'orderStatus'],
  [/^\/api\/v2\/orders\/([^/]+)\/applications$/, ['GET', 'POST'], 'orderApplications'],
  [/^\/api\/v2\/orders\/([^/]+)\/files$/, ['POST'], 'upload'],
  [/^\/api\/v2\/orders\/([^/]+)\/reviews$/, ['POST'], 'review'],
  [/^\/api\/v2\/orders\/([^/]+)$/, ['GET', 'PUT'], 'order'],
  [/^\/api\/v2\/applications\/mine$/, ['GET'], 'ownApplications'],
  [/^\/api\/v2\/applications\/([^/]+)$/, ['PATCH'], 'application'],
  [/^\/api\/v2\/files\/([^/]+)$/, ['GET', 'DELETE'], 'file'],
  [/^\/api\/v2\/cases$/, ['GET', 'POST'], 'cases'],
  [/^\/api\/v2\/cases\/([^/]+)$/, ['PATCH'], 'case'],
  [/^\/api\/v2\/ai\/analyze$/, ['POST'], 'analysis'],
  [/^\/api\/v2\/ai\/fit$/, ['POST'], 'fit'],
  [/^\/api\/v2\/ai\/case$/, ['POST'], 'caseFormat'],
];

function send(res, status, body, extra = {}, head = false) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(head ? undefined : bytes);
}

function fail(res, status, code, message, extra, head) {
  send(res, status, { error: { code, message, fields: {} } }, extra, head);
}

function cookies(req) {
  const result = {};
  for (const item of (req.headers.cookie ?? '').split(';')) {
    const index = item.indexOf('=');
    if (index > 0) result[item.slice(0, index).trim()] = item.slice(index + 1).trim();
  }
  return result;
}

function onlyKeys(body, keys) {
  if (Object.keys(body).some(key => !keys.includes(key))) throw new ValidationError('Неизвестное поле запроса.');
}

function query(url, keys) {
  const result = {};
  for (const key of url.searchParams.keys()) {
    if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1) throw new ValidationError('Неизвестный или повторный параметр.');
    result[key] = url.searchParams.get(key);
  }
  return result;
}

function rawFile(req) {
  const maximum = ATTACHMENT_LIMITS.fileBytes;
  if (Number(req.headers['content-length']) > maximum) {
    req.resume();
    throw new ValidationError('Размер файла не должен превышать 5 МиБ.', 413);
  }
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, settled = false;
    const fail = error => { if (!settled) { settled = true; chunks = []; reject(error); } };
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maximum) return fail(new ValidationError('Размер файла не должен превышать 5 МиБ.', 413));
      chunks.push(chunk);
    });
    req.on('aborted', () => fail(new ValidationError('Загрузка прервана.')));
    req.on('error', () => fail(new ValidationError('Не удалось прочитать файл.')));
    req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)); chunks = []; } });
  });
}

export async function createPlatformRouter({ store, origin = 'http://127.0.0.1:3000', googleConfig = {}, analysisOptions, assistOptions, allowDemo = false, onError = () => {} } = {}) {
  const appURL = new URL(origin);
  if (appURL.origin !== origin || !['http:', 'https:'].includes(appURL.protocol)) throw new Error('APP_ORIGIN должен содержать только origin приложения.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(appURL.hostname);
  if (appURL.protocol === 'http:' && !loopback) throw new Error('Для внешнего APP_ORIGIN требуется HTTPS.');
  const demoEnabled = allowDemo === true && loopback;
  const secret = randomBytes(32);
  let auth, googleEnabled = Boolean(googleConfig.clientId && googleConfig.clientSecret && googleConfig.redirectUri);
  try { auth = createGoogleAuth({ ...googleConfig, store }); }
  catch (error) {
    if (!(error instanceof AuthError)) throw error;
    googleEnabled = false;
    auth = createGoogleAuth({ store });
  }
  if (demoEnabled) await seedPlatformDemo(store);
  const attempts = new Map();
  const meta = { industries: INDUSTRIES, fields: FIELDS, googleEnabled, demoEnabled, aiMode: analysisOptions?.mode === 'remote' ? 'remote' : 'local' };
  const csrf = binding => createHmac('sha256', secret).update(binding).digest('base64url');
  function setCookie(res, name, value, seconds) {
    const cookie = `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${appURL.protocol === 'https:' ? '; Secure' : ''}`;
    const prior = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [...(Array.isArray(prior) ? prior : prior ? [prior] : []), cookie]);
  }
  function sameSite(req, mutation = false) {
    if (req.headers['sec-fetch-site'] === 'cross-site' || (mutation ? req.headers.origin !== origin : req.headers.origin && req.headers.origin !== origin)) {
      throw new ValidationError('Запрос должен исходить с этой страницы приложения.', 403);
    }
  }
  function verifyCSRF(req, token, guest, user) {
    sameSite(req, true);
    const binding = user ? `session:${token}` : opaque(guest) ? `guest:${guest}` : null;
    const supplied = req.headers['x-csrf-token'];
    if (!binding || !opaque(supplied) || !timingSafeEqual(Buffer.from(csrf(binding)), Buffer.from(supplied))) {
      throw new ValidationError('Обновите страницу и повторите действие.', 403);
    }
  }
  function limit(req, group, token = '') {
    const time = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= time) attempts.delete(key);
    const key = `${group}:${req.socket.remoteAddress}:${token}`;
    const entry = attempts.get(key) ?? { count: 0, until: time + 60000 };
    if (!attempts.has(key) && attempts.size >= 2000) throw new ValidationError('Слишком много запросов. Попробуйте через минуту.', 429);
    entry.count += 1;
    attempts.set(key, entry);
    if (entry.count > (group === 'ai' ? 30 : 40)) throw new ValidationError('Слишком много запросов. Попробуйте через минуту.', 429);
  }
  function requireUser(user, role) {
    if (!user) throw new ValidationError('Войдите в аккаунт.', 401);
    if (role && user.activeRole !== role) throw new ValidationError('Переключитесь в нужный режим профиля.', 403);
    return user.id;
  }
  function ownUser(user) {
    return user ? { ...user, progress: profileProgress(store, user.id) } : null;
  }
  function sessionBody(user, token, guest) {
    return { user: ownUser(user), csrfToken: csrf(user ? `session:${token}` : `guest:${guest}`), meta };
  }
  function applicationView(application) {
    return { ...application, student: { ...publicProfile(store, application.studentId), progress: profileProgress(store, application.studentId) } };
  }

  async function handle(req, res, url) {
    if (!(url.pathname === '/api/v2' || url.pathname.startsWith('/api/v2/'))) return false;
    try {
      let path;
      try { path = decodeURIComponent(url.pathname); } catch { throw new ValidationError('Некорректный адрес запроса.'); }
      const route = routes.find(([pattern]) => pattern.test(path));
      if (!route) { req.resume(); fail(res, 404, 'NOT_FOUND', 'Маршрут не найден.', {}, req.method === 'HEAD'); return true; }
      const [pattern, methods, name] = route;
      if (!methods.includes(req.method)) {
        req.resume(); fail(res, 405, 'METHOD_NOT_ALLOWED', `Разрешены ${methods.join(', ')}.`, { Allow: methods.join(', ') }, req.method === 'HEAD'); return true;
      }
      const match = pattern.exec(path);
      const jar = cookies(req), token = jar[COOKIE.session], user = auth.session(token);
      let guest = jar[COOKIE.guest];
      if (!['GET', 'HEAD'].includes(req.method)) verifyCSRF(req, token, guest, user);
      if (name === 'session') {
        sameSite(req);
        if (!opaque(guest)) { guest = randomBytes(32).toString('base64url'); setCookie(res, COOKIE.guest, guest, SESSION_TTL_MS / 1000); }
        send(res, 200, sessionBody(user, token, guest));
      } else if (name === 'googleStart') {
        sameSite(req); limit(req, 'login');
        const result = auth.begin(query(url, ['role', 'returnTo']));
        setCookie(res, COOKIE.state, result.stateCookie, 600);
        res.writeHead(302, { Location: result.url, 'Cache-Control': 'no-store' }); res.end();
      } else if (name === 'googleCallback') {
        limit(req, 'login'); setCookie(res, COOKIE.state, '', 0);
        const result = await auth.callback({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), stateCookie: jar[COOKIE.state] });
        setCookie(res, COOKIE.session, result.sessionToken, SESSION_TTL_MS / 1000);
        res.writeHead(303, { Location: result.returnTo, 'Cache-Control': 'no-store' }); res.end();
      } else if (name === 'demo') {
        if (!demoEnabled) throw new AuthError('Демонстрационный вход отключён.', 503, 'DEMO_DISABLED');
        limit(req, 'login');
        const body = await readJSON(req); onlyKeys(body, ['role']);
        const result = await createDemoSession(store, { role: body.role, browserToken: guest, previousToken: token });
        setCookie(res, COOKIE.session, result.sessionToken, SESSION_TTL_MS / 1000);
        send(res, 200, sessionBody(auth.session(result.sessionToken), result.sessionToken, guest));
      } else if (name === 'logout') {
        onlyKeys(await readJSON(req), []);
        await auth.logout(token); setCookie(res, COOKIE.session, '', 0); send(res, 200, { ok: true });
      } else if (name === 'profile') {
        const userId = requireUser(user);
        const result = req.method === 'PATCH' ? await updateProfile(store, userId, await readJSON(req)) : getProfile(store, userId);
        send(res, 200, { user: ownUser(result) });
      } else if (name === 'publicProfile') {
        send(res, 200, { profile: publicProfile(store, match[1]), reviews: listStudentReviews(store, match[1]),
          cases: listPublicCases(store, match[1]), progress: profileProgress(store, match[1]) });
      } else if (name === 'studentReviews') {
        send(res, 200, { reviews: listStudentReviews(store, match[1]) });
      } else if (name === 'ownOrders') {
        send(res, 200, { orders: listOwnOrders(store, requireUser(user, 'business')) });
      } else if (name === 'orders') {
        if (req.method === 'GET') send(res, 200, { orders: listOrders(store, query(url, ['category', 'query'])) });
        else send(res, 201, { order: await createOrder(store, requireUser(user, 'business'), await readJSON(req)) });
      } else if (name === 'order') {
        if (req.method === 'PUT') send(res, 200, { order: await updateOrder(store, requireUser(user, 'business'), match[1], await readJSON(req)) });
        else {
          const order = getOrder(store, match[1]);
          const files = [];
          if (user) for (const fileId of order.attachments) {
            try { files.push(getAttachment(store, user.id, fileId).metadata); }
            catch (error) { if (!(error instanceof ValidationError) || ![403, 404].includes(error.status)) throw error; }
          }
          send(res, 200, { order, files });
        }
      } else if (name === 'orderStatus') {
        send(res, 200, { order: await transitionOrder(store, requireUser(user, 'business'), match[1], await readJSON(req)) });
      } else if (name === 'orderApplications') {
        const userId = requireUser(user);
        if (req.method === 'GET') send(res, 200, { applications: listApplications(store, userId, match[1]).map(applicationView) });
        else send(res, 201, { application: await applyToOrder(store, userId, match[1], await readJSON(req)) });
      } else if (name === 'ownApplications') {
        const userId = requireUser(user, 'student');
        send(res, 200, { applications: store.read().applications.filter(application => application.studentId === userId)
          .map(application => ({ ...application, order: getOrder(store, application.orderId) })) });
      } else if (name === 'application') {
        send(res, 200, await decideApplication(store, requireUser(user, 'business'), match[1], await readJSON(req)));
      } else if (name === 'upload') {
        const userId = requireUser(user, 'business');
        const order = getOrder(store, match[1]);
        if (order.ownerId !== userId) throw new ValidationError('Изменять файлы может только владелец.', 403);
        if (order.status !== 'open') throw new ValidationError('Изменять файлы можно у открытой задачи.', 409);
        const versionHeader = req.headers['x-order-version'];
        if (typeof versionHeader !== 'string' || !/^[1-9]\d*$/.test(versionHeader) || !Number.isSafeInteger(Number(versionHeader))) throw new ValidationError('Укажите версию задачи.');
        const version = Number(versionHeader);
        if (order.version !== version) throw new ValidationError('Задача изменилась. Перечитайте её.', 409);
        let filename;
        try { filename = decodeURIComponent(req.headers['x-file-name'] ?? ''); } catch { throw new ValidationError('Некорректное имя файла.'); }
        const mimeType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
        if (!['application/pdf', 'text/plain'].includes(mimeType)) throw new ValidationError('Поддерживаются PDF и UTF-8 TXT.');
        send(res, 201, await createAttachment(store, userId, order.id, { name: filename, mimeType, version, bytes: await rawFile(req) }));
      } else if (name === 'file') {
        const userId = requireUser(user);
        if (req.method === 'DELETE') send(res, 200, await deleteAttachment(store, userId, match[1], await readJSON(req)));
        else {
          const { bytes, metadata } = getAttachment(store, userId, match[1]);
          const filename = encodeURIComponent(metadata.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
          send(res, 200, bytes, { 'Content-Type': metadata.mimeType,
            'Content-Disposition': `attachment; filename="download${metadata.mimeType === 'application/pdf' ? '.pdf' : '.txt'}"; filename*=UTF-8''${filename}` });
        }
      } else if (name === 'review') {
        send(res, 201, { review: await createReview(store, requireUser(user, 'business'), match[1], await readJSON(req)) });
      } else if (name === 'cases') {
        const userId = requireUser(user, 'student');
        if (req.method === 'GET') send(res, 200, { cases: listOwnCases(store, userId), progress: profileProgress(store, userId) });
        else send(res, 201, { case: await createCase(store, userId, await readJSON(req)) });
      } else if (name === 'case') {
        send(res, 200, { case: await updateCase(store, requireUser(user, 'student'), match[1], await readJSON(req)) });
      } else if (name === 'analysis') {
        requireUser(user, 'business'); limit(req, 'ai', user.id);
        send(res, 200, await analyzeTask(await readJSON(req), analysisOptions));
      } else if (name === 'fit') {
        const userId = requireUser(user, 'business'); limit(req, 'ai', userId);
        const { analyzeFit } = await import('./assist.mjs');
        send(res, 200, await analyzeFit(store, userId, await readJSON(req), assistOptions));
      } else if (name === 'caseFormat') {
        const userId = requireUser(user, 'student'); limit(req, 'ai', userId);
        const { formatCase } = await import('./assist.mjs');
        send(res, 200, await formatCase(store, userId, await readJSON(req), assistOptions));
      }
    } catch (error) {
      req.resume();
      if (!res.destroyed && !res.headersSent) {
        if (error instanceof ValidationError || error instanceof AuthError) {
          const status = error.status;
          const code = error.code ?? ({ 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED' })[status] ?? 'VALIDATION_ERROR';
          fail(res, status, code, error.message, status === 429 ? { 'Retry-After': '60' } : {}, req.method === 'HEAD');
        } else { onError(error); fail(res, 500, 'INTERNAL_ERROR', 'Не удалось обработать запрос.', {}, req.method === 'HEAD'); }
      }
    }
    return true;
  }
  return { handle, auth };
}
