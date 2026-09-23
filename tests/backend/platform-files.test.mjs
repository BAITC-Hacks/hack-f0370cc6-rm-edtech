import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPlatformStore } from '../../src/platform/store.mjs';
import { createStore } from '../../src/store.mjs';
import { stateResponse } from '../../src/state.mjs';
import {
  ATTACHMENT_LIMITS, attachmentMetadata, createAttachment, getAttachment, deleteAttachment,
} from '../../src/platform/files.mjs';
import { temporaryDirectory } from './helpers.mjs';

async function setup(t) {
  const directory = await temporaryDirectory(t);
  const path = join(directory, 'private-platform.json');
  const store = await createPlatformStore(path);
  await store.mutate(state => {
    state.users.push(
      { id: 'owner', activeRole: 'business' }, { id: 'other-owner', activeRole: 'business' },
      { id: 'student', activeRole: 'student' }, { id: 'other-student', activeRole: 'student' },
    );
    for (const [id, ownerId] of [['order', 'owner'], ['second-order', 'owner'], ['other-order', 'other-owner']]) {
      state.orders.push({ id, ownerId, status: 'open', version: 1, attachments: [], updatedAt: '2026-01-01T00:00:00.000Z' });
    }
  });
  return { store, path, directory };
}

const textInput = (version = 1, overrides = {}) => ({
  name: 'Условия.txt', mimeType: 'text/plain', bytes: Buffer.from('Пример задания без персональных данных.'),
  version, ...overrides,
});
const pdfInput = (version = 1, overrides = {}) => ({
  name: 'Условия.pdf', mimeType: 'application/pdf', bytes: Buffer.from('%PDF-1.7\nsynthetic fixture\n%%EOF'),
  version, ...overrides,
});
const order = (store, id = 'order') => store.read().orders.find(item => item.id === id);
const fails = (operation, status) => assert.rejects(async () => operation(), error => error.status === status);
async function snapshot(store, path) { return { state: store.read(), disk: await readFile(path) }; }
async function unchanged(store, path, before) {
  assert.deepEqual(store.read(), before.state);
  assert.deepEqual(await readFile(path), before.disk);
}

test('file service stores PDF/TXT privately, returns only metadata and increments the order version', async t => {
  const { store } = await setup(t);
  const createdPdf = await createAttachment(store, 'owner', 'order', pdfInput());
  assert.deepEqual(Object.keys(createdPdf).sort(), ['file', 'orderVersion']);
  const pdf = createdPdf.file;
  assert.equal(createdPdf.orderVersion, 2);
  assert.deepEqual(Object.keys(pdf).sort(), ['createdAt', 'id', 'mimeType', 'name', 'orderId', 'ownerId', 'size']);
  assert.equal(pdf.orderId, 'order');
  assert.equal(pdf.ownerId, 'owner');
  assert.equal(pdf.size, pdfInput().bytes.length);
  assert.deepEqual(order(store).attachments, [pdf.id]);
  assert.equal(order(store).version, 2);
  assert.equal(order(store).updatedAt, pdf.createdAt);
  assert.ok(Number.isFinite(Date.parse(pdf.createdAt)));

  const createdTxt = await createAttachment(store, 'owner', 'order', textInput(createdPdf.orderVersion, { name: 'План.TXT' }));
  const txt = createdTxt.file;
  assert.equal(createdTxt.orderVersion, 3);
  assert.equal(createdPdf.orderVersion, 2, 'The earlier response keeps its own committed version.');
  assert.equal(order(store).version, 3);
  const downloaded = getAttachment(store, 'owner', txt.id);
  assert.ok(Buffer.isBuffer(downloaded.bytes));
  assert.deepEqual(downloaded.bytes, textInput().bytes);
  assert.deepEqual(downloaded.metadata, txt);
  const privateFile = store.read().files.find(file => file.id === txt.id);
  assert.equal(privateFile.contentBase64, textInput().bytes.toString('base64'));
  assert.deepEqual(attachmentMetadata({ ...privateFile, internalSecret: 'never project this' }), txt);
  assert.ok(!JSON.stringify([createdPdf, createdTxt, downloaded.metadata]).includes('contentBase64'));
});

test('file service rejects unsafe names, mismatched types and invalid UTF-8 without any write', async t => {
  const { store, path } = await setup(t);
  const before = await snapshot(store, path);
  const patches = [
    { name: '' }, { name: '  ' }, { name: 'x'.repeat(157) + '.txt' }, { name: '../plan.txt' },
    { name: '..\\plan.txt' }, { name: 'C:plan.txt' }, { name: 'plan\n.txt' }, { name: 'plan\0.txt' },
    { name: '\u202eplan.txt' }, { name: '.txt' }, { name: 'plan.pdf' },
    { mimeType: 'text/html' }, { mimeType: 'application/msword' }, { mimeType: undefined },
    { name: 'plan.pdf', mimeType: 'application/pdf', bytes: Buffer.from('Not a PDF') },
    { bytes: Buffer.from([0x61, 0, 0x62]) }, { bytes: Buffer.from([0xc3, 0x28]) },
    { bytes: Buffer.alloc(0) }, { bytes: 'text' }, { bytes: new Uint8Array([65]) },
    { ownerId: 'other-owner' }, { contentBase64: 'injected' },
  ];
  for (const patch of patches) {
    await fails(() => createAttachment(store, 'owner', 'order', textInput(1, patch)), 400);
    await unchanged(store, path, before);
  }
});

