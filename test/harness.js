/*
 * Проверка userscript'а без браузера: jsdom + подставные GitHub (папка answers/
 * и запуск workflow) и Stepik.
 *
 *   cd Stepik-Fast-Complete
 *   NODE_PATH="C:/Users/Max/.workbuddy-ai/binaries/node/workspace/node_modules" \
 *     "C:/Users/Max/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe" test/harness.js
 *
 * Требует jsdom в управляемой сборке Node (см. навык stepik-gist-userscript).
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'stepik-gist-sync.user.js'), 'utf8');

const REPO = 'NOTyeamu/Stepik-Fast-Complete';
const RAW = `https://raw.githubusercontent.com/${REPO}/main/answers/`;
const INBOX_PUT = `https://api.github.com/repos/${REPO}/contents/inbox/`;
const LESSON = 1793281;
const STEP_IDS = Array.from({ length: 10 }, (_, i) => 101 + i); // позиция 8 → 108

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '   ' + (extra === undefined ? '' : extra)));
}

const CODE_ANSWER = { id: 5, step: 108, user: 42, status: 'correct', reply: { code: 'Console.WriteLine(1);', language: 'csharp' } };

function makeFetch(state) {
  const ok = (body, type) => ({
    ok: true, status: 200,
    json: async () => body,
    text: async () => (type === 'json' ? JSON.stringify(body) : String(body))
  });
  const fail = (status) => ({ ok: false, status, text: async () => '{"message":"boom"}' });

  return async function (url, init) {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    state.calls.push(method + ' ' + u.replace(RAW, '<raw>/').replace(INBOX_PUT, '<inbox>/'));

    /* --- папка answers/ --- */
    if (u.startsWith(RAW)) {
      if (state.storeDown) return fail(500);
      const name = decodeURIComponent(u.slice(RAW.length).split('?')[0]);
      if (name === 'index.json') {
        const index = {};
        for (const key of Object.keys(state.store)) {
          const it = state.store[key];
          index[key] = { file: it.file, ext: it.ext, kind: it.kind };
        }
        return ok(index, 'json');
      }
      const hit = Object.values(state.store).find((it) => it.file === name);
      if (!hit) return fail(404);
      return ok(hit.content);
    }

    /* --- очередь inbox/ (её потом разбирает робот) --- */
    if (u.startsWith(INBOX_PUT)) {
      if (state.storeDown) return fail(500);
      if (!(init && init.headers && /^Bearer .+/.test(init.headers.Authorization || ''))) return fail(401);
      const name = decodeURIComponent(u.slice(INBOX_PUT.length));
      if (state.inbox[name]) return fail(422);
      const body = JSON.parse(init.body);
      state.inbox[name] = Buffer.from(body.content, 'base64').toString('utf8');
      state.inboxMessages.push(body.message);
      return { ok: true, status: 201, text: async () => '{}' };
    }

    /* --- проверка токена в отчёте --- */
    if (u === `https://api.github.com/repos/${REPO}`) return state.storeDown ? fail(500) : ok({}, 'json');

    /* --- Stepik --- */
    if (u.includes('/api/lessons?ids')) {
      return ok({ lessons: [{ id: LESSON, steps: state.emptyLessonSteps ? [] : STEP_IDS }] }, 'json');
    }
    if (u.includes('/api/users/me')) return ok({ users: [{ id: 42, full_name: 'Тестовый Студент' }] }, 'json');
    if (u.includes('/api/submissions')) {
      const step = Number(/step=(\d+)/.exec(u)[1]);
      return ok({ submissions: state.submissions.filter((s) => s.step === step) }, 'json');
    }
    if (u.includes('/api/steps/')) return ok({ steps: [{ id: 108, lesson: LESSON, position: 8 }] }, 'json');

    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };
}

