import { ValidationError } from './domain.mjs';

export const MAX_JSON_BYTES = 64 * 1024;

export function readJSON(req) {
  if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    req.resume();
    throw new ValidationError('Требуется Content-Type: application/json.');
  }
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_JSON_BYTES) {
    req.resume();
    throw new ValidationError('Слишком большой запрос: максимум 64 КиБ.', 413);
  }
  return new Promise((resolve, reject) => {
    let chunks = [];
    let bytes = 0;
    let settled = false;
    function fail(error) {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(error);
    }
    req.on('data', chunk => {
      if (settled) return; // Drain the remaining body without retaining it.
      bytes += chunk.length;
      if (bytes > MAX_JSON_BYTES) return fail(new ValidationError('Слишком большой запрос: максимум 64 КиБ.', 413));
      chunks.push(chunk);
    });
    req.on('error', () => fail(new ValidationError('Не удалось прочитать тело запроса.')));
    req.on('aborted', () => fail(new ValidationError('Запрос прерван.')));
    req.on('end', () => {
      if (settled) return;
      try {
        const source = new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks));
        const value = JSON.parse(source);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Object required');
        settled = true;
        chunks = [];
        resolve(value);
      } catch { fail(new ValidationError('Тело запроса должно быть корректным JSON-объектом в UTF-8.')); }
    });
  });
}
