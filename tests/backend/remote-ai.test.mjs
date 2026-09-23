import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApplication } from '../../server.mjs';
import { FIELDS } from '../../src/domain.mjs';
import { analyzeTask, FALLBACK_WARNING, REMOTE_WARNING } from '../../src/ai/analyze.mjs';
import { loadAIConfig } from '../../src/ai/config.mjs';
import { createOpenAIAnalysisOptions, DEFAULT_OPENAI_MODEL } from '../../src/ai/openai.mjs';
import { temporaryDirectory } from './helpers.mjs';

const FAKE_KEY = 'fake-test-only-never-a-real-api-key';
const PRIVATE_DIAGNOSTIC = 'provider-private-diagnostic-for-test';
const input = {
  raw: 'Заявки клиентов теряются в разных чатах.', industry: 'Услуги',
  fields: {context: '', data: 'Старые примеры', contact: 'Контакт человека'},
  answers: {data: ' Новые примеры ', contact: ' '},
};
const questions = [
  {field: 'need', question: 'В каком месте обработки заявка теряется?', reason: 'Нужно определить проблему.'},
  {field: 'success', question: 'Как вы проверите, что заявки больше не теряются?', reason: 'Нужен критерий приёмки.'},
  {field: 'result', question: 'Что команда должна передать для проверки?', reason: 'Нужно согласовать результат.'},
];
const envelope = (value = {questions}) => ({
  status: 'completed',
  output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: JSON.stringify(value)}]}],
});
const providerResponse = (value = envelope()) => new Response(JSON.stringify(value), {
  headers: {'Content-Type': 'application/json'},
});
const remoteOptions = (fetchImpl, extra = {}) => createOpenAIAnalysisOptions({apiKey: FAKE_KEY, fetchImpl, ...extra});

function assertRetainedFacts(result) {
  assert.equal(result.fields.context, '');
  assert.equal(result.fields.data, 'Новые примеры');
  assert.equal(result.fields.contact, 'Контакт человека');
  assert.deepEqual(Object.keys(result.fields), FIELDS.map(field => field.key));
  assert.equal(result.rating, undefined);
  assert.equal(result.confirmedFields, undefined);
  assert.equal(result.published, undefined);
}

function assertFallback(result) {
  assert.equal(result.mode, 'local');
  assert.ok(result.warnings.includes(FALLBACK_WARNING));
  assert.ok(result.questions.length >= 3);
  assertRetainedFacts(result);
  assert.equal(result.warnings.some(warning => warning.includes('не вызывалась')), false,
    'Fallback after a remote attempt must not claim that no external model was called');
  assert.equal(JSON.stringify(result).includes(PRIVATE_DIAGNOSTIC), false);
  assert.equal(JSON.stringify(result).includes(FAKE_KEY), false);
}

async function httpSetup(t, analysisOptions) {
  const file = join(await temporaryDirectory(t), 'db.json');
  const app = await createApplication({dataFile: file, analysisOptions});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    const closed = new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
    app.server.closeAllConnections();
    await closed;
  });
  return {app, file, url: `http://127.0.0.1:${app.server.address().port}`};
}

const post = (url, body) => fetch(`${url}/api/ai/analyze`, {
  method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
});

test('remote questions use the fixed Responses endpoint, strict schema and server-retained human facts', async () => {
  const before = structuredClone(input);
  let request;
  const options = remoteOptions(async (url, init) => {
    request = {url, init, body: JSON.parse(init.body)};
    return providerResponse();
  });
  assert.equal(options.timeoutMs, 15000);
  const result = await analyzeTask(input, options);
  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.equal(request.body.model, DEFAULT_OPENAI_MODEL);
  assert.equal(request.body.store, false);
  assert.equal(request.body.max_output_tokens, 3000);
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.equal(request.body.text.format.strict, true);
  const schema = request.body.text.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['questions']);
  assert.equal(schema.properties.questions.minItems, 3);
  assert.equal(schema.properties.questions.maxItems, 6);
  assert.equal(schema.properties.questions.items.additionalProperties, false);
  assert.deepEqual(schema.properties.questions.items.properties.field.enum, FIELDS.map(field => field.key));
  const sentInput = JSON.parse(request.body.input);
  assert.equal(sentInput.raw, input.raw);
  assert.equal(sentInput.fields.data, 'Новые примеры');
  assert.equal(sentInput.fields.context, '');
  assert.equal(JSON.stringify(request.body).includes(FAKE_KEY), false);
  assert.equal(result.mode, 'remote');
  assert.deepEqual(result.questions, questions);
  assert.deepEqual(result.warnings, [REMOTE_WARNING]);
  assertRetainedFacts(result);
  assert.deepEqual(input, before);
});

