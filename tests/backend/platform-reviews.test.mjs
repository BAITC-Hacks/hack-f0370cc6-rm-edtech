import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPlatformStore } from '../../src/platform/store.mjs';
import { applyToOrder, createOrder, decideApplication, transitionOrder } from '../../src/platform/orders.mjs';
import { createReview, listStudentReviews } from '../../src/platform/reviews.mjs';
import { temporaryDirectory } from './helpers.mjs';

async function setup(t) {
  const file = join(await temporaryDirectory(t), 'platform.json');
  const store = await createPlatformStore(file);
  await store.mutate(state => {
    state.users.push(...['owner', 'other', 'student', 'student2'].map(id => ({
      id, activeRole: id.startsWith('student') ? 'student' : 'business', name: id,
      contacts: 'PRIVATE_CONTACT', passwordHash: 'PRIVATE_HASH', email: `${id}@private.example`,
      business: { companyName: 'Компания', industry: 'Услуги' }, student: { skills: [], portfolio: [] },
    })));
  });
  return { store, file };
}

const rejected = (promise, status) => assert.rejects(promise, error => error.status === status);
const orderInput = { title: 'Учёт заявок', category: 'Услуги', description: 'Нужна доска входящих обращений.' };
const reviewInput = { studentId: 'student', text: 'Самостоятельно собрал и проверил рабочий прототип.' };

async function prepare(store, { complete = true, both = false } = {}) {
  let order = await createOrder(store, 'owner', orderInput);
  const first = await applyToOrder(store, 'student', order.id, { message: 'Соберу и проверю прототип.' });
  const second = both ? await applyToOrder(store, 'student2', order.id, { message: 'Подготовлю данные и проверку.' }) : null;
  ({ order } = await decideApplication(store, 'owner', first.id, { status: 'accepted', version: order.version }));
  if (second) ({ order } = await decideApplication(store, 'owner', second.id, { status: 'accepted', version: order.version }));
  if (complete) order = await transitionOrder(store, 'owner', order.id, { status: 'completed', version: order.version, evidence: 'PRIVATE_EVIDENCE: принят прототип на обезличенных данных.' });
  return order;
}

async function snapshot(store, file) {
  return { state: store.read(), bytes: await readFile(file) };
}

async function unchanged(store, file, before) {
  assert.deepEqual(store.read(), before.state);
  assert.deepEqual(await readFile(file), before.bytes);
}

test('owner publishes a separate review for accepted solo work without copying private completion evidence', async t => {
  const { store } = await setup(t);
  const order = await prepare(store);
  const review = await createReview(store, 'owner', order.id, { ...reviewInput, text: ` ${reviewInput.text} ` });
  assert.match(review.id, /^review_[\da-f-]+$/);
  assert.equal(review.text, reviewInput.text);
  assert.equal(review.authorId, 'owner');
  assert.equal(review.studentId, 'student');
  assert.equal(review.orderTitle, order.title);
  assert.equal(review.completedAt, order.history.at(-1).at);
  assert.ok(Number.isFinite(Date.parse(review.createdAt)));
  assert.deepEqual(listStudentReviews(store, 'student'), [review]);
  assert.deepEqual(listStudentReviews(store, 'student2'), []);
  assert.ok(!JSON.stringify(review).includes('PRIVATE_'));
  assert.ok(!Object.hasOwn(review, 'result'));
  assert.ok(!Object.hasOwn(review, 'evidence'));
  assert.equal(store.read().orders[0].version, order.version);
});

test('review remains available after closing completed work but cancellation is never treated as completion', async t => {
  const { store, file } = await setup(t);
  const completed = await prepare(store);
  const archived = await transitionOrder(store, 'owner', completed.id, { status: 'closed', version: completed.version });
  assert.equal((await createReview(store, 'owner', archived.id, reviewInput)).orderId, archived.id);
  const inProgress = await prepare(store, { complete: false });
  let before = await snapshot(store, file);
  await rejected(createReview(store, 'owner', inProgress.id, reviewInput), 409);
  await unchanged(store, file, before);
  const cancelled = await transitionOrder(store, 'owner', inProgress.id, { status: 'closed', version: inProgress.version, evidence: 'Бизнес остановил проект.' });
  before = await snapshot(store, file);
  await rejected(createReview(store, 'owner', cancelled.id, reviewInput), 409);
  await unchanged(store, file, before);
});

