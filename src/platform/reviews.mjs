import { id, now, requireFound, text, ValidationError } from '../domain.mjs';

function publicReview(review) {
  return {
    id: review.id, orderId: review.orderId, authorId: review.authorId, studentId: review.studentId,
    text: review.text, createdAt: review.createdAt, completedAt: review.completedAt, orderTitle: review.orderTitle,
  };
}

export async function createReview(store, ownerId, orderId, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['studentId', 'text'].includes(key))) {
    throw new ValidationError('Проверьте поля отзыва.');
  }
  const studentId = text(body.studentId, 'Исполнитель', { required: true, max: 160 });
  const reviewText = text(body.text, 'Отзыв', { required: true, max: 2000 });
  return store.mutate(state => {
    const author = state.users.find(user => user.id === ownerId);
    if (!author) throw new ValidationError('Войдите в аккаунт.', 401);
    if (author.activeRole !== 'business') throw new ValidationError('Переключитесь в режим бизнеса.', 403);
    const order = requireFound(state.orders, orderId, 'Задача');
    if (order.ownerId !== ownerId) throw new ValidationError('Отзыв доступен владельцу задачи.', 403);
    if (studentId === ownerId) throw new ValidationError('Нельзя оставить отзыв самому себе.', 403);
    requireFound(state.users, studentId, 'Профиль');
    const completion = order.history?.find(event => event.from === 'in_progress' && event.to === 'completed' &&
      event.actorId === ownerId && typeof event.evidence === 'string' && event.evidence.trim() && Number.isFinite(Date.parse(event.at)));
    if (!['completed', 'closed'].includes(order.status) || !completion) {
      throw new ValidationError('Отзыв доступен после подтверждения выполненной работы.', 409);
    }
    if (!state.applications.some(application => application.orderId === orderId && application.studentId === studentId && application.status === 'accepted')) {
      throw new ValidationError('Отзыв можно оставить только выбранному исполнителю задачи.', 403);
    }
    if (state.reviews.some(review => review.orderId === orderId && review.studentId === studentId)) {
      throw new ValidationError('Отзыв этому исполнителю по задаче уже сохранён.', 409);
    }
    // Acceptance evidence is private. Only the separately authored review is published.
    const review = {
      id: id('review'), orderId, authorId: ownerId, studentId, text: reviewText,
      createdAt: now(), completedAt: completion.at, orderTitle: order.title,
    };
    state.reviews.push(review);
    return publicReview(review);
  });
}

export function listStudentReviews(store, studentId) {
  const state = store.read();
  requireFound(state.users, studentId, 'Профиль');
  return state.reviews.filter(review => review.studentId === studentId).map(publicReview)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}
