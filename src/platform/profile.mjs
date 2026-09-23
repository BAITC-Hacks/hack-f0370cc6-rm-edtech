import { INDUSTRIES, ValidationError, text, now } from '../domain.mjs';

function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new ValidationError('Проверьте поля профиля.');
  }
}

function string(value, label, options) {
  if (typeof value !== 'string') throw new ValidationError(`${label}: ожидается текст.`);
  return text(value, label, options);
}

function link(value, {required=false} = {}) {
  const result = string(value, 'Ссылка', {required, max:2048});
  if (!result) return '';
  let parsed;
  try { parsed = new URL(result); } catch { throw new ValidationError('Укажите полную HTTP(S) ссылку.'); }
  if (!/^https?:\/\//i.test(result) || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname ||
      parsed.username || parsed.password || /[\s\u0000-\u001f\u007f\\]/.test(result)) {
    throw new ValidationError('Укажите HTTP(S) ссылку без логина и пароля.');
  }
  return result;
}

function findUser(state, userId) {
  const user = state.users.find(item => item.id === userId);
  if (!user) throw new ValidationError('Войдите в аккаунт.', 401);
  return user;
}

export function ownProfile(user) {
  return structuredClone({
    id:user.id, email:user.email, emailVerified:user.emailVerified,
    name:user.name, contacts:user.contacts, photoUrl:user.photoUrl, activeRole:user.activeRole,
    student:user.student, business:user.business, version:user.version,
    createdAt:user.createdAt, updatedAt:user.updatedAt,
  });
}

export function getProfile(store, userId) {
  return ownProfile(findUser(store.read(), userId));
}

export function publicProfile(store, userId) {
  const user = store.read().users.find(item => item.id === userId);
  if (!user) throw new ValidationError('Профиль не найден.', 404);
  return structuredClone({id:user.id, name:user.name, photoUrl:user.photoUrl,
    student:user.student, business:user.business});
}

export async function updateProfile(store, userId, input) {
  object(input, ['version','name','contacts','photoUrl','activeRole','student','business']);
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new ValidationError('Укажите текущую версию профиля.');
  const patch = {};
  if ('name' in input) patch.name = string(input.name, 'Имя', {required:true,max:160});
  if ('contacts' in input) patch.contacts = string(input.contacts, 'Контакты', {max:500});
  if ('photoUrl' in input) patch.photoUrl = link(input.photoUrl);
  if ('activeRole' in input) {
    if (!['student','business'].includes(input.activeRole)) throw new ValidationError('Выберите роль студента или бизнеса.');
    patch.activeRole = input.activeRole;
  }
  if ('student' in input) {
    object(input.student, ['skills','portfolio']);
    patch.student = {};
    if ('skills' in input.student) {
      if (!Array.isArray(input.student.skills) || input.student.skills.length > 30) throw new ValidationError('Укажите не более 30 навыков.');
      patch.student.skills = [...new Set(input.student.skills.map(value => string(value,'Навык',{required:true,max:80})))];
    }
    if ('portfolio' in input.student) {
      if (!Array.isArray(input.student.portfolio) || input.student.portfolio.length > 20) throw new ValidationError('Добавьте не более 20 работ.');
      patch.student.portfolio = input.student.portfolio.map(item => {
        object(item, ['title','url','description']);
        return {title:string(item.title,'Название работы',{required:true,max:160}),
          url:link(item.url,{required:true}), description:string(item.description ?? '','Описание работы',{max:2000})};
      });
    }
  }
  if ('business' in input) {
    object(input.business,['companyName','industry']);
    patch.business = {};
    if ('companyName' in input.business) patch.business.companyName = string(input.business.companyName,'Компания',{max:160});
    if ('industry' in input.business) {
      if (input.business.industry !== '' && !INDUSTRIES.includes(input.business.industry)) throw new ValidationError('Выберите сферу деятельности из списка.');
      patch.business.industry = input.business.industry;
    }
  }
  return store.mutate(state => {
    const user = findUser(state, userId);
    if (user.version !== input.version) throw new ValidationError('Профиль изменился. Перечитайте его перед сохранением.',409);
    for (const [key, value] of Object.entries(patch)) {
      user[key] = ['student','business'].includes(key) ? {...user[key],...value} : value;
    }
    user.version++;
    user.updatedAt = now();
    return ownProfile(user);
  });
}