test('provider 401, 429 and 500 cancel the error body and fall back without returning diagnostics', async () => {
  for (const status of [401, 429, 500]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(`${PRIVATE_DIAGNOSTIC} ${FAKE_KEY}`)); },
      cancel() { cancelled = true; },
    });
    const result = await analyzeTask(input, remoteOptions(async () => new Response(body, {status})));
    assertFallback(result);
    assert.equal(cancelled, true, `HTTP ${status} body should be cancelled`);
  }
});

test('refusals, incomplete responses and invalid generated schemas safely fall back', async () => {
  const badResponses = [
    {status: 'incomplete', output: envelope().output},
    {status: 'completed', output: [{type: 'message', content: [{type: 'refusal', refusal: PRIVATE_DIAGNOSTIC}]}]},
    {status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: `{${PRIVATE_DIAGNOSTIC}`}]}]},
    envelope({questions, fields: {contact: 'invented@example.com'}}),
    envelope({questions: [questions[0], questions[0], questions[2]]}),
    envelope({questions: [{...questions[0], field: 'unknown'}, questions[1], questions[2]]}),
    envelope({questions: [{...questions[0], question: ' '}, questions[1], questions[2]]}),
    envelope({questions: questions.slice(0, 2)}),
  ];
  for (const value of badResponses) {
    assertFallback(await analyzeTask(input, remoteOptions(async () => providerResponse(value))));
  }
  assertFallback(await analyzeTask(input, remoteOptions(async () => new Response(`<html>${PRIVATE_DIAGNOSTIC}</html>`))));
});

test('response byte limit accepts 64 KiB and cancels oversized declared or chunked responses early', async () => {
  const maxBytes = 64 * 1024;
  const padded = {...envelope(), padding: ''};
  padded.padding = 'x'.repeat(maxBytes - Buffer.byteLength(JSON.stringify(padded)));
  assert.equal(Buffer.byteLength(JSON.stringify(padded)), maxBytes);
  assert.equal((await analyzeTask(input, remoteOptions(async () => providerResponse(padded)))).mode, 'remote');

  for (const declared of [true, false]) {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(pulls === 1 ? maxBytes : 1));
      },
      cancel() { cancelled = true; },
    }, {highWaterMark: 0});
    const headers = declared ? {'Content-Length': String(maxBytes + 1)} : {};
    assertFallback(await analyzeTask(input, remoteOptions(async () => new Response(body, {headers}))));
    assert.equal(cancelled, true);
    assert.equal(pulls, declared ? 0 : 2, 'Do not keep consuming after the limit');
  }
});

test('timeout aborts an in-flight provider request and returns local questions without losing answers', async () => {
  let receivedSignal;
  let aborted = false;
  const options = remoteOptions((_url, {signal}) => {
    receivedSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error(PRIVATE_DIAGNOSTIC));
      }, {once: true});
    });
  }, {timeoutMs: 10});
  assertFallback(await analyzeTask(input, options));
  assert.equal(receivedSignal.aborted, true);
  assert.equal(aborted, true);
});

test('absent or blank API key stays local without fetch, and invalid model configuration is rejected', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('Unexpected provider call'); };
  for (const apiKey of [undefined, '', '   ']) {
    const options = createOpenAIAnalysisOptions({apiKey, fetchImpl});
    assert.equal(options, undefined);
    const result = await analyzeTask(input, options);
    assert.equal(result.mode, 'local');
    assert.equal(result.warnings.includes(FALLBACK_WARNING), false);
    assertRetainedFacts(result);
  }
  assert.equal(calls, 0);
  assert.throws(() => createOpenAIAnalysisOptions({apiKey: FAKE_KEY, model: 'model\r\nInjected: yes', fetchImpl}), /configuration/);
});

