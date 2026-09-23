import { cleanFields, FIELDS, INDUSTRIES, text, ValidationError } from '../domain.mjs';
import { ANALYSIS_PROMPT } from './prompt.mjs';
import { assembleFields, buildLocalResult, generateLocal, LOCAL_WARNING } from './local.mjs';

const fieldKeys = FIELDS.map(field => field.key);
const MAX_OUTPUT_BYTES = 64 * 1024;
export const FALLBACK_WARNING = 'Анализатор не вернул корректный результат вовремя. Показаны локальные вопросы; введённые сведения сохранены в ответе.';
export const REMOTE_WARNING = 'Вопросы предложены AI. Проверьте их уместность; сведения карточки остаются введёнными вами и требуют ручного подтверждения.';
export const REMOTE_FALLBACK_WARNING = 'Использован локальный резервный режим после неуспешной попытки внешнего AI-анализа.';

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${label}: ожидается объект.`);
  return value;
}

function partialFields(value, label) {
  object(value, label);
  const cleaned = cleanFields(value);
  // Preserve which fields were explicitly supplied; absent and intentionally empty differ.
  return Object.fromEntries(Object.keys(value).map(key => [key, cleaned[key]]));
}

export function validateAnalysisInput(value) {
  object(value, 'Запрос');
  if (Object.keys(value).some(key => !['raw','industry','fields','answers'].includes(key))) {
    throw new ValidationError('Неизвестное поле запроса анализа.');
  }
  const raw = text(value.raw, 'Описание потребности', {required:true, max:4000});
  const industry = text(value.industry, 'Отрасль', {required:true, max:100});
  if (!INDUSTRIES.includes(industry)) throw new ValidationError('Неизвестная отрасль.');
  return {
    raw, industry,
    fields: Object.hasOwn(value, 'fields') ? partialFields(value.fields, 'Поля') : {},
    answers: Object.hasOwn(value, 'answers') ? partialFields(value.answers, 'Ответы') : {},
  };
}

function sameKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
}

// Both modes retain human facts verbatim. Remote generation can customize questions only.
export function validateAnalysisResult(output, input, {mode = 'local'} = {}) {
  if (typeof output !== 'string' || Buffer.byteLength(output,'utf8') > MAX_OUTPUT_BYTES) throw new Error('Invalid result size/type');
  const result = JSON.parse(output);
  if (!sameKeys(result,['fields','questions','missingFields','warnings'])) throw new Error('Invalid result schema');
  if (!sameKeys(result.fields,fieldKeys)) throw new Error('Incomplete fields');
  const fields = cleanFields(result.fields);
  const expected = assembleFields(input);
  if (fieldKeys.some(key => fields[key] !== expected[key])) throw new Error('Unverified or overwritten facts');
  if (!Array.isArray(result.questions) || result.questions.length < 3 || result.questions.length > 6) throw new Error('Invalid question count');
  const seen = new Set();
  for (const q of result.questions) {
    if (!sameKeys(q,['field','question','reason']) || !fieldKeys.includes(q.field) || seen.has(q.field)) throw new Error('Invalid question field');
    text(q.question, 'Вопрос', {required:true,max:500});
    text(q.reason, 'Причина', {required:true,max:500});
    seen.add(q.field);
  }
  const missing = fieldKeys.filter(key => !fields[key]);
  if (!Array.isArray(result.missingFields) || result.missingFields.length !== missing.length ||
    new Set(result.missingFields).size !== missing.length || missing.some(key => !result.missingFields.includes(key))) throw new Error('Invalid missing fields');
  if (!Array.isArray(result.warnings) || result.warnings.length > 5) throw new Error('Invalid warnings');
  for (const warning of result.warnings) text(warning, 'Предупреждение', {required:true,max:500});
  // Mode/warnings are server-owned, never provider-controlled metadata.
  return {mode:mode === 'remote' ? 'remote' : 'local', fields, questions:result.questions,
    missingFields:missing, warnings:[mode === 'remote' ? REMOTE_WARNING : LOCAL_WARNING]};
}

// generate/timeout are constructor-only test seams. No HTTP field selects a provider or URL.
export async function analyzeTask(value, {generate = generateLocal, timeoutMs = 2000, mode = 'local'} = {}) {
  const input = validateAnalysisInput(value); // Invalid requests are 400, not a success fallback.
  const fallback = {mode:'local', ...buildLocalResult(input)};
  let timeout;
  const controller = new AbortController();
  try {
    const output = await Promise.race([
      Promise.resolve().then(() => generate({prompt:ANALYSIS_PROMPT, input:structuredClone(input), signal:controller.signal})),
      new Promise((_,reject) => {timeout=setTimeout(() => {
        controller.abort();
        reject(new Error('Analysis timeout'));
      },timeoutMs);}),
    ]);
    return validateAnalysisResult(output,input,{mode});
  } catch {
    return {...fallback, warnings:[mode === 'remote' ? REMOTE_FALLBACK_WARNING : LOCAL_WARNING, FALLBACK_WARNING]};
  } finally { clearTimeout(timeout); controller.abort(); }
}