test('a five MiB file is accepted but one extra byte is rejected before persistence', async t => {
  const { store, path } = await setup(t);
  const bytes = Buffer.alloc(ATTACHMENT_LIMITS.fileBytes, 0x61);
  const { file, orderVersion } = await createAttachment(store, 'owner', 'order', textInput(1, { bytes }));
  assert.equal(file.size, 5 * 1024 * 1024);
  assert.equal(orderVersion, order(store).version);
  const before = await snapshot(store, path);
  await fails(() => createAttachment(store, 'owner', 'order', textInput(2, {
    bytes: Buffer.alloc(ATTACHMENT_LIMITS.fileBytes + 1, 0x61),
  })), 413);
  await unchanged(store, path, before);
});

test('only an existing owner in business mode can attach files to an open order', async t => {
  const { store, path } = await setup(t);
  const before = await snapshot(store, path);
  for (const [userId, orderId, status] of [
    ['missing', 'order', 401], ['other-owner', 'order', 403], ['student', 'order', 403], ['owner', 'missing', 404],
  ]) {
    await fails(() => createAttachment(store, userId, orderId, textInput()), status);
    await unchanged(store, path, before);
  }
  await store.mutate(state => { state.users.find(user => user.id === 'owner').activeRole = 'student'; });
  await fails(() => createAttachment(store, 'owner', 'order', textInput()), 403);
  await store.mutate(state => { state.users.find(user => user.id === 'owner').activeRole = 'business'; });
  for (const status of ['in_progress', 'completed', 'closed']) {
    await store.mutate(state => { state.orders.find(item => item.id === 'order').status = status; });
    const current = await snapshot(store, path);
    await fails(() => createAttachment(store, 'owner', 'order', textInput()), 409);
    await unchanged(store, path, current);
  }
});

