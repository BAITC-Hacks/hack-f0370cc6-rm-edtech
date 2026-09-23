import test from 'node:test';
import assert from 'node:assert/strict';
import { catalog, cleanFields, rate, readiness, ValidationError } from '../../src/domain.mjs';
import { createSeed } from '../../src/seed.mjs';
import { stateResponse } from '../../src/state.mjs';

test('seed has five drafts, cards, teams and proposals with zero earned team points', () => {
  const state = stateResponse(createSeed());
  for (const key of ['drafts', 'tasks', 'teams', 'proposals']) assert.equal(state[key].length, 5);
  assert.ok(state.teams.every(team => team.points === 0));
  assert.deepEqual(catalog(state.tasks).map(task => task.rating.score), [100, 90, 65, 45, 20]);
});

test('all readiness boundaries are inclusive at the specified threshold', () => {
  assert.deepEqual([0,39,40,69,70,89,90,100].map(score => readiness(score).key),
    ['draft','draft','working','working','ready','ready','priority','priority']);
});

test('rating counts only confirmed nonblank fields and loses points after deletion', () => {
  const task = createSeed().tasks[0];
  assert.equal(rate({ ...task, confirmedFields: [] }).score, 0);
  task.fields.data = '  ';
  const result = rate(task);
  assert.equal(result.score, 80);
  assert.equal(result.missing[0].key, 'data');
  assert.equal(result.breakdown.reduce((sum, group) => sum + group.earned, 0), result.score);
});

test('published scores 0 and 20 stay available while an unpublished high score stays private', () => {
  const tasks = createSeed().tasks;
  tasks[0].published = false;
  tasks.push({ ...tasks[4], id:'zero', confirmedFields:[] });
  assert.deepEqual(catalog(tasks).map(task => task.rating.score), [90,65,45,20,0]);
});

test('ties use ascending publication date, independent of input order', () => {
  const task = createSeed().tasks[4];
  assert.deepEqual(catalog([
    {...task, id:'new', publishedAt:'2026-09-23T12:00:00Z'},
    {...task, id:'old', publishedAt:'2026-09-23T10:00:00Z'},
  ]).map(task => task.id), ['old','new']);
});

test('filters combine, search trims whitespace and includes tags like frontend preview', () => {
  const tasks = createSeed().tasks;
  assert.equal(catalog(tasks, {industry:'Туризм',level:'working',query:'  КАРТЫ  '})[0].id, 'task_tour');
  assert.equal(catalog(tasks, {industry:'Туризм',level:'priority'}).length, 0);
});

test('cleanFields rejects invalid objects, unknown fields and non-string values', () => {
  for (const value of [null, [], 42, 'text', {title:null}, {title:7}, {unknown:'x'}]) {
    assert.throws(() => cleanFields(value), ValidationError);
  }
  assert.equal(cleanFields({title:'  Title  '}).title, 'Title');
  assert.equal(cleanFields().context, '');
  assert.throws(() => cleanFields({title:'x'.repeat(161)}), ValidationError);
});

test('state ignores stored team points and recalculates confirmed unique milestones', () => {
  const state = createSeed();
  state.teams[0].points = 9999;
  const proposal = state.proposals[0];
  const milestone = {key:'prototype', points:999, confirmedAt:'2026-09-23T12:00:00Z', confirmedBy:'business_demo', evidence:'Проверен прототип'};
  proposal.milestones = [milestone, {...milestone}];
  assert.equal(stateResponse(state).teams[0].points, 0);
  proposal.status = 'accepted';
  assert.equal(stateResponse(state).teams[0].points, 50);
  proposal.milestones.push({...milestone, key:'result', confirmedBy:'other'});
  assert.equal(stateResponse(state).teams[0].points, 50);
});
