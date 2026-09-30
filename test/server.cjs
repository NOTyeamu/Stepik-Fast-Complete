/*
 * Проверка серверной части (server/apps-script.gs) без Google.
 *
 * Код Apps Script иначе вообще никак не проверяется: развернуть его можно только
 * руками в браузере, а ошибка в счётчике или в лимите вылезла бы уже у людей.
 * Поэтому подставляем заглушки сервисов Google и гоняем логику прокси как есть.
 *
 * Запуск:  node test/server.cjs
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'apps-script.gs'), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, got) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (got === undefined ? '' : '   ' + got)); }
}

/* --- заглушки сервисов Google --------------------------------------------- */
function makeEnv() {
  const props = {};
  const env = {
    props,
    lastFetch: null,
    fetchCode: 200,
    fetchBody: '{"choices":[{"message":{"content":"ok"}}]}',
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperties: (o) => { Object.keys(o).forEach((k) => { props[k] = o[k]; }); }
      })
    },
    LockService: {
      getScriptLock: () => ({
        waitLock() {}, tryLock() { return true; }, releaseLock() {}
      })
    },
    Utilities: { formatDate: (d) => new Date(d).toISOString().slice(0, 10) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({
        text: t, mime: null,
        setMimeType(m) { this.mime = m; return this; }
      })
    },
    UrlFetchApp: {
      fetch: (url, opts) => {
        env.lastFetch = { url, opts };
        return {
          getResponseCode: () => env.fetchCode,
          getContentText: () => env.fetchBody
        };
      }
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: () => null,
        insertSheet: () => ({
          appendRow() {}, setFrozenRows() {}, getLastRow: () => 1,
          getRange: () => ({ setValues() {} }),
          getDataRange: () => ({ getValues: () => [[]] })
        })
      })
    },
    console
  };
  return env;
}

function load(env) {
  const names = ['PropertiesService', 'LockService', 'Utilities', 'ContentService',
    'UrlFetchApp', 'SpreadsheetApp', 'console'];
  const body = SRC + '\nreturn { aiQuota: aiQuota, aiProxy: aiProxy, doGet: doGet, doPost: doPost };';
  return new Function(names.join(','), body).apply(null, names.map((n) => env[n]));
}

function body(env) {
  return JSON.parse(env.lastFetch.opts.payload);
}

console.log('=== СУТОЧНЫЙ СЧЁТЧИК ===');
{
  const env = makeEnv();
  const api = load(env);
  check('в начале суток счётчик пуст', api.aiQuota(false).used === 0,
    String(api.aiQuota(false).used));
  api.aiQuota(true);
  api.aiQuota(true);
  check('счётчик растёт', api.aiQuota(false).used === 2, String(api.aiQuota(false).used));
  check('предел по умолчанию — 300', api.aiQuota(false).limit === 300,
    String(api.aiQuota(false).limit));

  env.props.AI_DAY = '2000-01-01';
  check('новый день — счётчик обнулился', api.aiQuota(false).used === 0,
    String(api.aiQuota(false).used));
}

console.log('\n=== СВОЙ ПРЕДЕЛ ===');
{
  const env = makeEnv();
  env.props.AI_DAILY_LIMIT = '5';
  const api = load(env);
  check('предел берётся из свойств', api.aiQuota(false).limit === 5,
    String(api.aiQuota(false).limit));
}

console.log('\n=== КЛЮЧ НЕ ЗАДАН ===');
{
  const env = makeEnv();
  const api = load(env);
  const r = api.aiProxy({ model: 'm', messages: [] });
  check('без AI_KEY отвечаем ошибкой', r.status === 500, String(r.status));
  check('и в запрос к провайдеру не идём', env.lastFetch === null, 'запрос ушёл');
}

