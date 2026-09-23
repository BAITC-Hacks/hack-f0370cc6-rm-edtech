import { createHash, randomBytes } from 'node:crypto';
import { createSeed } from '../seed.mjs';
import { id, now, ValidationError } from '../domain.mjs';
import { SESSION_TTL_MS } from './auth.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

function demoUser(userId, name, role, companyName = '') {
  const timestamp = now();
  return {
    id: userId, googleSubject: userId, email: '', emailVerified: false, name,
    contacts: '', photoUrl: '', activeRole: role, isDemo: true,
    student: { skills: [], portfolio: [] }, business: { companyName, industry: 'Услуги' },
    version: 1, createdAt: timestamp, updatedAt: timestamp,
  };
}

function fromTask(task, ownerId, orderId) {
  return {
    id: orderId, ownerId, title: task.fields.title, category: task.industry,
    description: task.raw, fields: task.fields, confirmedFields: task.confirmedFields,
    confirmedAt: task.confirmedAt, status: 'open', version: 1, attachments: [],
    createdAt: task.createdAt, publishedAt: task.publishedAt, updatedAt: task.updatedAt, isDemo: true,
    history: [{ from: null, to: 'open', actorId: ownerId, at: task.createdAt, evidence: '' }],
  };
}

export async function seedPlatformDemo(store) {
  return store.mutate(state => {
    for (const task of createSeed().tasks) {
      const ownerId = `demo_company_${task.id}`;
      if (!state.users.some(user => user.id === ownerId)) state.users.push(demoUser(ownerId, task.company, 'business', task.company));
      const orderId = `demo_order_${task.id}`;
      if (!state.orders.some(order => order.id === orderId)) state.orders.push(fromTask(task, ownerId, orderId));
    }
  });
}

export async function createDemoSession(store, { role, browserToken, previousToken } = {}) {
  if (!['student', 'business'].includes(role)) throw new ValidationError('Выберите режим студента или бизнеса.');
  if (!validToken(browserToken)) throw new ValidationError('Обновите страницу перед демонстрационным входом.', 403);
  const sessionToken = randomBytes(32).toString('base64url');
  const browserHash = hash(browserToken);
  return store.mutate(state => {
    let user = state.users.find(user => user.isDemo && user.demoBrowserHash === browserHash);
    if (!user) {
      user = { ...demoUser(id('demo_user'), 'Демо-участник', role, 'Мой демонстрационный бизнес'), demoBrowserHash: browserHash };
      state.users.push(user);
      const task = createSeed().tasks.find(task => task.id === 'task_service');
      const order = fromTask(task, user.id, id('demo_order'));
      order.publishedAt = now();
      state.orders.push(order);
      for (const name of ['Демо: Алия', 'Демо: Данияр']) {
        const student = demoUser(id('demo_student'), name, 'student');
        student.student.skills = ['Аналитика', 'JavaScript'];
        state.users.push(student);
        const createdAt = now();
        state.applications.push({
          id: id('demo_application'), orderId: order.id, studentId: student.id,
          message: 'Демонстрационный отклик: уточню каналы обращений, соберу доску заявок и проверю её на синтетических примерах.',
          status: 'pending', createdAt, updatedAt: createdAt, isDemo: true,
        });
      }
    } else if (user.activeRole !== role) {
      user.activeRole = role;
      user.version += 1;
      user.updatedAt = now();
    }
    const time = Date.now();
    const previousHash = validToken(previousToken) ? hash(previousToken) : '';
    state.sessions = state.sessions.filter(session => session.tokenHash !== previousHash && Date.parse(session.expiresAt) > time);
    state.sessions.push({ tokenHash: hash(sessionToken), userId: user.id, createdAt: new Date(time).toISOString(), expiresAt: new Date(time + SESSION_TTL_MS).toISOString() });
    return { sessionToken, userId: user.id };
  });
}
