/*
 * Проверка userscript'а без браузера: jsdom + подставные GitHub и Stepik.
 *
 *   cd Stepik-Fast-Complete
 *   NODE_PATH="C:/Users/Max/.workbuddy-ai/binaries/node/workspace/node_modules" \
 *     "C:/Users/Max/.workbuddy-ai/binaries/node/versions/22.22.2-3/node.exe" test/harness.js
 *
 * Требует jsdom в управляемой сборке Node (см. навык stepik-gist-userscript).
 */
/*
 * Оффлайн-прогон userscript'а в jsdom с подставными GitHub и Stepik.
 * Проверяем: автосохранение в гист, чтение списка файлов, вставку в редактор.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'stepik-gist-sync.user.js'), 'utf8');

const GIST_ID = '7acba5794d6d2354921bee99ac31fe23';
const LESSON = 1793281;
const STEP_IDS = Array.from({ length: 10 }, (_, i) => 101 + i); // позиция 8 → 108

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond });
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '   ' + (extra === undefined ? '' : extra)));
}

function makeFetch(state) {
  const H = { get: (k) => (k.toLowerCase() === 'x-ratelimit-reset' ? String(state.resetAt) : null) };
  const ok = (body) => ({ ok: true, status: 200, headers: H, json: async () => body, text: async () => JSON.stringify(body) });
  const bad = (status, message) => ({
    ok: false, status, headers: H,
    json: async () => ({ message }), text: async () => JSON.stringify({ message })
  });

  return async function (url, init) {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    state.calls.push(method + ' ' + u);

    if (state.rateLimit) return bad(403, 'API rate limit exceeded for user ID 114867406.');

    if (u.startsWith('https://api.github.com/user')) return ok({ login: 'NOTyeamu' });

    if (u === 'https://api.github.com/gists' && method === 'POST') {
      state.created = JSON.parse(init.body);
      state.files = Object.assign({}, state.created.files);
      return ok({ id: 'newgist123', owner: { login: 'NOTyeamu' }, files: state.files });
    }

    if (u.startsWith('https://api.github.com/gists/')) {
      const target = u.split('/gists/')[1];
      if (method === 'PATCH') {
        if ((state.forbidPatch || state.forbidRead) && target === GIST_ID) return bad(403, 'Forbidden');
        const body = JSON.parse(init.body);
        state.patched.push({ target, body });
        for (const [name, f] of Object.entries(body.files)) state.files[name] = f;
        return ok({ id: target, owner: { login: 'NOTyeamu' }, files: state.files });
      }
      if (state.forbidPatch && target === GIST_ID) return bad(403, 'Forbidden');
      if (state.forbidRead && target === GIST_ID) return bad(404, 'Not Found');
      return ok({ id: target, owner: { login: 'NOTyeamu' }, files: state.files });
    }

    if (u.includes('/api/lessons?ids')) {
      return ok({ lessons: [{ id: LESSON, steps: state.emptyLessonSteps ? [] : STEP_IDS }] });
    }
    if (u.includes('/api/users/me')) return ok({ users: [{ id: 42 }] });
    if (u.includes('/api/submissions')) {
      const step = Number(/step=(\d+)/.exec(u)[1]);
      return ok({ submissions: state.submissions.filter((s) => s.step === step) });
    }
    if (u.includes('/api/steps/')) return ok({ steps: [{ id: 108, lesson: LESSON, position: 8 }] });

    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };
}

function run({ url, files, submissions, html, forbidPatch, forbidRead, emptyLessonSteps, rateLimit, waitMs, afterRun }) {
  return new Promise((resolve, reject) => {
    const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
    const { window } = dom;
    const state = {
      calls: [], patched: [], files: Object.assign({}, files), submissions,
      created: null, setValue: null, storage: {},
      forbidPatch: !!forbidPatch, forbidRead: !!forbidRead,
      emptyLessonSteps: !!emptyLessonSteps, rateLimit: !!rateLimit,
      resetAt: Math.floor(Date.now() / 1000) + 900
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
      'HTMLTextAreaElement', 'HTMLInputElement',
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
      window.HTMLTextAreaElement, window.HTMLInputElement,
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

const CODE_ANSWER = { id: 5, step: 108, user: 42, status: 'correct', reply: { code: 'Console.WriteLine(1);', language: 'csharp' } };

(async () => {
  console.log('\n=== 1. автосохранение зачтённого шага ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    files: {}, submissions: [CODE_ANSWER], html: HTML, waitMs: 3200,
    afterRun: async (win, st) => {
      check('сделан ровно один PATCH в гист', st.patched.length === 1, st.patched.length);
      const files = st.patched[0] && st.patched[0].body.files;
      const name = files && Object.keys(files)[0];
      check('имя файла stepik_l1793281_s8.cs', name === 'stepik_l1793281_s8.cs', name);
      check('содержимое = код из API Stepik',
        name && files[name].content === 'Console.WriteLine(1);', name && files[name].content);
      check('файла-индекса больше нет', files && !('_stepik_index.json' in files));
      check('id шага взят из /api/lessons', st.calls.some((c) => c.includes('/api/lessons?ids')));
      check('фильтр по своим отправкам (/api/users/me)', st.calls.some((c) => c.includes('/api/users/me')));
    }
  });

  console.log('\n=== 2. шаг уже есть в гисте → скоба и вставка ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    files: { [`stepik_l${LESSON}_s8.cs`]: { content: 'int x = 41 + 1;' } },
    submissions: [CODE_ANSWER], html: HTML, waitMs: 2600,
    afterRun: async (win, st) => {
      const chip = win.document.querySelector('#sgx-chip');
      check('скоба показана', chip && chip.classList.contains('on'));
      check('подпись «есть решение»', chip && chip.querySelector('.sgx-label').textContent === 'есть решение');
      check('повторно в гист не пишем', st.patched.length === 0, st.patched.length);

      chip.querySelector('.sgx-act.yes').click();
      await new Promise((r) => setTimeout(r, 800));
      check('решение вставлено в редактор', st.setValue === 'int x = 41 + 1;', JSON.stringify(st.setValue));
    }
  });

  console.log('\n=== 3. тест с выбором варианта ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/9?unit=1818966`,
    files: {},
    submissions: [{ id: 9, step: 109, user: 42, status: 'correct', reply: { choices: [222] } }],
    html: CHOICE_HTML, waitMs: 3200,
    afterRun: async (win, st) => {
      const files = st.patched[0] && st.patched[0].body.files;
      const name = files && Object.keys(files)[0];
      check('имя файла .json', name === 'stepik_l1793281_s9.json', name);
      const data = name && JSON.parse(files[name].content);
      check('сохранён id варианта', data && data.ids && data.ids[0] === 222, JSON.stringify(data));
      check('текст варианта подтянут из DOM', data && data.answers[0] === 'второй', JSON.stringify(data && data.answers));
    }
  });

  console.log('\n=== 4. гист чужой (PATCH 403) → личный гист ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    files: {}, submissions: [CODE_ANSWER], html: HTML, forbidPatch: true, waitMs: 3400,
    afterRun: async (win, st) => {
      check('создан новый гист', !!st.created, JSON.stringify(st.created && Object.keys(st.created.files)));
      check('запись ушла в личный гист',
        st.patched.some((p) => p.target === 'newgist123' && p.body.files['stepik_l1793281_s8.cs']),
        JSON.stringify(st.patched.map((p) => p.target)));
    }
  });

  console.log('\n=== 4б. гист вообще не читается (404) → личный гист ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    files: {}, submissions: [CODE_ANSWER], html: HTML, forbidRead: true, waitMs: 3400,
    afterRun: async (win, st) => {
      check('создан новый гист', !!st.created);
      check('запись ушла в личный гист',
        st.patched.some((p) => p.target === 'newgist123'), JSON.stringify(st.patched.map((p) => p.target)));
    }
  });

  console.log('\n=== 5. вставка ответа теста ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/9?unit=1818966`,
    files: {
      [`stepik_l${LESSON}_s9.json`]: { content: JSON.stringify({ type: 'choice', ids: [333], answers: ['третий'] }) }
    },
    submissions: [], html: CHOICE_HTML, waitMs: 2600,
    afterRun: async (win) => {
      const chip = win.document.querySelector('#sgx-chip');
      check('скоба для теста показана', chip && chip.classList.contains('on'));
      check('подпись «есть ответ»', chip && chip.querySelector('.sgx-label').textContent === 'есть ответ');
      chip.querySelector('.sgx-act.yes').click();
      await new Promise((r) => setTimeout(r, 800));
      const inputs = win.document.querySelectorAll('input');
      check('нужный вариант отмечен', inputs[2].checked === true,
        [inputs[0].checked, inputs[1].checked, inputs[2].checked].join(','));
    }
  });

  console.log('\n=== 6. список шагов в API пуст → id шага берём из запроса Stepik ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    files: {}, submissions: [CODE_ANSWER], html: HTML, emptyLessonSteps: true, waitMs: 3400,
    afterRun: async (win, st) => {
      win.document.dispatchEvent(new win.CustomEvent('sgx:net', {
        detail: { url: 'https://stepik.org/api/submissions?step=108&order=desc' }
      }));
      await new Promise((r) => setTimeout(r, 2000));
      check('id шага проверен через /api/steps', st.calls.some((c) => c.includes('/api/steps/108')),
        st.calls.join(' | '));
      check('запрос отправок сделан по этому id',
        st.calls.some((c) => c.includes('/api/submissions?step=108')));
      const files = st.patched[0] && st.patched[0].body.files;
      check('ответ сохранён', files && files['stepik_l1793281_s8.cs'] &&
        files['stepik_l1793281_s8.cs'].content === 'Console.WriteLine(1);');
    }
  });

  console.log('\n=== 7. ответ ловится прямо из отправки (тело запроса) ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    files: {}, submissions: [], html: HTML, emptyLessonSteps: true, waitMs: 3400,
    afterRun: async (win, st) => {
      win.document.dispatchEvent(new win.CustomEvent('sgx:net', {
        detail: {
          url: 'https://stepik.org/api/attempts?step=108',
          body: JSON.stringify({ submissions: [CODE_ANSWER] })
        }
      }));
      await new Promise((r) => setTimeout(r, 2000));
      const files = st.patched[0] && st.patched[0].body.files;
      check('ответ сохранён из перехвата', files && files['stepik_l1793281_s8.cs'] &&
        files['stepik_l1793281_s8.cs'].content === 'Console.WriteLine(1);',
        JSON.stringify(files && Object.keys(files)));
    }
  });

  console.log('\n=== 8. лимит запросов GitHub (403 rate limit) ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    files: {}, submissions: [CODE_ANSWER], html: HTML, rateLimit: true, waitMs: 4200,
    afterRun: async (win, st) => {
      const ghCalls = st.calls.filter((c) => c.includes('api.github.com'));
      check('личный гист НЕ создаётся из-за лимита', st.created === null);
      check('повторы не долбят API (≤4 запроса к GitHub)', ghCalls.length <= 4, ghCalls.length + ': ' + ghCalls.join(' | '));
      const t = win.document.querySelector('#sgx-toast');
      check('пользователю сказано про лимит', t && /лимит запросов/.test(t.textContent), t && t.textContent);
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== ИТОГ: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено ===');
  if (failed.length) { console.log('ПРОВАЛЫ: ' + failed.map((f) => f.name).join('; ')); process.exit(1); }
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
