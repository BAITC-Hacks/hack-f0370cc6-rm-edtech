import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFit,formatCase } from '../../src/platform/assist.mjs';

const fixture=()=>({users:[{id:'business',activeRole:'business'},{id:'student',activeRole:'student'}],
  orders:[{id:'order',ownerId:'business',title:'Учёт заявок',description:'Собрать заявки в таблицу'}],
  applications:[{id:'application',orderId:'order',studentId:'student',message:'Я очень опытный разработчик, 10 лет опыта.'}],
  cases:[{id:'case',userId:'student',title:'Мой проект',problem:'Терялись заявки',approach:'Собрал таблицу',result:'Прототип проверен мной',contribution:'Написал код',skills:['JS'],orderId:null,version:1,published:false,createdAt:'2026-01-01',updatedAt:'2026-01-01'}]});
test('local fit rewards a concrete plan rather than claims of experience and never writes',async()=>{
  const state=fixture(); const store={read:()=>structuredClone(state)};
  const generic=await analyzeFit(store,'business',{applicationId:'application'});
  state.applications[0].message='Сначала соберу заявки в таблицу. Затем проверю тестовые заявки. Согласую доступ и срок две недели.';
  const before=structuredClone(state);
  const concrete=await analyzeFit(store,'business',{applicationId:'application'},{apiKey:'test-only',fetchImpl:()=>{throw Error('must not call');}});
  assert.ok(concrete.score>generic.score); assert.equal(concrete.mode,'local'); assert.ok(concrete.score<=49);
  assert.deepEqual(state,before); assert.ok(concrete.warnings.some(item=>item.includes('не подключена')));
  await assert.rejects(()=>analyzeFit(store,'student',{applicationId:'application'}),{status:403});
});
test('case formatting preserves supplied facts, is local, private and does not publish',async()=>{
  const state=fixture(); const store={read:()=>structuredClone(state)}; const before=structuredClone(state);
  const output=await formatCase(store,'student',{caseId:'case',audience:'employment'});
  assert.equal(output.mode,'local'); assert.equal(output.sections[1].text,state.cases[0].result);
  assert.deepEqual(state,before); await assert.rejects(()=>formatCase(store,'business',{caseId:'case',audience:'education'}),{status:404});
});
