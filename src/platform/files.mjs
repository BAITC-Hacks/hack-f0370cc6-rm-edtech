import { id, now, ValidationError } from '../domain.mjs';

export const ATTACHMENT_LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024,
  filesPerOrder: 3,
  accountBytes: 20 * 1024 * 1024,
});

const MIME_EXTENSIONS = new Map([['application/pdf', '.pdf'], ['text/plain', '.txt']]);

// Only PDF/TXT are supported in this first service. A matching signature is format
// validation, not malware scanning; callers must never render uploaded files as HTML.
function validateUpload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Ожидаются файл и версия задачи.');
  }
  const allowed = new Set(['name', 'mimeType', 'bytes', 'version']);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new ValidationError('Неизвестное поле загрузки.');
  requireVersion(input.version);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160 ||
      /[\\/\x00-\x1f\x7f-\x9f:\u202a-\u202e\u2066-\u2069]/u.test(input.name)) {
    throw new ValidationError('Имя файла: до 160 символов, без пути и управляющих символов.');
  }
  const name = input.name.trim();
  const extension = MIME_EXTENSIONS.get(input.mimeType);
  if (!extension || !name.toLowerCase().endsWith(extension) || name.length <= extension.length) {
    throw new ValidationError('Разрешены только PDF (.pdf, application/pdf) и UTF-8 текст (.txt, text/plain).');
  }
  if (!Buffer.isBuffer(input.bytes)) throw new ValidationError('Содержимое файла должно быть Buffer.');
  if (!input.bytes.length) throw new ValidationError('Нельзя загрузить пустой файл.');
  if (input.bytes.length > ATTACHMENT_LIMITS.fileBytes) {
    throw new ValidationError('Размер файла не должен превышать 5 МиБ.', 413);
  }
  if (input.mimeType === 'application/pdf' && !input.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new ValidationError('Содержимое файла не имеет сигнатуры PDF.');
  }
  if (input.mimeType === 'text/plain') {
    if (input.bytes.includes(0)) throw new ValidationError('Текстовый файл содержит недопустимый NUL.');
    try { new TextDecoder('utf-8', { fatal: true }).decode(input.bytes); }
    catch { throw new ValidationError('Текстовый файл должен быть в кодировке UTF-8.'); }
  }
  // Capture bytes before entering the asynchronous queue so the caller cannot
  // change the buffer after validation but before persistence.
  return { name, mimeType: input.mimeType, size: input.bytes.length, contentBase64: input.bytes.toString('base64') };
}

function requireVersion(version) {
  if (!Number.isSafeInteger(version) || version < 1) throw new ValidationError('Укажите корректную версию задачи.');
}

function knownUser(state, userId) {
  const user = state.users.find(user => user.id === userId);
  if (!user) throw new ValidationError('Войдите в аккаунт.', 401);
  return user;
}

function foundOrder(state, orderId) {
  const order = state.orders.find(order => order.id === orderId);
  if (!order) throw new ValidationError('Задача не найдена.', 404);
  return order;
}

function foundAttachment(state, fileId) {
  const file = state.files.find(file => file.id === fileId);
  if (!file) throw new ValidationError('Файл не найден.', 404);
  const order = foundOrder(state, file.orderId);
  if (!(order.attachments ?? []).includes(file.id)) throw new ValidationError('Файл не найден.', 404);
  return { file, order };
}

function requireEditableOrder(user, order, version) {
  if (user.id !== order.ownerId || user.activeRole !== 'business') {
    throw new ValidationError('Файлы задачи изменяет её владелец в режиме бизнеса.', 403);
  }
  if (order.status !== 'open') throw new ValidationError('Файлы можно изменять только у открытой задачи.', 409);
  if (order.version !== version) throw new ValidationError('Задача изменилась. Обновите её перед загрузкой или удалением файла.', 409);
}

// Explicit allowlist: private content must not leak through object spreading.
export function attachmentMetadata(file) {
  return {
    id: file.id, orderId: file.orderId, ownerId: file.ownerId,
    name: file.name, mimeType: file.mimeType, size: file.size, createdAt: file.createdAt,
  };
}

export async function createAttachment(store, userId, orderId, input) {
  const upload = validateUpload(input);
  const version = input.version;
  return store.mutate(state => {
    const user = knownUser(state, userId);
    const order = foundOrder(state, orderId);
    requireEditableOrder(user, order, version);
    if (state.files.filter(file => file.orderId === order.id).length >= ATTACHMENT_LIMITS.filesPerOrder) {
      throw new ValidationError('К задаче можно прикрепить не более трёх файлов.', 409);
    }
    const usedBytes = state.files.filter(file => file.ownerId === user.id).reduce((total, file) => total + file.size, 0);
    if (usedBytes + upload.size > ATTACHMENT_LIMITS.accountBytes) {
      throw new ValidationError('Общий объём файлов аккаунта не должен превышать 20 МиБ.', 413);
    }
    const file = { id: id('file'), orderId: order.id, ownerId: user.id, ...upload, createdAt: now() };
    state.files.push(file);
    order.attachments = [...(order.attachments ?? []), file.id];
    order.version += 1;
    order.updatedAt = file.createdAt;
    return { file: attachmentMetadata(file), orderVersion: order.version };
  });
}

export function getAttachment(store, userId, fileId) {
  const state = store.read();
  const user = knownUser(state, userId);
  const { file, order } = foundAttachment(state, fileId);
  const owner = order.ownerId === user.id;
  const openStudent = order.status === 'open' && user.activeRole === 'student';
  const acceptedStudent = ['in_progress', 'completed', 'closed'].includes(order.status) &&
    state.applications.some(application => application.orderId === order.id &&
      application.studentId === user.id && application.status === 'accepted');
  if (!owner && !openStudent && !acceptedStudent) {
    throw new ValidationError('Этот файл доступен владельцу задачи и допущенным исполнителям.', 403);
  }
  return { metadata: attachmentMetadata(file), bytes: Buffer.from(file.contentBase64, 'base64') };
}

export async function deleteAttachment(store, userId, fileId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => key !== 'version')) throw new ValidationError('Ожидается версия задачи.');
  requireVersion(input.version);
  const version = input.version;
  return store.mutate(state => {
    const user = knownUser(state, userId);
    const { file, order } = foundAttachment(state, fileId);
    requireEditableOrder(user, order, version);
    state.files = state.files.filter(item => item.id !== file.id);
    order.attachments = order.attachments.filter(id => id !== file.id);
    order.version += 1;
    order.updatedAt = now();
    return { deletedId: file.id, orderVersion: order.version };
  });
}
