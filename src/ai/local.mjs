import { FIELDS } from '../domain.mjs';

export const LOCAL_WARNING = 'Локальная заглушка: используются правила и шаблоны, внешняя AI-модель не вызывалась. Проверьте и подтвердите сведения вручную.';

const questions = {
  data: ['Какие данные, примеры или материалы вы можете предоставить команде?', 'Команда должна понимать, на чём проверять решение.'],
  success: ['По каким измеримым признакам вы примете результат работы?', 'Это поможет отличить готовое решение от демонстрации.'],
  result: ['Что именно команда должна передать вам в результате?', 'Нужно определить проверяемый итог работы.'],
  constraints: ['Какие сроки, технологии и ограничения доступа нужно учитывать?', 'Границы задачи помогают составить реалистичный план.'],
  users: ['Кто будет пользоваться решением и в какой ситуации?', 'Для разных пользователей нужны разные сценарии.'],
  need: ['Что нужно изменить в текущем процессе и почему это важно?', 'Команде нужна конкретная потребность, а не только общая идея.'],
  context: ['Как процесс устроен сейчас и где возникает затруднение?', 'Контекст помогает понять причину задачи.'],
  title: ['Как коротко назвать задачу, чтобы был понятен её результат?', 'Название помогает командам находить задачу в каталоге.'],
  contact: ['Как команда сможет связаться с ответственным со стороны бизнеса?', 'Нужен согласованный способ задавать вопросы.'],
  format: ['Как вы готовы консультировать команду во время работы?', 'Формат консультаций помогает планировать взаимодействие.'],
  feedback: ['Кто проверит результат и как будет организована обратная связь?', 'Команда должна понимать порядок проверки результата.'],
};

const industryDataQuestions = {
  'Образование': 'Какие примеры учебных заданий или обезличенные данные процесса доступны, если они у вас есть?',
  'Ритейл': 'Какие примеры продаж, остатков или другого описанного процесса доступны, если они у вас есть?',
  'Логистика': 'Какие примеры заказов, маршрутов или другого описанного процесса доступны, если они у вас есть?',
  'Туризм': 'Какие примеры маршрутов, обращений или другого описанного процесса доступны, если они у вас есть?',
};

export function assembleFields(input) {
  const fields = Object.fromEntries(FIELDS.map(({key}) => [key, input.fields[key] ?? '']));
  for (const {key} of FIELDS) if (input.answers[key]) fields[key] = input.answers[key];
  // An explicitly supplied empty context remains empty (e.g. a manual deletion).
  if (!Object.hasOwn(input.fields, 'context') && !Object.hasOwn(input.answers, 'context')) fields.context = input.raw;
  return fields;
}

export function buildLocalResult(input) {
  const fields = assembleFields(input);
  const missingFields = FIELDS.filter(({key}) => !fields[key]).map(({key}) => key);
  const ordered = Object.keys(questions);
  const selected = ordered.filter(key => !fields[key]).slice(0, 6);
  for (const key of ordered) {
    if (selected.length >= 3) break;
    if (!selected.includes(key)) selected.push(key);
  }
  return {
    fields,
    questions: selected.map(field => ({
      field,
      question: fields[field]
        ? `Нужно ли уточнить сведения в поле «${FIELDS.find(item => item.key === field).label}» перед подтверждением?`
        : field === 'data' ? industryDataQuestions[input.industry] || questions[field][0] : questions[field][0],
      reason: fields[field] ? 'Проверьте введённые сведения; система не может подтвердить их за вас.' : questions[field][1],
    })),
    missingFields,
    warnings: [LOCAL_WARNING],
  };
}

export function generateLocal({input}) {
  return JSON.stringify(buildLocalResult(input));
}