test('AI config handles quoted values and comments, prioritizes explicit environment and ignores provider URLs', async t => {
  const filePath = join(await temporaryDirectory(t), '.env');
  await writeFile(filePath, `\uFEFF# Test-only configuration\nOPENAI_API_KEY = "${FAKE_KEY}" # comment\nOPENAI_MODEL = 'gpt-4.1-mini'\nOPENAI_BASE_URL=https://example.invalid/ignored\nUNRELATED_SECRET=ignored\n`);
  const fromFile = await loadAIConfig({filePath, env: {}});
  assert.deepEqual(fromFile, {apiKey: FAKE_KEY, model: 'gpt-4.1-mini'});
  const fromEnv = await loadAIConfig({filePath, env: {OPENAI_API_KEY: ' env-fake-key ', OPENAI_MODEL: ' model-override ', OPENAI_BASE_URL: 'https://example.invalid/env'}});
  assert.deepEqual(fromEnv, {apiKey: 'env-fake-key', model: 'model-override'});
  assert.deepEqual(await loadAIConfig({filePath, env: {OPENAI_API_KEY: '', OPENAI_MODEL: ''}}), {apiKey: '', model: DEFAULT_OPENAI_MODEL});
  await writeFile(filePath, `OPENAI_API_KEY=${FAKE_KEY} # trailing comment\nOPENAI_MODEL=gpt-4.1-mini # trailing comment\n`);
  assert.deepEqual(await loadAIConfig({filePath, env: {}}), fromFile);
});

test('missing config selects local defaults and malformed quoted config never exposes its contents', async t => {
  const directory = await temporaryDirectory(t);
  assert.deepEqual(await loadAIConfig({filePath: join(directory, 'absent.env'), env: {}}), {apiKey: '', model: DEFAULT_OPENAI_MODEL});
  const filePath = join(directory, '.env');
  for (const line of [`OPENAI_API_KEY="${FAKE_KEY}`, `OPENAI_API_KEY='${FAKE_KEY}' unexpected`]) {
    await writeFile(filePath, line);
    await assert.rejects(loadAIConfig({filePath, env: {}}), error => {
      assert.equal(error.message.includes(FAKE_KEY), false);
      assert.match(error.message, /configuration/);
      return true;
    });
  }
});

test('HTTP exposes configured remote mode and remote/fallback analysis never changes memory or database bytes', async t => {
  let fail = false;
  const options = remoteOptions(async () => fail ? new Response(PRIVATE_DIAGNOSTIC, {status: 500}) : providerResponse());
  const {app, file, url} = await httpSetup(t, options);
  const before = app.store.read();
  const diskBefore = await readFile(file);
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.meta.aiMode, 'remote');
  for (fail of [false, true]) {
    const response = await post(url, input);
    assert.equal(response.status, 200);
    const result = await response.json();
    if (fail) assertFallback(result);
    else { assert.equal(result.mode, 'remote'); assertRetainedFacts(result); }
    assert.deepEqual(app.store.read(), before);
    assert.deepEqual(await readFile(file), diskBefore);
  }
});

test('HTTP clients cannot choose provider settings or trigger external calls with invalid input', async t => {
  let calls = 0;
  const {app, file, url} = await httpSetup(t, remoteOptions(async () => { calls += 1; return providerResponse(); }));
  const before = app.store.read();
  const diskBefore = await readFile(file);
  for (const patch of [{apiKey: 'client-key'}, {model: 'client-model'}, {url: 'https://example.invalid'}, {mode: 'remote'}, {fields: {data: 7}}]) {
    const response = await post(url, {...input, ...patch});
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(JSON.stringify(body).includes(FAKE_KEY), false);
  }
  assert.equal(calls, 0);
  assert.deepEqual(app.store.read(), before);
  assert.deepEqual(await readFile(file), diskBefore);
});