test('version validation and queued same-version uploads prevent lost updates', async t => {
  const { store, path } = await setup(t);
  const before = await snapshot(store, path);
  for (const version of [undefined, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await fails(() => createAttachment(store, 'owner', 'order', textInput(version, { version })), 400);
  }
  await fails(() => createAttachment(store, 'owner', 'order', textInput(2)), 409);
  await unchanged(store, path, before);
  const results = await Promise.allSettled([
    createAttachment(store, 'owner', 'order', textInput()),
    createAttachment(store, 'owner', 'order', pdfInput()),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const winner = results.find(result => result.status === 'fulfilled').value;
  assert.equal(winner.orderVersion, 2);
  assert.equal(store.read().files.length, 1);
  assert.equal(order(store).attachments.length, 1);
  assert.equal(order(store).version, 2);
  assert.deepEqual(order(store).attachments, [winner.file.id]);

  // Simulate a later committed edit while delivery of the upload response is
  // delayed. Its version must come from the upload transaction, never read().
  const delayedStore = {
    read: () => store.read(),
    async mutate(callback) {
      const result = await store.mutate(callback);
      await store.mutate(state => { state.orders.find(item => item.id === 'order').version += 1; });
      return result;
    },
  };
  const delayed = await createAttachment(delayedStore, 'owner', 'order', textInput(2));
  assert.equal(delayed.orderVersion, 3);
  assert.equal(order(store).version, 4);
});

test('three-files limit and twenty MiB account quota count all orders and release space after deletion', async t => {
  const { store, path } = await setup(t);
  const bytes = Buffer.alloc(ATTACHMENT_LIMITS.fileBytes, 0x61);
  const { file: first } = await createAttachment(store, 'owner', 'order', textInput(1, { bytes }));
  await createAttachment(store, 'owner', 'order', textInput(2, { bytes }));
  await createAttachment(store, 'owner', 'order', textInput(3, { bytes }));
  await fails(() => createAttachment(store, 'owner', 'order', textInput(4)), 409);
  await createAttachment(store, 'owner', 'second-order', textInput(1, { bytes }));
  const before = await snapshot(store, path);
  await fails(() => createAttachment(store, 'owner', 'second-order', textInput(2, { bytes: Buffer.from('x') })), 413);
  await unchanged(store, path, before);
  await createAttachment(store, 'other-owner', 'other-order', textInput());
  await deleteAttachment(store, 'owner', first.id, { version: 4 });
  await createAttachment(store, 'owner', 'second-order', textInput(2, { bytes }));
  assert.equal(store.read().files.filter(file => file.ownerId === 'owner').reduce((sum, file) => sum + file.size, 0), ATTACHMENT_LIMITS.accountBytes);
});

test('download access follows order status and accepted identity rather than a claimed role', async t => {
  const { store } = await setup(t);
  const { file } = await createAttachment(store, 'owner', 'order', textInput());
  assert.deepEqual(getAttachment(store, 'student', file.id).bytes, textInput().bytes);
  await fails(() => getAttachment(store, 'other-owner', file.id), 403);
  await fails(() => getAttachment(store, 'missing', file.id), 401);
  await fails(() => getAttachment(store, 'owner', 'missing'), 404);
  await store.mutate(state => {
    state.users.find(user => user.id === 'owner').activeRole = 'student';
    state.applications.push({ id: 'application', orderId: 'order', studentId: 'student', status: 'accepted' });
  });
  for (const status of ['in_progress', 'completed', 'closed']) {
    await store.mutate(state => { state.orders.find(item => item.id === 'order').status = status; });
    assert.deepEqual(getAttachment(store, 'owner', file.id).metadata, file);
    assert.deepEqual(getAttachment(store, 'student', file.id).metadata, file);
    await fails(() => getAttachment(store, 'other-student', file.id), 403);
  }
  await store.mutate(state => { state.users.find(user => user.id === 'student').activeRole = 'business'; });
  assert.deepEqual(getAttachment(store, 'student', file.id).metadata, file);
  await store.mutate(state => { state.applications[0].status = 'rejected'; });
  await fails(() => getAttachment(store, 'student', file.id), 403);
});

test('delete checks ownership, status and version and removes metadata, content and order reference atomically', async t => {
  const { store, path } = await setup(t);
  const { file } = await createAttachment(store, 'owner', 'order', textInput());
  const before = await snapshot(store, path);
  for (const [userId, input, status] of [
    ['missing', { version: 2 }, 401], ['other-owner', { version: 2 }, 403],
    ['student', { version: 2 }, 403], ['owner', { version: 1 }, 409],
    ['owner', { version: '2' }, 400], ['owner', { version: 2, ownerId: 'owner' }, 400],
  ]) {
    await fails(() => deleteAttachment(store, userId, file.id, input), status);
    await unchanged(store, path, before);
  }
  await store.mutate(state => { state.orders.find(item => item.id === 'order').status = 'in_progress'; });
  const locked = await snapshot(store, path);
  await fails(() => deleteAttachment(store, 'owner', file.id, { version: 2 }), 409);
  await unchanged(store, path, locked);
  await store.mutate(state => { state.orders.find(item => item.id === 'order').status = 'open'; });
  const result = await deleteAttachment(store, 'owner', file.id, { version: 2 });
  assert.deepEqual(result, { deletedId: file.id, orderVersion: 3 });
  assert.deepEqual(order(store).attachments, []);
  assert.deepEqual(store.read().files, []);
  assert.ok(!(await readFile(path, 'utf8')).includes(textInput().bytes.toString('base64')));
  await fails(() => getAttachment(store, 'owner', file.id), 404);
  await fails(() => deleteAttachment(store, 'owner', file.id, { version: 3 }), 404);
});

test('private attachments persist after reopening and are absent from the separate v1 demo projection', async t => {
  const { store, path, directory } = await setup(t);
  const { file, orderVersion } = await createAttachment(store, 'owner', 'order', pdfInput());
  const reopened = await createPlatformStore(path);
  assert.deepEqual(getAttachment(reopened, 'student', file.id), { metadata: file, bytes: pdfInput().bytes });
  assert.equal(order(reopened).version, orderVersion);
  const demo = await createStore(join(directory, 'demo.json'));
  const publicDemo = JSON.stringify(stateResponse(demo.read()));
  assert.ok(!publicDemo.includes(file.id));
  assert.ok(!publicDemo.includes('contentBase64'));
  assert.ok(!publicDemo.includes(pdfInput().bytes.toString('base64')));
});

test('upload snapshots bytes before queueing and returned buffers do not mutate private storage', async t => {
  const { store } = await setup(t);
  const bytes = Buffer.from('Original text');
  const pending = createAttachment(store, 'owner', 'order', textInput(1, { bytes }));
  bytes.fill(0);
  const { file, orderVersion } = await pending;
  assert.equal(orderVersion, 2);
  const downloaded = getAttachment(store, 'owner', file.id);
  assert.equal(downloaded.bytes.toString(), 'Original text');
  downloaded.bytes.fill(0);
  downloaded.metadata.name = 'changed.txt';
  assert.equal(getAttachment(store, 'owner', file.id).bytes.toString(), 'Original text');
  assert.equal(getAttachment(store, 'owner', file.id).metadata.name, 'Условия.txt');
});
