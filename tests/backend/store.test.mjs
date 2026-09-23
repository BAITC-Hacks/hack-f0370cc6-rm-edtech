import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createStore } from '../../src/store.mjs';
import { temporaryDirectory } from './helpers.mjs';

test('first run persists seed; reopening keeps changes and isolated read/result copies', async t => {
  const file = join(await temporaryDirectory(t), 'db.json');
  const store = await createStore(file);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).tasks.length, 5);
  const returned = await store.mutate(state => { state.tasks[0].company='Saved business'; return state.tasks[0]; });
  returned.company = 'Escaped reference';
  const snapshot = store.read();
  snapshot.tasks[0].company = 'Another escaped reference';
  assert.equal(store.read().tasks[0].company, 'Saved business');
  assert.equal((await createStore(file)).read().tasks[0].company, 'Saved business');
});

test('queued writes do not lose changes and recover after a rejected mutation', async t => {
  const store = await createStore(join(await temporaryDirectory(t), 'db.json'));
  await Promise.all(Array.from({length:8}, (_,i) => store.mutate(async state => { state.activity.push(i); })));
  assert.deepEqual(store.read().activity, [0,1,2,3,4,5,6,7]);
  await assert.rejects(store.mutate(state => {state.activity.push('bad'); throw new Error('Rejected');}), /Rejected/);
  await store.mutate(state => state.activity.push('good'));
  assert.deepEqual(store.read().activity, [0,1,2,3,4,5,6,7,'good']);
});

test('failed disk write leaves committed memory and disk unchanged; later mutation succeeds', async t => {
  const dir = await temporaryDirectory(t);
  const file = join(dir, 'db.json');
  const store = await createStore(file);
  await mkdir(`${file}.tmp`);
  await assert.rejects(store.mutate(state => state.activity.push('lost')));
  assert.deepEqual(store.read().activity, []);
  assert.deepEqual(JSON.parse(await readFile(file,'utf8')).activity, []);
  await rename(`${file}.tmp`, join(dir,'blocking-directory'));
  await store.mutate(state => state.activity.push('saved'));
  assert.deepEqual(store.read().activity, ['saved']);
});

test('invalid JSON or schema is rejected instead of silently replacing user data', async t => {
  const file = join(await temporaryDirectory(t), 'db.json');
  for (const source of ['invalid', 'null', '{"schemaVersion":9}']) {
    await writeFile(file,source);
    await assert.rejects(createStore(file));
    assert.equal(await readFile(file,'utf8'), source);
  }
});
