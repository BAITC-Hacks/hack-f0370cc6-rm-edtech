import { FIELDS, RUBRIC, INDUSTRIES, STAGES, enrich } from './domain.mjs';

// Scores are projections of confirmed milestones, never the persisted team.points value.
export function stateResponse(state) {
  const points = new Map(state.teams.map(team => [team.id, 0]));
  for (const proposal of state.proposals) {
    if (proposal.status !== 'accepted' || !points.has(proposal.teamId)) continue;
    const task = state.tasks.find(task => task.id === proposal.taskId);
    const awarded = new Set();
    for (const milestone of proposal.milestones ?? []) {
      const stage = STAGES.find(stage => stage.key === milestone.key);
      if (!stage || awarded.has(stage.key) || !milestone.confirmedAt ||
          !task || milestone.confirmedBy !== task.businessId || !milestone.evidence?.trim()) continue;
      awarded.add(stage.key);
      points.set(proposal.teamId, points.get(proposal.teamId) + stage.points);
    }
  }
  return {
    tasks: state.tasks.map(enrich),
    teams: state.teams.map(team => ({ ...team, points: points.get(team.id) })),
    proposals: state.proposals,
    drafts: state.drafts,
    meta: { fields: FIELDS, rubric: RUBRIC, industries: INDUSTRIES, stages: STAGES, aiMode: 'local' },
  };
}
