import { id, now, requireBusiness, requireFound, STAGES, text, ValidationError } from './domain.mjs';
import { stateResponse } from './state.mjs';

function knownKeys(body, keys) {
  if (Object.keys(body).some(key => !keys.includes(key))) throw new ValidationError('Неизвестное поле запроса.');
}

function proposalLink(value) {
  const link = text(value, 'Ссылка на решение или материалы', { required: true, max: 2048 });
  let url;
  try { url = new URL(link); } catch { throw new ValidationError('Укажите абсолютную HTTP(S) ссылку.'); }
  if (!/^https?:\/\//i.test(link) || !['http:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || /[\u0000-\u0020\u007f\\]/.test(link)) {
    throw new ValidationError('Укажите абсолютную HTTP(S) ссылку без логина и пароля.');
  }
  return link;
}

export async function createProposal(store, taskId, body) {
  knownKeys(body, ['role', 'teamId', 'idea', 'plan', 'duration', 'link']);
  const teamId = text(body.teamId, 'Команда', { required: true, max: 160 });
  const idea = text(body.idea, 'Идея решения', { required: true, max: 4000 });
  const plan = text(body.plan, 'План работы', { required: true, max: 4000 });
  const duration = text(body.duration, 'Срок работы', { required: true, max: 500 });
  const link = proposalLink(body.link);
  return store.mutate(state => {
    if (body.role !== 'team') throw new ValidationError('Отклик доступен в демонстрационной роли команды.', 403);
    requireFound(state.teams, teamId, 'Команда');
    const task = requireFound(state.tasks, taskId, 'Задача');
    if (!task.published) throw new ValidationError('Отклик доступен после публикации задачи.');
    const proposal = {
      id: id('proposal'), taskId: task.id, teamId, idea, plan, duration, link,
      status: 'pending', createdAt: now(), milestones: [],
    };
    state.proposals.push(proposal);
    return proposal;
  });
}

export async function decideProposal(store, proposalId, body) {
  knownKeys(body, ['role', 'businessId', 'status']);
  if (!['accepted', 'rejected'].includes(body.status)) throw new ValidationError('Выберите принятие или отклонение отклика.');
  return store.mutate(state => {
    const proposal = requireFound(state.proposals, proposalId, 'Заявка');
    const task = requireFound(state.tasks, proposal.taskId, 'Задача');
    requireBusiness(task, body);
    if (body.status === 'rejected' && proposal.milestones.length) {
      throw new ValidationError('Нельзя отклонить отклик после подтверждения первого этапа.', 409);
    }
    proposal.status = body.status;
    return proposal;
  });
}

export async function confirmMilestone(store, proposalId, body) {
  knownKeys(body, ['role', 'businessId', 'key', 'evidence']);
  const stage = STAGES.find(stage => stage.key === body.key);
  if (!stage) throw new ValidationError('Неизвестный этап работы.');
  const evidence = text(body.evidence, 'Что проверили и приняли', { required: true, max: 4000 });
  return store.mutate(state => {
    const proposal = requireFound(state.proposals, proposalId, 'Заявка');
    const task = requireFound(state.tasks, proposal.taskId, 'Задача');
    requireBusiness(task, body);
    requireFound(state.teams, proposal.teamId, 'Команда');
    if (proposal.status !== 'accepted') throw new ValidationError('Сначала примите отклик команды.', 409);
    const previous = proposal.milestones.find(milestone => milestone.key === stage.key);
    if (!previous) {
      if (stage.key === 'result' && !proposal.milestones.some(milestone => milestone.key === 'prototype')) {
        throw new ValidationError('Сначала подтвердите проверку прототипа.', 409);
      }
      proposal.milestones.push({
        key: stage.key, points: stage.points, evidence, confirmedAt: now(), confirmedBy: task.businessId,
      });
    }
    const team = stateResponse(state).teams.find(team => team.id === proposal.teamId);
    return { proposal, team };
  });
}
