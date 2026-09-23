import { randomUUID } from 'node:crypto';

export class ValidationError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export const id = (prefix) => `${prefix}_${randomUUID()}`;
export const now = () => new Date().toISOString();
export const INDUSTRIES = ['Образование', 'Ритейл', 'Логистика', 'Туризм', 'Услуги', 'Другое'];
export const FIELDS = [
  { key: 'title', label: 'Название задачи', max: 160, placeholder: 'Например, прогнозировать остатки в небольшой кофейне' },
  { key: 'context', label: 'Контекст', max: 4000, placeholder: 'Как устроен процесс сейчас? Что происходит?' },
  { key: 'need', label: 'Потребность', max: 4000, placeholder: 'Какую проблему нужно решить и почему это важно?' },
  { key: 'users', label: 'Пользователи', max: 2000, placeholder: 'Кто будет пользоваться решением?' },
  { key: 'data', label: 'Данные и материалы', max: 4000, placeholder: 'Какие данные, примеры или источники доступны команде?' },
  { key: 'constraints', label: 'Ограничения', max: 2000, placeholder: 'Сроки, технологии, доступы и другие границы проекта' },
  { key: 'result', label: 'Ожидаемый результат', max: 3000, placeholder: 'Что именно должна передать команда?' },
  { key: 'success', label: 'Критерии успеха', max: 2000, placeholder: 'Как измерить результат и принять работу?' },
  { key: 'contact', label: 'Контакт', max: 500, placeholder: 'Контакт ответственного или способ связи' },
  { key: 'format', label: 'Формат взаимодействия', max: 1000, placeholder: 'Как и когда бизнес готов консультировать команду?' },
  { key: 'feedback', label: 'Порядок обратной связи', max: 1000, placeholder: 'Кто проверяет результат и как быстро отвечает?' },
];
export const RUBRIC = [
  { label: 'Контекст и потребность', max: 20, parts: [['context', 10], ['need', 10]] },
  { label: 'Данные и материалы', max: 20, parts: [['data', 20]] },
  { label: 'Ожидаемый результат', max: 15, parts: [['result', 15]] },
  { label: 'Критерии успеха', max: 15, parts: [['success', 15]] },
  { label: 'Ограничения', max: 10, parts: [['constraints', 10]] },
  { label: 'Пользователи', max: 10, parts: [['users', 10]] },
  { label: 'Связь с бизнесом', max: 10, parts: [['contact', 3], ['format', 3], ['feedback', 4]] },
];
export function text(value, label, { required = false, max = 4000 } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new ValidationError(`${label}: ожидается текст.`);
  const result = value.trim();
  if (required && !result) throw new ValidationError(`Заполните поле «${label}».`);
  if (result.length > max) throw new ValidationError(`${label}: максимум ${max} символов.`);
  return result;
}
export function cleanFields(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Поля карточки должны быть объектом.');
  const allowed = new Set(FIELDS.map(f => f.key));
  if (Object.keys(input).some(key => !allowed.has(key))) throw new ValidationError('Неизвестное поле карточки.');
  if (Object.values(input).some(value => typeof value !== 'string')) throw new ValidationError('Значения полей карточки должны быть строками.');
  return Object.fromEntries(FIELDS.map(f => [f.key, text(input[f.key], f.label, { max: f.max })]));
}
export function readiness(score) {
  if (score >= 90) return { key: 'priority', label: 'Приоритетная', description: 'Полностью готова к работе' };
  if (score >= 70) return { key: 'ready', label: 'Готовая', description: 'Можно приступать к работе' };
  if (score >= 40) return { key: 'working', label: 'Рабочая', description: 'Основные условия понятны' };
  return { key: 'draft', label: 'Требует уточнения', description: 'Можно откликнуться и обсудить детали' };
}
export function rate(task) {
  const confirmed = new Set(task.confirmedFields ?? []);
  const breakdown = RUBRIC.map(group => ({
    ...group,
    earned: group.parts.reduce((sum, [key, weight]) => sum + (confirmed.has(key) && task.fields?.[key]?.trim() ? weight : 0), 0),
    missing: group.parts.filter(([key]) => !confirmed.has(key) || !task.fields?.[key]?.trim()).map(([key, weight]) => ({ key, weight, label: FIELDS.find(f => f.key === key).label })),
  }));
  const score = breakdown.reduce((sum, group) => sum + group.earned, 0);
  return { score, level: readiness(score), breakdown, missing: breakdown.flatMap(g => g.missing).sort((a, b) => b.weight - a.weight) };
}
export const enrich = (task) => ({ ...task, rating: rate(task) });
export function catalog(tasks, { industry = '', level = '', query = '' } = {}) {
  const q = query.trim().toLocaleLowerCase('ru');
  return tasks.filter(t => t.published === true).map(enrich)
    .filter(t => (!industry || t.industry === industry) && (!level || t.rating.level.key === level)
      && (!q || `${Object.values(t.fields).join(' ')} ${t.company} ${t.industry} ${(t.tags ?? []).join(' ')}`.toLocaleLowerCase('ru').includes(q)))
    .sort((a, b) => b.rating.score - a.rating.score || a.publishedAt.localeCompare(b.publishedAt));
}
export function recommendation(task, team) {
  if (rate(task).score < 40) return { points: 0, matches: [] };
  const corpus = `${task.industry} ${Object.values(task.fields).join(' ')} ${(task.tags ?? []).join(' ')}`.toLowerCase();
  const matches = [...new Set([...team.interests, ...team.skills, ...team.technologies])].filter(word => corpus.includes(word.toLowerCase()));
  return { points: matches.length, matches };
}
export function requireFound(items, itemId, label) {
  const item = items.find(x => x.id === itemId);
  if (!item) throw new ValidationError(`${label} не найдена.`, 404);
  return item;
}
export function requireBusiness(task, body) {
  if (body.role !== 'business' || body.businessId !== task.businessId) throw new ValidationError('Это действие доступно владельцу задачи.', 403);
}
export const STAGES = [
  { key: 'prototype', title: 'Прототип проверен', points: 50 },
  { key: 'result', title: 'Результат принят', points: 100 },
];