test('review author must be the authenticated business owner and recipient must be an accepted performer', async t => {
  const { store, file } = await setup(t);
  const order = await prepare(store);
  const before = await snapshot(store, file);
  for (const [authorId, orderId, body, status] of [
    ['missing', order.id, reviewInput, 401],
    ['student2', order.id, reviewInput, 403],
    ['other', order.id, reviewInput, 403],
    ['owner', 'missing-order', reviewInput, 404],
    ['owner', order.id, { ...reviewInput, studentId: 'owner' }, 403],
    ['owner', order.id, { ...reviewInput, studentId: 'student2' }, 403],
    ['owner', order.id, { ...reviewInput, studentId: 'missing' }, 404],
  ]) {
    await rejected(createReview(store, authorId, orderId, body), status);
    await unchanged(store, file, before);
  }
  assert.throws(() => listStudentReviews(store, 'missing'), error => error.status === 404);
});

test('review text and recipient validation reject invalid values and forged fields without writing', async t => {
  const { store, file } = await setup(t);
  const order = await prepare(store);
  const before = await snapshot(store, file);
  for (const patch of [
    { text: '' }, { text: '  ' }, { text: false }, { text: null }, { text: 'x'.repeat(2001) },
    { studentId: '' }, { studentId: false }, { studentId: 'x'.repeat(161) },
    { role: 'business' }, { authorId: 'owner' }, { completedAt: order.updatedAt }, { orderTitle: 'Подмена' }, { stars: 5 }, { evidence: 'secret' },
  ]) {
    await rejected(createReview(store, 'owner', order.id, { ...reviewInput, ...patch }), 400);
    await unchanged(store, file, before);
  }
  for (const body of [null, [], 'text']) await rejected(createReview(store, 'owner', order.id, body), 400);
  const max = await createReview(store, 'owner', order.id, { ...reviewInput, text: ` ${'я'.repeat(2000)} ` });
  assert.equal(max.text.length, 2000);
});

test('concurrent duplicate reviews create exactly one immutable record and survive reopening', async t => {
  const { store, file } = await setup(t);
  const order = await prepare(store);
  const attempts = await Promise.allSettled([
    createReview(store, 'owner', order.id, reviewInput),
    createReview(store, 'owner', order.id, { ...reviewInput, text: 'Повторная попытка.' }),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 409);
  const saved = attempts.find(result => result.status === 'fulfilled').value;
  const reopened = await createPlatformStore(file);
  assert.deepEqual(listStudentReviews(reopened, 'student'), [saved]);
  const before = await snapshot(reopened, file);
  await rejected(createReview(reopened, 'owner', order.id, reviewInput), 409);
  await unchanged(reopened, file, before);
});

test('public review projection ignores private fields and snapshots are unaffected by later order changes', async t => {
  const { store } = await setup(t);
  const order = await prepare(store);
  const review = await createReview(store, 'owner', order.id, reviewInput);
  await store.mutate(state => {
    state.orders[0].title = 'Позднее название';
    Object.assign(state.reviews[0], { evidence: 'PRIVATE_EVIDENCE', internalNote: 'PRIVATE_NOTE', author: state.users[0] });
  });
  const listed = listStudentReviews(store, 'student');
  assert.deepEqual(listed, [review]);
  assert.equal(listed[0].orderTitle, order.title);
  assert.ok(!JSON.stringify(listed).includes('PRIVATE_'));
  listed[0].text = 'Изменение ответа';
  assert.equal(listStudentReviews(store, 'student')[0].text, reviewInput.text);
});

test('queued changes to the author role are checked before committing the review', async t => {
  const { store } = await setup(t);
  const order = await prepare(store);
  const change = store.mutate(state => { state.users.find(user => user.id === 'owner').activeRole = 'student'; });
  const review = createReview(store, 'owner', order.id, reviewInput);
  await change;
  await rejected(review, 403);
  assert.deepEqual(store.read().reviews, []);
});

test('each accepted participant can receive one review, even if the recipient currently uses business mode', async t => {
  const { store } = await setup(t);
  const order = await prepare(store, { both: true });
  await store.mutate(state => { state.users.find(user => user.id === 'student2').activeRole = 'business'; });
  await createReview(store, 'owner', order.id, reviewInput);
  const second = await createReview(store, 'owner', order.id, { studentId: 'student2', text: 'Подготовил данные и проверку прототипа.' });
  assert.equal(listStudentReviews(store, 'student').length, 1);
  assert.deepEqual(listStudentReviews(store, 'student2'), [second]);
  assert.equal(store.read().reviews.length, 2);
});
