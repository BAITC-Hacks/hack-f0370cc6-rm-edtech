import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const collections = ['users', 'sessions', 'orders', 'applications', 'files', 'reviews'];

function validate(state) {
  if (!state || state.schemaVersion !== 2 || !collections.every(key => Array.isArray(state[key]))) {
    throw new Error('Неподдерживаемый формат базы личных аккаунтов.');
  }
  for (const key of collections) {
    if (state[key].some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('Повреждённая запись в базе личных аккаунтов.');
    }
  }
}

// Separate storage prevents legacy demo API from exposing account/session/file records.
// This is a single-process store; v1 demo data is neither imported nor overwritten.
export async function createPlatformStore(file) {
  const path = resolve(file);
  let state;
  try { state = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Не удалось прочитать базу личных аккаунтов.');
    state = {schemaVersion:2, ...Object.fromEntries(collections.map(key => [key, []]))};
  }
  validate(state);
  const persist = async next => {
    validate(next);
    await mkdir(dirname(path), {recursive:true});
    await writeFile(`${path}.tmp`, JSON.stringify(next), {encoding:'utf8', mode:0o600});
    await rename(`${path}.tmp`, path);
  };
  await persist(state);
  let queue = Promise.resolve();
  return {
    read: () => structuredClone(state),
    mutate(callback) {
      const operation = queue.then(async () => {
        const next = structuredClone(state);
        const result = structuredClone(await callback(next));
        await persist(next);
        state = next;
        return result;
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
