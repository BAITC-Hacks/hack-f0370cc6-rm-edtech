import { ValidationError } from '../domain.mjs';
import { listOwnCases } from './cases.mjs';

const rubric = [
  {key:'goal',label:'Понимание задачи',max:30,question:'Как ваш подход решает конкретную потребность бизнеса?'},
  {key:'plan',label:'План работы',max:30,question:'Какие шаги вы выполните и что передадите после каждого?'},
  {key:'verification',label:'Проверка результата',max:25,question:'Как бизнес проверит, что результат работает?'},
  {key:'constraints',label:'Ограничения',max:15,question:'Какие сроки, доступы и ограничения нужно согласовать?'},
];
const localWarning = 'Локальная проверка по прозрачным правилам, без обращения к модели. Балл отражает признаки конкретного плана в тексте, а не опыт человека или вероятность успеха. Решение принимает бизнес.';
function inputObject(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key=>!keys.includes(key))) throw new ValidationError('Проверьте поля запроса.');
}
function userIn(state,userId) {
  const user=state.users.find(user=>user.id===userId);
  if(!user) throw new ValidationError('Войдите в аккаунт.',401);
  return user;
}
function identifier(value) {
  if(typeof value!=='string'||!value.trim()||value.length>160) throw new ValidationError('Укажите идентификатор.');
  return value;
}
const tokens = value => new Set((value.toLowerCase().match(/[а-яёa-z]{4,}/gu)||[])
  .map(word=>word.slice(0,4)).filter(word=>!['зада','бизн','нужн','кото','рабо','опыт','навы','пред','реше'].includes(word)));

export async function analyzeFit(store,userId,input,options={}) {
  inputObject(input,['applicationId']);
  const applicationId=identifier(input.applicationId);
  const state=store.read();
  const user=userIn(state,userId);
  const application=state.applications.find(item=>item.id===applicationId);
  if(!application) throw new ValidationError('Отклик не найден.',404);
  const order=state.orders.find(item=>item.id===application.orderId);
  if(!order) throw new ValidationError('Задача не найдена.',404);
  if(user.activeRole!=='business'||order.ownerId!==userId) throw new ValidationError('Отклик анализирует владелец задачи в режиме бизнеса.',403);
  const confirmed=['need','result','success','data','constraints','users'].filter(key=>order.confirmedFields?.includes(key))
    .map(key=>order.fields?.[key]||'').join(' ');
  const context=tokens(`${order.title} ${order.description} ${confirmed}`);
  const sentences=(application.message.match(/[^.!?\n]+(?:[.!?]|$)/gu)||[]).map(value=>value.trim()).filter(value=>value.length>=12);
  const patterns={plan:/сначала|затем|этап|план|собер|разработ|проанализ|шаг/iu,
    verification:/провер|тест|сравн|метрик|критери|при[её]мк/iu,
    constraints:/срок|недел|дней|доступ|огранич|обезлич|бюджет/iu};
  const criteria=rubric.map(rule=>{
    const quote=sentences.find(sentence=>rule.key==='goal'?[...tokens(sentence)].some(word=>context.has(word)):patterns[rule.key].test(sentence));
    return {label:rule.label,score:quote?Math.floor(rule.max/2):0,max:rule.max,
      reason:quote?`В отклике найден признак критерия: «${quote}». Соответствие нужно проверить с участником.`:'В тексте отклика не найдено явного основания для этого критерия.'};
  });
  return {mode:'local',score:criteria.reduce((sum,item)=>sum+item.score,0),criteria,
    gaps:criteria.filter(item=>item.score===0).map(item=>item.label),
    questions:rubric.filter((_,index)=>criteria[index].score===0).map(item=>item.question),
    warnings:[localWarning,...(options.apiKey?['Внешняя модель для анализа откликов в этой версии не подключена; используется локальная проверка.']:[])]};
}

export async function formatCase(store,userId,input,options={}) {
  inputObject(input,['caseId','audience']);
  const caseId=identifier(input.caseId);
  if(!['education','employment'].includes(input.audience)) throw new ValidationError('Выберите оформление для учёбы или работодателя.');
  const record=listOwnCases(store,userId).find(item=>item.id===caseId);
  if(!record) throw new ValidationError('Кейс не найден или недоступен.',404);
  const headings={title:'Проект',problem:'Задача',approach:'Подход',result:'Результат — со слов участника',
    contribution:'Личный вклад — со слов участника',skills:'Навыки — со слов участника'};
  const fields=input.audience==='education'?['title','problem','approach','result','contribution','skills']:
    ['title','result','contribution','approach','problem','skills'];
  const sections=fields.map(field=>({title:headings[field],text:field==='skills'?record.skills.join(', '):record[field]})).filter(section=>section.text);
  return {mode:'local',sections,warnings:[
    'Локальное оформление по шаблону: сведения сохранены дословно. Проверьте текст перед самостоятельной публикацией. Оформление ничего не сохраняет.',
    'Принятие результата связанной задачи не является подтверждением текста кейса или личного вклада.',
    ...(options.apiKey?['Внешняя модель для оформления кейсов в этой версии не подключена.']:[]),
  ]};
}
