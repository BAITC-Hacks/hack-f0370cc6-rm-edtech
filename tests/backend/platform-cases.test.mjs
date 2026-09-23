import test from 'node:test';
import assert from 'node:assert/strict';
import { createCase,updateCase,listPublicCases,profileProgress } from '../../src/platform/cases.mjs';
function fixture(){
  let state={users:[{id:'student',activeRole:'student',name:'Имя',contacts:'Контакт',student:{skills:['JS']}}],orders:[],applications:[],reviews:[],cases:[]};
  let queue=Promise.resolve();
  return {read:()=>structuredClone(state),mutate(fn){const operation=queue.then(()=>{const next=structuredClone(state);const result=fn(next);state=next;return structuredClone(result);});queue=operation.catch(()=>{});return operation;}};
}
test('cases need explicit complete publication, version checks and cannot forge business confirmation',async()=>{
  const store=fixture(); const draft=await createCase(store,'student',{title:'Проект'});
  assert.equal(draft.taskConfirmation,null); assert.equal(draft.published,false); assert.equal(listPublicCases(store,'student').length,0);
  await assert.rejects(()=>updateCase(store,'student',draft.id,{version:1,published:true}),{status:400});
  const result=await updateCase(store,'student',draft.id,{version:1,problem:'Задача',approach:'Подход',result:'Результат',contribution:'Моя работа',published:true});
  assert.equal(result.version,2); assert.equal(listPublicCases(store,'student').length,1);
  await assert.rejects(()=>updateCase(store,'student',draft.id,{version:1,title:'Замена'}),{status:409});
  await assert.rejects(()=>createCase(store,'student',{title:'Проект',taskConfirmation:{businessId:'fake'}}),{status:400});
  assert.equal(profileProgress(store,'student').total,15);
});
test('self-described profile and case bonuses are capped at thirty and never invent business reviews',async()=>{
  const store=fixture();
  for(let i=0;i<7;i++){const record=await createCase(store,'student',{title:`Проект ${i}`,problem:'Задача',approach:'Подход',result:'Результат',contribution:'Личный вклад'});await updateCase(store,'student',record.id,{version:1,published:true});}
  const result=profileProgress(store,'student'); assert.equal(result.total,30); assert.equal(result.rank,'Практика');
  assert.equal(result.breakdown.find(item=>item.source==='business_reviews').points,0);
});
