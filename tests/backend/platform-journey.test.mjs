import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createPlatformStore } from '../../src/platform/store.mjs';
import { createGoogleAuth } from '../../src/platform/auth.mjs';
import { updateProfile } from '../../src/platform/profile.mjs';
import { createOrder, listOrders, applyToOrder, decideApplication, transitionOrder, listOwnOrders } from '../../src/platform/orders.mjs';
import { createAttachment, getAttachment, deleteAttachment } from '../../src/platform/files.mjs';
import { createReview, listStudentReviews } from '../../src/platform/reviews.mjs';
import { temporaryDirectory } from './helpers.mjs';

test('private services connect Google identity, both profile roles, solo work and restricted brief history', async t => {
  const file = join(await temporaryDirectory(t),'platform.json');
  const store = await createPlatformStore(file);
  const login = async (subject,role) => {
    const auth = createGoogleAuth({store,clientId:'test.apps.googleusercontent.com',clientSecret:'fake-test-secret',
      redirectUri:'http://127.0.0.1:3001/api/v2/auth/google/callback',
      fetchImpl:async url => new Response(JSON.stringify(url.endsWith('/token')
        ? {access_token:'fake-test-access-token',token_type:'Bearer'}
        : {sub:subject,email:`${subject}@example.test`,email_verified:true,name:subject}),{status:200})});
    const start = auth.begin({role,returnTo:'/orders'});
    const result = await auth.callback({state:new URL(start.url).searchParams.get('state'),stateCookie:start.stateCookie,code:'test-code'});
    return {auth,...result};
  };
  const owner = await login('business-owner','business');
  const student = await login('student-newcomer','student');
  const outsider = await login('other-student','student');
  assert.equal(owner.auth.session(owner.sessionToken).id,owner.user.id);
  assert.equal(student.user.student.portfolio.length,0);
  const order = await createOrder(store,owner.user.id,{title:'Не терять заявки',category:'Услуги',description:'Нужно собрать обращения в одном месте.'});
  const upload = await createAttachment(store,owner.user.id,order.id,{version:order.version,name:'brief.txt',mimeType:'text/plain',bytes:Buffer.from('Примеры обезличены. Результат: список обращений.')});
  const brief = getAttachment(store,student.user.id,upload.file.id);
  assert.match(brief.bytes.toString(),/Примеры/);
  assert.equal(listOrders(store).length,1);
  const application = await applyToOrder(store,student.user.id,order.id,{message:'Покажу прототип формы и проверю на ваших примерах.'});
  const accepted = await decideApplication(store,owner.user.id,application.id,{version:upload.orderVersion,status:'accepted'});
  assert.equal(listOrders(store).length,0);
  assert.throws(()=>getAttachment(store,outsider.user.id,upload.file.id),error=>error.status===403);
  assert.equal(getAttachment(store,student.user.id,upload.file.id).metadata.id,upload.file.id);
  await updateProfile(store,owner.user.id,{version:owner.user.version,activeRole:'student'});
  assert.equal(owner.auth.session(owner.sessionToken).activeRole,'student');
  assert.equal(getAttachment(store,owner.user.id,upload.file.id).metadata.id,upload.file.id);
  await assert.rejects(transitionOrder(store,owner.user.id,order.id,{version:accepted.order.version,status:'completed',evidence:'Проверено'}),error=>error.status===403);
  await updateProfile(store,owner.user.id,{version:2,activeRole:'business'});
  const done = await transitionOrder(store,owner.user.id,order.id,{version:accepted.order.version,status:'completed',evidence:'В тестовом сценарии каждое обращение попало в общий список.'});
  await assert.rejects(deleteAttachment(store,owner.user.id,upload.file.id,{version:done.version}),error=>error.status===409);
  const review = await createReview(store,owner.user.id,order.id,{studentId:student.user.id,text:'Прототип проверен на наших примерах. Студент объяснил, как использовать общий список.'});
  assert.equal(review.studentId,student.user.id);
  assert.equal(review.evidence,undefined);
  const reopened = await createPlatformStore(file);
  assert.equal(listOwnOrders(reopened,owner.user.id)[0].history.at(-1).to,'completed');
  assert.equal(getAttachment(reopened,student.user.id,upload.file.id).bytes.toString(),brief.bytes.toString());
  assert.equal(reopened.read().users.length,3);
  assert.equal(reopened.read().sessions.length,3);
  assert.deepEqual(listStudentReviews(reopened,student.user.id),[review]);
  assert(!JSON.stringify(reopened.read()).includes('fake-test-access-token'));
});