function run({ url, store, submissions, html, storeDown, emptyLessonSteps, token, waitMs, afterRun }) {
  return new Promise((resolve, reject) => {
    const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
    const { window } = dom;
    const state = {
      calls: [], inbox: {}, inboxMessages: [], store: Object.assign({}, store || {}), submissions: submissions || [],
      storeDown: !!storeDown, emptyLessonSteps: !!emptyLessonSteps,
      setValue: null, storage: { writeToken: token === undefined ? 'github_pat_11TEST' : token }
    };

    window.Element.prototype.getBoundingClientRect = function () {
      return { width: 600, height: 200, top: 100, left: 50, right: 650, bottom: 300, x: 50, y: 100 };
    };
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get: () => 120, configurable: true });

    const cmNode = window.document.querySelector('.CodeMirror');
    if (cmNode) {
      cmNode.CodeMirror = {
        getValue: () => (state.setValue == null ? '' : state.setValue),
        setValue: (v) => { state.setValue = v; },
        getOption: () => 'text/x-csharp',
        refresh() {}, focus() {}
      };
    }

    const fn = new Function(
      'window', 'document', 'location', 'fetch', 'console', 'navigator',
      'GM_getValue', 'GM_setValue', 'GM_addStyle', 'GM_registerMenuCommand',
      'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent',
      'HTMLTextAreaElement', 'HTMLInputElement', 'TextEncoder', 'btoa',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      SCRIPT
    );

    const timers = [];
    fn(
      window, window.document, window.location, makeFetch(state), console, window.navigator,
      (k, d) => (k in state.storage ? state.storage[k] : d),
      (k, v) => { state.storage[k] = v; },
      () => {}, () => {},
      window.CustomEvent, window.Event, window.KeyboardEvent, window.MouseEvent,
      window.HTMLTextAreaElement, window.HTMLInputElement, TextEncoder, btoa,
      (f, ms) => { const t = setTimeout(f, ms); timers.push(t); return t; },
      clearTimeout,
      (f, ms) => { const t = setInterval(f, ms); timers.push(t); return t; },
      clearInterval
    );

    setTimeout(async () => {
      try {
        await afterRun(window, state);
        timers.forEach(clearInterval);
        dom.window.close();
        resolve(state);
      } catch (e) { reject(e); }
    }, waitMs);
  });
}

const HTML = `<!doctype html><html><body>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="CodeMirror"><textarea></textarea></div>
  </div></div>
</body></html>`;

const CHOICE_HTML = `<!doctype html><html><body>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="quiz-component" data-type="choice-quiz">
      <label><input type="radio" value="111"> первый</label>
      <label><input type="radio" value="222"> второй</label>
      <label><input type="radio" value="333"> третий</label>
    </div>
  </div></div></body></html>`;

