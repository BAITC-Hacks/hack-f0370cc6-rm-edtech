import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './src/store.mjs';
import { catalog, INDUSTRIES, ValidationError, text } from './src/domain.mjs';
import { stateResponse } from './src/state.mjs';
import { readJSON } from './src/http-json.mjs';
import { confirmTask, createDraft, publishTask } from './src/tasks.mjs';
import { analyzeTask } from './src/ai/analyze.mjs';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json; charset=utf-8', head = false, extra = {}) {
  const bytes = Buffer.from(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(head ? undefined : bytes);
}

function fail(res, status, code, message, head = false, extra) {
  send(res, status, { error: { code, message, fields: {} } }, undefined, head, extra);
}

function filtersFrom(params) {
  const filters = {};
  for (const key of params.keys()) {
    if (!['industry', 'level', 'query'].includes(key) || params.getAll(key).length !== 1) {
      throw new ValidationError('Неизвестный или повторный параметр фильтра.');
    }
    filters[key] = text(params.get(key), key, { max: key === 'query' ? 4000 : 100 });
  }
  if (filters.industry && !INDUSTRIES.includes(filters.industry)) throw new ValidationError('Неизвестная отрасль.');
  if (filters.level && !['draft', 'working', 'ready', 'priority'].includes(filters.level)) throw new ValidationError('Неизвестный уровень готовности.');
  return filters;
}

function contained(root, path) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export async function createApplication({
  dataFile = process.env.DATA_FILE || resolve(projectRoot, 'data/state.json'),
  publicDir = resolve(projectRoot, 'public'),
  onError = error => console.error('Server error:', error.message),
  analysisOptions,
} = {}) {
  const store = await createStore(resolve(dataFile));
  const root = resolve(publicDir);
  const server = createServer(async (req, res) => {
    const head = req.method === 'HEAD';
    try {
      const url = new URL(req.url, 'http://localhost');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); }
      catch { throw new ValidationError('Некорректный адрес запроса.'); }
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (pathname === '/api/ai/analyze') {
          if (req.method !== 'POST') {
            req.resume();
            return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Для этого маршрута разрешён POST.', head, {Allow:'POST'});
          }
          return send(res, 200, await analyzeTask(await readJSON(req), analysisOptions));
        }
        if (pathname === '/api/tasks') {
          if (req.method !== 'POST') {
            req.resume();
            return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Для этого маршрута разрешён POST.', head, {Allow:'POST'});
          }
          const task = await createDraft(store, await readJSON(req));
          return send(res, 201, {task});
        }
        const publishMatch = /^\/api\/tasks\/([^/]+)\/publish$/.exec(pathname);
        if (publishMatch) {
          if (req.method !== 'POST') {
            req.resume();
            return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Для этого маршрута разрешён POST.', head, {Allow:'POST'});
          }
          const task = await publishTask(store, publishMatch[1], await readJSON(req));
          return send(res, 200, {task});
        }
        const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
        if (taskMatch) {
          if (req.method !== 'PUT') {
            req.resume();
            return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Для этого маршрута разрешён PUT.', head, {Allow:'PUT'});
          }
          const task = await confirmTask(store, taskMatch[1], await readJSON(req));
          return send(res, 200, {task});
        }
        if (!['/api/state', '/api/catalog'].includes(pathname)) {
          req.resume();
          return fail(res, 404, 'NOT_FOUND', 'API-маршрут не найден или ещё не реализован.', head);
        }
        if (req.method !== 'GET') {
          req.resume();
          return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Для этого маршрута разрешён GET.', head, { Allow: 'GET' });
        }
        if (pathname === '/api/catalog') {
          const filters = filtersFrom(url.searchParams);
          return send(res, 200, { tasks: catalog(store.read().tasks, filters) });
        }
        return send(res, 200, stateResponse(store.read()));
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        req.resume();
        return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Разрешены GET и HEAD.', head, { Allow: 'GET, HEAD' });
      }
      // Windows backslashes/ADS and dotfiles must never escape the public directory.
      if (/[\\:\0]/.test(pathname) || pathname.split('/').some(part => part.startsWith('.'))) {
        return fail(res, 403, 'FORBIDDEN', 'Этот файл недоступен.', head);
      }
      const requested = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!contained(root, requested)) return fail(res, 403, 'FORBIDDEN', 'Этот файл недоступен.', head);
      let file;
      try {
        const actualRoot = await realpath(root);
        file = await realpath(requested);
        if (!contained(actualRoot, file)) return fail(res, 403, 'FORBIDDEN', 'Этот файл недоступен.', head);
        if (!(await stat(file)).isFile()) return fail(res, 404, 'NOT_FOUND', 'Файл не найден.', head);
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        if (pathname === '/') return send(res, 200, 'Alem Tasks: API работает. Интерфейс public/index.html ещё не добавлен.', 'text/plain; charset=utf-8', head);
        return fail(res, 404, 'NOT_FOUND', 'Файл не найден.', head);
      }
      return send(res, 200, await readFile(file), types[extname(file)] || 'application/octet-stream', head);
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof ValidationError) {
        const code = ({403:'FORBIDDEN', 404:'NOT_FOUND', 409:'CONFLICT', 413:'PAYLOAD_TOO_LARGE'})[error.status] || 'VALIDATION_ERROR';
        return fail(res, error.status, code, error.message, head);
      }
      onError(error);
      return fail(res, 500, 'INTERNAL_ERROR', 'Не удалось обработать запрос.', head);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, store };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть целым числом от 1 до 65535.');
    const { server } = await createApplication();
    server.on('error', error => { console.error(`Не удалось запустить сервер: ${error.message}`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Alem Tasks: http://127.0.0.1:${port}/ (без ?preview=1)`));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
  } catch (error) {
    console.error(`Не удалось запустить сервер: ${error.message}`);
    process.exitCode = 1;
  }
}
