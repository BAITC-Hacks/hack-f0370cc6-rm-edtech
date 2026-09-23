import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createSeed } from './seed.mjs';

export async function createStore(file) {
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Не удалось прочитать базу ${file}: ${error.message}`);
    state = createSeed();
  }
  if (!state || state.schemaVersion !== 1 || !['tasks', 'teams', 'proposals', 'drafts', 'activity'].every(k => Array.isArray(state[k]))) throw new Error('Неподдерживаемый формат базы данных.');
  const persist = async (data) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2), 'utf8');
    await rename(`${file}.tmp`, file);
  };
  await persist(state);
  let queue = Promise.resolve();
  return {
    read: () => structuredClone(state),
    mutate(fn) {
      const operation = queue.then(async () => {
        const next = structuredClone(state);
        const result = await fn(next);
        // Do not expose a reference to the next committed state via the callback result.
        const output = structuredClone(result);
        await persist(next);
        state = next;
        return output;
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
