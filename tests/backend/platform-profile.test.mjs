import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPlatformStore } from '../../src/platform/store.mjs';
import { createStore } from '../../src/store.mjs';
import { getProfile, publicProfile, updateProfile } from '../../src/platform/profile.mjs';
import { temporaryDirectory } from './helpers.mjs';

async function fixture(t) {
  const file = join(await temporaryDirectory(t),'platform.json');
  const store = await createPlatformStore(file);
  await store.mutate(state => state.users.push({
    id:'alice',googleSubject:'google-private-subject',email:'alice@example.test',emailVerified:true,
    name:'Алия',contacts:'Личный контакт',photoUrl:'https://example.test/photo.png',activeRole:'student',
    student:{skills:[],portfolio:[]},business:{companyName:'',industry:''},version:1,
    createdAt:'2026-09-23T00:00:00.000Z',updatedAt:'2026-09-23T00:00:00.000Z',
    accidentalPrivateField:'never-expose',
  }));
  return {file,store};
}

test('one profile preserves both roles and portfolio across switching and reopening',async t => {
  const {file,store} = await fixture(t);
  const student = await updateProfile(store,'alice',{version:1,student:{skills:[' Python ','UX','Python'],
    portfolio:[{title:'Прогноз для магазина',url:'https://example.test/work',description:'Учебная работа'}]}});
  assert.deepEqual(student.student.skills,['Python','UX']);
  const business = await updateProfile(store,'alice',{version:student.version,activeRole:'business',
    business:{companyName:'Наша студия',industry:'Услуги'}});
  assert.equal(business.student.portfolio[0].title,'Прогноз для магазина');
  const switched = await updateProfile(store,'alice',{version:business.version,activeRole:'student',name:'Алия А.'});
  assert.equal(switched.business.companyName,'Наша студия');
  assert.equal(switched.contacts,'Личный контакт');
  assert.deepEqual(getProfile(await createPlatformStore(file),'alice'),switched);
});

test('public profile excludes contacts, email, identity and all unexpected private fields',async t => {
  const {store} = await fixture(t);
  const own = getProfile(store,'alice');
  assert.equal(own.email,'alice@example.test');
  assert.equal(own.googleSubject,undefined);
  assert.equal(own.accidentalPrivateField,undefined);
  const publicView = publicProfile(store,'alice');
  assert.deepEqual(Object.keys(publicView).sort(),['id','name','photoUrl','student','business'].sort());
  assert(!JSON.stringify(publicView).includes('Личный контакт'));
  publicView.student.skills.push('tamper');
  assert.deepEqual(store.read().users[0].student.skills,[]);
});

test('profile rejects forged ownership, Google identity, verification and nested bonus fields without writes',async t => {
  const {file,store} = await fixture(t);
  const before = await readFile(file,'utf8');
  const cases = [
    {id:'bob'}, {email:'bob@example.test'}, {googleSubject:'someone-else'}, {emailVerified:false},
    {points:999}, {createdAt:'yesterday'}, {student:{verified:true}}, {business:{ownerId:'bob'}},
    {activeRole:'admin'}, {name:''}, {name:null}, {contacts:123}, {photoUrl:'javascript:alert(1)'},
    {photoUrl:'https://name:password@example.test/photo'}, {student:{skills:['']}},
    {student:{portfolio:[{title:'Work',url:'https://example.test',confirmed:true}]}},
  ];
  for (const patch of cases) {
    await assert.rejects(updateProfile(store,'alice',{version:1,...patch}),error => error.status === 400);
  }
  assert.equal(await readFile(file,'utf8'),before);
  await assert.rejects(updateProfile(store,'unknown',{version:1,name:'Name'}),error => error.status === 401);
  assert.throws(() => getProfile(store,'unknown'),error => error.status === 401);
});

test('profile text and collection bounds, explicit clearing and patch semantics stay predictable',async t => {
  const {store} = await fixture(t);
  let current = await updateProfile(store,'alice',{version:1,name:'а'.repeat(160),contacts:'x'.repeat(500),
    student:{skills:Array.from({length:30},(_,i)=>`${i}`),portfolio:[{title:'x',url:'https://example.test'}]}});
  for (const patch of [{name:'x'.repeat(161)},{contacts:'x'.repeat(501)},
    {student:{skills:Array(31).fill('Python')}},{student:{portfolio:Array(21).fill({})}},
    {student:{portfolio:[{title:'x',url:'data:text/plain,test'}]}},{business:{industry:'Неправильная'}}]) {
    await assert.rejects(updateProfile(store,'alice',{version:current.version,...patch}),error=>error.status===400);
  }
  current = await updateProfile(store,'alice',{version:current.version,contacts:'',photoUrl:'',student:{skills:[]}});
  assert.equal(current.contacts,'');
  assert.equal(current.photoUrl,'');
  assert.deepEqual(current.student.skills,[]);
  assert.equal(current.student.portfolio.length,1);
});

test('competing profile versions preserve the winning edit and reject the stale edit',async t => {
  const {store} = await fixture(t);
  const results = await Promise.allSettled([
    updateProfile(store,'alice',{version:1,contacts:'One'}),
    updateProfile(store,'alice',{version:1,contacts:'Two'}),
  ]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
  assert.equal(getProfile(store,'alice').version,2);
});

test('platform storage stays separate from legacy demo data and rejects the wrong schema without erasing it',async t => {
  const dir = await temporaryDirectory(t);
  const demoFile = join(dir,'demo.json');
  await createStore(demoFile);
  const demoBytes = await readFile(demoFile,'utf8');
  await assert.rejects(createPlatformStore(demoFile),/формат/);
  assert.equal(await readFile(demoFile,'utf8'),demoBytes);
  const platformFile = join(dir,'platform.json');
  const platform = await createPlatformStore(platformFile);
  assert.equal(platform.read().schemaVersion,2);
  const platformBytes = await readFile(platformFile,'utf8');
  await assert.rejects(createStore(platformFile),/формат/);
  assert.equal(await readFile(platformFile,'utf8'),platformBytes);
  await writeFile(platformFile,'{broken','utf8');
  await assert.rejects(createPlatformStore(platformFile),/прочитать/);
  assert.equal(await readFile(platformFile,'utf8'),'{broken');
});

test('rejected private-state writes leave memory and disk unchanged and do not poison the queue',async t => {
  const {file,store} = await fixture(t);
  const before = await readFile(file,'utf8');
  await assert.rejects(store.mutate(state => {state.users[0].name='lost';throw new Error('cancel');}),/cancel/);
  await assert.rejects(store.mutate(state => {state.sessions=null;}),/формат/);
  assert.equal(await readFile(file,'utf8'),before);
  assert.equal(getProfile(store,'alice').name,'Алия');
  const output = await updateProfile(store,'alice',{version:1,name:'Saved'});
  output.student.skills.push('outside');
  assert.deepEqual(store.read().users[0].student.skills,[]);
  assert.equal(getProfile(store,'alice').name,'Saved');
});