console.log('\n=== ЛИМИТ ДОХОДИТ ДО ЗАПРОСА ===');
{
  const env = makeEnv();
  env.props.AI_KEY = 'sk-test';
  env.props.AI_DAY = new Date().toISOString().slice(0, 10);
  env.props.AI_USED = '300';
  const api = load(env);
  const r = api.aiProxy({ model: 'm', messages: [] });
  check('при исчерпанном лимите отвечаем 429', r.status === 429, String(r.status));
  check('в теле сказано про суточный лимит', /суточный лимит/.test(r.text), r.text.slice(0, 60));
  check('запрос к провайдеру не ушёл', env.lastFetch === null, 'запрос ушёл');
}

console.log('\n=== УДАЧНЫЙ ЗАПРОС ===');
{
  const env = makeEnv();
  env.props.AI_KEY = 'sk-test';
  const api = load(env);
  const r = api.aiProxy({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'привет' }], max_tokens: 100 });
  check('ответ провайдера вернулся как есть', r.status === 200 && /choices/.test(r.text), r.text.slice(0, 40));
  check('запрос ушёл на адрес провайдера', /chat\/completions/.test(env.lastFetch.url), env.lastFetch.url);
  check('ключ подставлен на сервере', /^Bearer sk-test$/.test(env.lastFetch.opts.headers.Authorization),
    String(env.lastFetch.opts.headers.Authorization));
  check('в теле ушла модель и сообщения',
    body(env).model === 'deepseek-v4-pro' && body(env).messages.length === 1,
    JSON.stringify(body(env).model));
  check('удачный запрос попал в счётчик', api.aiQuota(false).used === 1,
    String(api.aiQuota(false).used));
}

console.log('\n=== НЕУДАЧНЫЙ ЗАПРОС НЕ СЧИТАЕТСЯ ===');
{
  const env = makeEnv();
  env.props.AI_KEY = 'sk-test';
  env.fetchCode = 429;
  env.fetchBody = '{"error":{"message":"лимит"}}';
  const api = load(env);
  const r = api.aiProxy({ model: 'm', messages: [] });
  check('код провайдера доехал', r.status === 429, String(r.status));
  check('в счётчик не попал', api.aiQuota(false).used === 0, String(api.aiQuota(false).used));
}

console.log('\n=== САМОПРОВЕРКА ?ai=1 ===');
{
  const env = makeEnv();
  const api = load(env);
  const noKey = JSON.parse(api.doGet({ parameter: { ai: '1' } }).text);
  check('без ключа говорит ai: false', noKey.ai === false, JSON.stringify(noKey.ai));
  check('и подсказывает, что делать', /AI_KEY/.test(noKey.hint), noKey.hint);

  env.props.AI_KEY = 'sk-test';
  const withKey = JSON.parse(api.doGet({ parameter: { ai: '1' } }).text);
  check('с ключом говорит ai: true', withKey.ai === true, JSON.stringify(withKey.ai));
  check('показывает расход за сутки', withKey.usedToday === 0 && withKey.dailyLimit === 300,
    JSON.stringify(withKey));
  check('сам ключ не показывает', !/sk-test/.test(JSON.stringify(withKey)),
    JSON.stringify(withKey));
}

console.log('\n=== ПРОКСИ НЕ ЛОМАЕТ ХРАНИЛИЩЕ ОТВЕТОВ ===');
{
  const env = makeEnv();
  env.props.AI_KEY = 'sk-test';
  const api = load(env);
  /* POST с ответом — это по-прежнему запись в таблицу, а не запрос к ИИ */
  const r = api.doPost({
    postData: { contents: JSON.stringify({ items: [{ key: 'l1_s1', content: 'x' }] }) }
  });
  const out = JSON.parse(r.text);
  check('обычная запись ответа работает', out.ok === true, r.text.slice(0, 60));
  check('и в ИИ при этом не ходили', env.lastFetch === null, 'ушёл запрос к ИИ');
}

console.log('\n=== ИТОГ: ' + pass + '/' + (pass + fail) + ' проверок пройдено ===');
if (fail) { console.log('ПРОВАЛЫ: ' + fail); process.exit(1); }
process.exit(0);