(async () => {
  console.log('\n=== 1. автосохранение зачтённого шага ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [CODE_ANSWER], html: HTML, waitMs: 3200,
    afterRun: async (win, st) => {
      const names = Object.keys(st.inbox);
      check('в очередь положен ровно один файл', names.length === 1, names.join(','));
      check('имя l1793281_s8.cs', names[0] === 'l1793281_s8.cs', names[0]);
      check('содержимое = код из API Stepik', st.inbox['l1793281_s8.cs'] === 'Console.WriteLine(1);',
        st.inbox['l1793281_s8.cs']);
      check('в answers/ скрипт не пишет', !st.calls.some((c) => c.includes('/contents/answers/')),
        st.calls.join(' | '));
      check('в сообщении коммита есть автор', /Тестовый Студент/.test(st.inboxMessages[0] || ''),
        st.inboxMessages[0]);
      check('шаг сразу попал в локальный список', st.storage.index &&
        JSON.parse(st.storage.index).items.l1793281_s8 !== undefined);
    }
  });

  console.log('\n=== 2. ответ уже в папке → скоба и вставка ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int x = 41 + 1;' } },
    submissions: [CODE_ANSWER], html: HTML, waitMs: 2600,
    afterRun: async (win, st) => {
      const chip = win.document.querySelector('#sgx-chip');
      check('скоба показана', chip && chip.classList.contains('on'));
      check('подпись «есть решение»', chip && chip.querySelector('.sgx-label').textContent === 'есть решение');
      check('повторно не пишем', Object.keys(st.inbox).length === 0, Object.keys(st.inbox).join(','));

      chip.querySelector('.sgx-act.yes').click();
      await new Promise((r) => setTimeout(r, 800));
      check('решение вставлено в редактор', st.setValue === 'int x = 41 + 1;', JSON.stringify(st.setValue));
      check('файл запрошен из папки', st.calls.some((c) => c.includes('<raw>/l1793281_s8.cs')));
    }
  });

  console.log('\n=== 3. тест с выбором варианта ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/9?unit=1818966`,
    store: {},
    submissions: [{ id: 9, step: 109, user: 42, status: 'correct', reply: { choices: [222] } }],
    html: CHOICE_HTML, waitMs: 3200,
    afterRun: async (win, st) => {
      const name = Object.keys(st.inbox)[0];
      check('имя l1793281_s9.json', name === 'l1793281_s9.json', name);
      const data = name && JSON.parse(st.inbox[name]);
      check('id варианта сохранён', data && data.ids[0] === 222, JSON.stringify(data));
      check('текст варианта подтянут из DOM', data && data.answers[0] === 'второй', JSON.stringify(data && data.answers));
    }
  });

  console.log('\n=== 4. вставка ответа теста ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/9?unit=1818966`,
    store: {
      l1793281_s9: {
        file: 'l1793281_s9.json', ext: 'json', kind: 'choice',
        content: JSON.stringify({ type: 'choice', ids: [333], answers: ['третий'] })
      }
    },
    submissions: [], html: CHOICE_HTML, waitMs: 2600,
    afterRun: async (win) => {
      const chip = win.document.querySelector('#sgx-chip');
      check('подпись «есть ответ»', chip && chip.querySelector('.sgx-label').textContent === 'есть ответ');
      chip.querySelector('.sgx-act.yes').click();
      await new Promise((r) => setTimeout(r, 800));
      const inputs = win.document.querySelectorAll('input');
      check('нужный вариант отмечен', inputs[2].checked === true,
        [inputs[0].checked, inputs[1].checked, inputs[2].checked].join(','));
    }
  });

  console.log('\n=== 5. список шагов в API пуст → id шага из запроса Stepik ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [CODE_ANSWER], html: HTML, emptyLessonSteps: true, waitMs: 3400,
    afterRun: async (win, st) => {
      win.document.dispatchEvent(new win.CustomEvent('sgx:net', {
        detail: { url: 'https://stepik.org/api/submissions?step=108&order=desc' }
      }));
      await new Promise((r) => setTimeout(r, 2000));
      check('id шага проверен через /api/steps', st.calls.some((c) => c.includes('/api/steps/108')));
      check('ответ записан', st.inbox['l1793281_s8.cs'] === 'Console.WriteLine(1);',
        Object.keys(st.inbox).join(','));
    }
  });

  console.log('\n=== 6. ответ ловится прямо из отправки ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: HTML, emptyLessonSteps: true, waitMs: 3400,
    afterRun: async (win, st) => {
      win.document.dispatchEvent(new win.CustomEvent('sgx:net', {
        detail: {
          url: 'https://stepik.org/api/attempts?step=108',
          body: JSON.stringify({ submissions: [CODE_ANSWER] })
        }
      }));
      await new Promise((r) => setTimeout(r, 2000));
      check('ответ записан из перехвата', st.inbox['l1793281_s8.cs'] === 'Console.WriteLine(1);',
        Object.keys(st.inbox).join(','));
    }
  });

  console.log('\n=== 7. GitHub недоступен → не долбим его ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [CODE_ANSWER], html: HTML, storeDown: true, waitMs: 4200,
    afterRun: async (win, st) => {
      const storeCalls = st.calls.filter((c) => c.includes('<raw>') || c.includes('<inbox>'));
      check('запросов к GitHub мало (≤4)', storeCalls.length <= 4,
        storeCalls.length + ': ' + storeCalls.join(' | '));
      const t = win.document.querySelector('#sgx-toast');
      check('пользователю показана ошибка', t && /Не сохранилось/.test(t.textContent), t && t.textContent);
    }
  });

  console.log('\n=== 8. без токена ответы не пишутся, но читаются ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int x = 1;' } },
    submissions: [CODE_ANSWER], html: HTML, token: '', waitMs: 2600,
    afterRun: async (win, st) => {
      const chip = win.document.querySelector('#sgx-chip');
      check('скоба всё равно показана', chip && chip.classList.contains('on'));
      check('в очередь ничего не попало', Object.keys(st.inbox).length === 0);
      const t = win.document.querySelector('#sgx-toast');
      check('сказано про токен', t && /токен записи/.test(t.textContent), t && t.textContent);
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== ИТОГ: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено ===');
  if (failed.length) { console.log('ПРОВАЛЫ: ' + failed.map((f) => f.name).join('; ')); process.exit(1); }
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
