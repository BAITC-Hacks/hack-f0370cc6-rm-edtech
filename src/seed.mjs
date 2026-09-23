import { cleanFields, now, enrich } from './domain.mjs';

const examples = [
  { id: 'task_coffee', industry: 'Ритейл', company: 'Tañ Coffee', initials: 'T', color: 'peach', tags: ['Python', 'Аналитика', 'Прогнозирование'],
    raw: 'У нас небольшая сеть кофеен. Хотим меньше списывать выпечку и понимать, сколько заказывать на завтра.',
    fields: { title: 'Предсказать спрос на выпечку в кофейнях', context: 'У сети Tañ Coffee три кофейни. Управляющие заказывают выпечку на глаз, часть продукции списывается в конце дня.', need: 'Прогнозировать ежедневный спрос по каждой точке и сократить списания.', users: 'Управляющие трёх кофеен и закупщик.', data: 'Синтетический CSV продаж по дням за 6 месяцев: точка, товар, количество, цена и списание. Данные можно предоставить команде.', constraints: 'Прототип за 2 недели. Python, без интеграции с кассовой системой. Только обезличенные данные.', result: 'Веб-дашборд с прогнозом заказа на завтра по каждой кофейне и выгрузкой CSV.', success: 'На отложенных последних 30 днях MAE прогноза минимум на 15% ниже базового прогноза по среднему за неделю.', contact: 'Демо-контакт: owner@tan.example', format: 'Две онлайн-консультации по 30 минут в неделю.', feedback: 'Управляющий проверяет прототип и отвечает в течение 2 рабочих дней.' } },
  { id: 'task_edu', industry: 'Образование', company: 'Qadam School', initials: 'Q', color: 'lavender', tags: ['JavaScript', 'UX/UI', 'Образование'],
    raw: 'Ученики забывают домашние задания. Нужен понятный личный кабинет с практикой и прогрессом.',
    fields: { title: 'Превратить домашнюю практику в привычку', context: 'В языковой школе ученики получают практические задания в разных мессенджерах.', need: 'Собрать практику в одном месте и помочь ученикам видеть свой прогресс.', users: 'Ученики языковых курсов и преподаватели.', data: '20 примеров учебных заданий и обезличенная таблица выполнения за месяц.', constraints: 'Пилот на одной учебной группе, 3 недели. Без персональных данных учащихся.', result: 'Интерактивный веб-прототип: список практики, отправка ответа, прогресс.', success: 'Преподаватель создаёт задание, ученик отправляет ответ и видит обновлённый прогресс.', contact: '', format: '', feedback: '' } },
  { id: 'task_tour', industry: 'Туризм', company: 'Steppe Travel', initials: 'S', color: 'mint', tags: ['Карты', 'JavaScript', 'UX/UI'],
    raw: 'Нужен конструктор прогулок по Алматы. У нас есть список мест и описания.',
    fields: { title: 'Собрать городской маршрут за пару минут', context: 'Туроператор вручную составляет маршруты для небольших групп по Алматы.', need: 'Ускорить подбор прогулки по интересам гостей.', users: 'Туристы и менеджеры туроператора.', data: 'Тестовый список 30 локаций с координатами, описанием и временем посещения.', result: 'Прототип карты с выбором интересов и маршрутом на полдня.' } },
  { id: 'task_logistics', industry: 'Логистика', company: 'Jol Logistics', initials: 'J', color: 'sky', tags: ['Python', 'Логистика', 'Оптимизация'],
    raw: 'Хотим понимать, почему курьеры опаздывают, и лучше распределять заказы.',
    fields: { title: 'Помочь диспетчеру планировать доставку', context: 'Диспетчер распределяет доставки вручную в таблице. Иногда курьеры приезжают позже назначенного окна.', need: 'Находить причины опозданий и показывать загрузку курьеров.', users: 'Диспетчеры службы доставки.', result: 'Дашборд загрузки и отчёт о причинах задержек.' } },
  { id: 'task_service', industry: 'Услуги', company: 'Örken Studio', initials: 'Ö', color: 'rose', tags: ['Автоматизация', 'Дизайн'],
    raw: 'В студии теряются заявки клиентов. Хотим что-нибудь удобное вместо чатов.',
    fields: { title: 'Собрать заявки студии в одном месте', context: 'Небольшая дизайн-студия получает запросы из нескольких каналов.', need: 'Перестать терять клиентские заявки.' } },
];
export function createSeed() {
  const createdAt = now();
  const tasks = examples.map((x, index) => {
    const fields = cleanFields(x.fields);
    return { ...x, fields, businessId: 'business_demo', published: true, publishedAt: new Date(Date.now() - (5 - index) * 3600000).toISOString(), createdAt, updatedAt: createdAt, confirmedAt: createdAt, confirmedFields: Object.keys(fields).filter(k => fields[k]), version: 1 };
  });
  const teams = [
    { id: 'team_orbit', name: 'Orbit', initials: 'O', color: 'lavender', description: 'Делаем понятные продукты на стыке данных и дизайна.', members: 4, interests: ['Ритейл', 'Образование'], skills: ['Аналитика', 'UX/UI'], technologies: ['Python', 'JavaScript'] },
    { id: 'team_nomad', name: 'Nomad Labs', initials: 'N', color: 'mint', description: 'От исследования задачи до работающего веб-приложения.', members: 3, interests: ['Туризм', 'Услуги'], skills: ['Карты', 'Дизайн'], technologies: ['JavaScript', 'React'] },
    { id: 'team_tensor', name: 'Tensor', initials: 'T', color: 'sky', description: 'Прогнозируем спрос и превращаем таблицы в решения.', members: 5, interests: ['Ритейл', 'Логистика'], skills: ['Прогнозирование', 'Аналитика'], technologies: ['Python', 'SQL'] },
    { id: 'team_qadam', name: 'Qadam Dev', initials: 'Q', color: 'peach', description: 'Создаём цифровые инструменты для обучения.', members: 4, interests: ['Образование'], skills: ['UX/UI', 'Автоматизация'], technologies: ['JavaScript', 'TypeScript'] },
    { id: 'team_jol', name: 'Jol', initials: 'J', color: 'rose', description: 'Исследуем маршруты и оптимизируем процессы.', members: 3, interests: ['Логистика', 'Туризм'], skills: ['Оптимизация', 'Карты'], technologies: ['Python', 'JavaScript'] },
  ];
  const proposals = [
    ['proposal_1', 'task_coffee', 'team_orbit', 'Дашборд спроса с объяснимым прогнозом', 'Изучим данные и построим базовый прогноз. Сравним модели на отложенной выборке. Соберём дашборд и проверим его с управляющим.', '14 дней', 'https://example.com/orbit-demo'],
    ['proposal_2', 'task_coffee', 'team_tensor', 'Прогноз спроса с учётом дня недели', 'Проверим качество данных. Построим baseline. Сравним MAE моделей. Добавим выгрузку рекомендаций для закупщика.', '12 дней', 'https://example.com/tensor-demo'],
    ['proposal_3', 'task_edu', 'team_qadam', 'Кабинет практики с понятным прогрессом', 'Проведём интервью с преподавателем. Сделаем кликабельный прототип. Реализуем цикл от задания до ответа.', '21 день', 'https://example.com/qadam-demo'],
    ['proposal_4', 'task_tour', 'team_nomad', 'Прогулки по интересам на интерактивной карте', 'Подготовим каталог локаций. Добавим фильтры. Соберём маршрут и протестируем на трёх сценариях.', '10 дней', 'https://example.com/nomad-demo'],
    ['proposal_5', 'task_service', 'team_jol', 'Единая доска входящих заявок', 'Уточним каналы обращений. Согласуем статусы. Создадим простую доску и проверим на тестовых заявках.', '10 дней', 'https://example.com/jol-demo'],
  ].map(([id, taskId, teamId, idea, plan, duration, link]) => ({ id, taskId, teamId, idea, plan, duration, link, status: 'pending', createdAt, milestones: [] }));
  return { schemaVersion: 1, tasks, teams, proposals, drafts: examples.map(x => ({ text: x.raw, industry: x.industry })), activity: [] };
}
