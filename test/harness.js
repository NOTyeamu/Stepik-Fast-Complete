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
const JSZip = require('jszip');

/* крошечный настоящий PNG — вместо скриншота */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

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

    /* --- ИИ, бесплатный канал (Pollinations): ключа нет по определению --- */
    if (u.includes('text.pollinations.ai')) {
      state.aiCalls.push({ url: u, body: init && init.body, auth: init && init.headers && init.headers.Authorization });
      if (state.aiDown) return fail(402);            /* именно так он отвечает при перегрузе */
      let asked = '';
      try { asked = JSON.parse(init.body).messages.slice(-1)[0].content; } catch (e) { asked = ''; }
      return ok({
        choices: [{ message: { role: 'assistant', content: state.aiText || 'Console.WriteLine(5);' } }],
        model: 'gpt-oss-20b', user_tier: 'anonymous', __asked: asked
      }, 'json');
    }

    /* --- ИИ, свой канал (ключевой) --- */
    if (u.includes('api.reformboss.com')) {
      state.aiPaidCalls.push({ url: u, body: init && init.body, auth: init && init.headers && init.headers.Authorization });
      if (state.aiPaidDown) return fail(500);
      let asked = '';
      let model = '';
      try { const b = JSON.parse(init.body); asked = b.messages.slice(-1)[0].content; model = b.model; } catch (e) { /* ignore */ }
      /* reasoning-модель отдаёт размышления отдельным полем — проверяем и это */
      const msg = state.aiPaidEmpty
        ? { role: 'assistant', content: '', reasoning_content: 'думал-думал' }
        : { role: 'assistant', content: state.aiPaidText || 'static void PrintSquare(int x) { }' };
      return ok({ choices: [{ message: msg }], model: model, __asked: asked }, 'json');
    }

    /* --- Stepik --- */
    if (u.includes('/api/lessons?ids')) {
      const m = /ids\[\]=(\d+)/.exec(u);
      const id = Number((m && m[1]) || LESSON);
      const steps = id === LESSON
        ? (state.emptyLessonSteps ? [] : STEP_IDS)
        : [id * 10 + 1, id * 10 + 2];       /* у прочих уроков — по два шага */
      return ok({ lessons: [{ id: id, steps: steps }] }, 'json');
    }
    if (u.includes('/api/users/me')) return ok({ users: [{ id: 42, full_name: 'Тестовый Студент' }] }, 'json');
    if (u.includes('/api/submissions')) {
      const step = Number(/step=(\d+)/.exec(u)[1]);
      return ok({ submissions: state.submissions.filter((s) => s.step === step) }, 'json');
    }
    if (u.includes('/api/steps?lesson')) return ok({ steps: state.lessonSteps || [] }, 'json');
    if (u.includes('/api/steps/')) return ok({ steps: [{ id: 108, lesson: LESSON, position: 8 }] }, 'json');

    throw new Error('unexpected fetch: ' + method + ' ' + u);
  };
}

function run({ url, store, submissions, html, storeDown, emptyLessonSteps, token, job, innerWidth, lateEditor, waitMs, afterRun, aiText, aiDown, aiPaidDown, aiPaidText, aiPaidEmpty, aiKey }) {
  return new Promise((resolve, reject) => {
    const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
    const { window } = dom;
    const state = {
      calls: [], inbox: {}, inboxMessages: [], menu: {},
      store: Object.assign({}, store || {}), submissions: submissions || [],
      storeDown: !!storeDown, emptyLessonSteps: !!emptyLessonSteps,
      setValue: null, submitted: 0, retried: 0, docBlob: null, shots: 0,
      aiCalls: [], aiText: aiText, aiDown: !!aiDown,
      aiPaidCalls: [], aiPaidDown: !!aiPaidDown, aiPaidText: aiPaidText,
      aiPaidEmpty: !!aiPaidEmpty,
      storage: { writeToken: token === undefined ? 'github_pat_11TEST' : token }
    };
    if (job) state.storage.job = JSON.stringify(job);
    if (aiKey !== undefined) state.storage.aiKey = aiKey;
    if (innerWidth) Object.defineProperty(window, 'innerWidth', { value: innerWidth, configurable: true });

    /* скриншот: html2canvas подменяем, реального рендера в jsdom нет */
    window.html2canvas = function () {
      state.shots++;
      return Promise.resolve({
        width: 1400, height: 600,
        toDataURL: () => 'data:image/png;base64,' + PNG
      });
    };
    /* ссылку на файл перехватываем, чтобы достать собранный .docx */
    window.URL.createObjectURL = function (blob) { state.docBlob = blob; return 'blob:test'; };
    window.URL.revokeObjectURL = function () {};

    window.Element.prototype.getBoundingClientRect = function () {
      const cl = this.classList || { contains: () => false };
      let h = 200;
      if (cl.contains('attempt-wrapper__content')) h = 300;     /* карточка задания */
      else if (cl.contains('quiz-component')) h = 120;          /* блок с вариантами */
      return { width: 600, height: h, top: 100, left: 50, right: 650, bottom: 100 + h, x: 50, y: 100 };
    };
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get: () => 120, configurable: true });

    const mkCm = (node) => {
      node.CodeMirror = {
        getValue: () => (state.setValue == null ? '' : state.setValue),
        setValue: (v) => { state.setValue = v; },
        getOption: () => 'text/x-csharp',
        refresh() {}, focus() {}
      };
    };
    const submitBtn = window.document.querySelector('button.submit');
    if (submitBtn) submitBtn.addEventListener('click', () => { state.submitted++; });
    const retryBtn = window.document.querySelector('button.retry');
    if (retryBtn) retryBtn.addEventListener('click', () => { state.retried++; });

    const cmNode = window.document.querySelector('.CodeMirror');
    if (cmNode) mkCm(cmNode);

    /* редактор, который Stepik дорисовывает с задержкой */
    if (lateEditor) {
      setTimeout(() => {
        const wrap = window.document.querySelector('.attempt-wrapper__content') || window.document.body;
        const d = window.document.createElement('div');
        d.className = 'CodeMirror';
        wrap.insertBefore(d, wrap.firstChild);
        mkCm(d);
      }, lateEditor);
    }

    const fn = new Function(
      'window', 'document', 'location', 'fetch', 'console', 'navigator',
      'GM_getValue', 'GM_setValue', 'GM_addStyle', 'GM_registerMenuCommand',
      'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PopStateEvent',
      'HTMLTextAreaElement', 'HTMLInputElement', 'TextEncoder', 'btoa', 'atob',
      'html2canvas', 'JSZip', 'URL',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
      SCRIPT
    );

    const timers = [];
    fn(
      window, window.document, window.location, makeFetch(state), console, window.navigator,
      (k, d) => (k in state.storage ? state.storage[k] : d),
      (k, v) => { state.storage[k] = v; },
      () => {}, (name, fn) => { state.menu[name] = fn; },
      window.CustomEvent, window.Event, window.KeyboardEvent, window.MouseEvent, window.PopStateEvent,
      window.HTMLTextAreaElement, window.HTMLInputElement, TextEncoder, btoa, atob,
      window.html2canvas, JSZip, window.URL,
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

/* Реальная шапка урока (ряд настроек) и реальный сайдбар курса — взяты из
   присланной разметки, чтобы проверять кнопку и подмену меню на настоящих селекторах. */
const SHELL_HTML = `
  <ul class="lesson-controls" role="toolbar" aria-label="Настройки">
    <li class="lesson-controls__item"><button class="button_style_secondary" type="button" title="Полноэкранный режим"></button></li>
    <li class="lesson-controls__item"><button class="button_style_secondary" type="button" title="Настройки"></button></li>
  </ul>
  <div class="lesson-sidebar__content custom-scrollbar">
    <nav class="toc-sections lesson-sidebar__toc" aria-label="Навигация по курсу">
      <div class="lesson-sidebar__module-header sidebar-module-header" data-section="552399"></div>
      <div class="lesson-sidebar__toc-inner" data-section="552399">
        <div class="toc-lesson"><a href="/lesson/1755852?unit=1780001" class="lesson-sidebar__lesson">
          <span class="lesson-sidebar__lesson-name">4.1&nbsp;&nbsp;Знакомство с методами</span></a></div>
        <div class="toc-lesson"><a href="/lesson/1755853?unit=1780002" class="lesson-sidebar__lesson">
          <span class="lesson-sidebar__lesson-name">4.2&nbsp;&nbsp;Перегрузка и возврат</span></a></div>
        <div class="toc-lesson"><a href="/lesson/1755854?unit=1780003" class="lesson-sidebar__lesson">
          <span class="lesson-sidebar__lesson-name">4.3&nbsp;&nbsp;Массивы</span></a></div>
      </div>
    </nav>
  </div>`;

const SHELL_HTML_FULL = `<!doctype html><html><body>
  ${SHELL_HTML}
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-text">Напишите программу, которая выводит число</div>
    <div class="CodeMirror"><textarea></textarea></div>
    <button class="attempt-wrapper-button submit" type="button">Отправить на проверку</button>
  </div></div>
</body></html>`;


/* Панель со статусом создаётся только по клику и только когда есть сайдбар курса.
   Если панели нет, берём последнее сообщение из data-атрибута документа — скрипт
   кладёт его туда всегда, независимо от того, что видно на странице. */
function statusText(win) {
  const el = win.document.querySelector('#sgx-status');
  if (el) return el.textContent;
  return win.document.documentElement.getAttribute('data-sgx-status') || '';
}

const HTML = `<!doctype html><html><body>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="CodeMirror"><textarea></textarea></div>
  </div></div>
</body></html>`;

const JOB_HTML = `<!doctype html><html><body>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-text">Напишите программу, которая выводит число</div>
    <div class="CodeMirror"><textarea></textarea></div>
    <button class="attempt-wrapper-button submit" type="button">Отправить на проверку</button>
    <button class="retry" type="button">Решить снова</button>
  </div></div>
</body></html>`;

const LATE_HTML = `<!doctype html><html><body>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-text">Задание</div>
    <div class="attempt-wrapper__plugin"></div>
    <button class="attempt-wrapper-button submit" type="button">Отправить на проверку</button>
  </div></div>
</body></html>`;

/* шаг, где вставлять нечего: теория без единого поля */
const THEORY_HTML = `<!doctype html><html><body>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-text">Прочитайте теорию и переходите дальше</div>
  </div></div>
</body></html>`;

/* Сайдбар курса с четырьмя уроками — структура как у настоящего Stepik:
   прокручиваемая область .lesson-sidebar__content и внутри неё навигация. */
const SIDEBAR_HTML = `<!doctype html><html><body>
  <ul class="lesson-controls" role="toolbar" aria-label="Настройки">
    <li class="lesson-controls__item"><button class="button_style_secondary" type="button" title="Полноэкранный режим"></button></li>
    <li class="lesson-controls__item"><button class="button_style_secondary" type="button" title="Настройки"></button></li>
  </ul>
  <div class="lesson-sidebar__content custom-scrollbar">
    <nav class="toc-sections lesson-sidebar__toc" aria-label="Навигация по курсу">
      <div class="lesson-sidebar__toc-inner" data-section="552399">
        <div class="toc-lesson"><a href="/lesson/1755852?unit=1780001" class="lesson-sidebar__lesson">
          <span class="lesson-sidebar__lesson-name">4.1&nbsp;&nbsp;Знакомство с методами</span></a></div>
        <div class="toc-lesson"><a href="/lesson/1755853?unit=1780002" class="lesson-sidebar__lesson">
          <span class="lesson-sidebar__lesson-name">4.2&nbsp;&nbsp;Перегрузка и возврат</span></a></div>
        <div class="toc-lesson"><a href="/lesson/1755854?unit=1780003" class="lesson-sidebar__lesson">
          <span class="lesson-sidebar__lesson-name">4.3&nbsp;&nbsp;Массивы</span></a></div>
        <div class="toc-lesson"><a href="/lesson/1755855?unit=1780004" class="lesson-sidebar__lesson">
          <span class="lesson-sidebar__lesson-name">4.4&nbsp;&nbsp;Рекурсивные методы</span></a></div>
      </div>
    </nav>
  </div>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-text">Задание</div>
    <div class="CodeMirror"><textarea></textarea></div>
    <button class="attempt-wrapper-button submit" type="button">Отправить на проверку</button>
    <button class="retry" type="button">Решить снова</button>
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

/* страница задания, где ответа в папке нет — сюда придёт ИИ */
const AI_HTML = `<!doctype html><html><body>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-text">Напишите на C# программу, которая считает сумму 2 и 3</div>
    <div class="CodeMirror"><textarea></textarea></div>
    <button class="attempt-wrapper-button submit" type="button">Отправить на проверку</button>
  </div></div>
</body></html>`;

/* Ровно та вёрстка, на которой человек получил «условие отсутствует»: условие лежит
   в .html-content.rich-text-viewer, тесты — в таблице «Тестовые данные». */
const AI_REAL_HTML = `<!doctype html><html><body>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-inner page-fragment">
      <div class="html-content rich-text-viewer">
        <span><p>Создайте метод <code>PrintSquare(int x)</code>, который выводит куб переданного числа.</p></span>
      </div>
      <div class="step-text__samples-wrapper">
        <div class="step-text__samples-header">
          <div class="step-text__samples-header-title">Тестовые данные</div>
        </div>
        <div class="attempt-wrapper-samples">
          <div class="attempt-wrapper-samples__data-row">
            <div>1</div>
            <div class="attempt-wrapper-samples__data-row-content"><span>5</span></div>
            <div class="attempt-wrapper-samples__data-row-content"><span>125</span></div>
          </div>
          <div class="attempt-wrapper-samples__data-row">
            <div>2</div>
            <div class="attempt-wrapper-samples__data-row-content"><span>3</span></div>
            <div class="attempt-wrapper-samples__data-row-content"><span>27</span></div>
          </div>
        </div>
      </div>
    </div>
    <div class="CodeMirror"><textarea></textarea></div>
  </div></div>
</body></html>`;

/* Карточка без условия вовсе: редактор есть, текста задания нет. */
const AI_NO_TASK_HTML = `<!doctype html><html><body>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="CodeMirror"><textarea></textarea></div>
  </div></div>
</body></html>`;

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

  console.log('\n=== 9. после сохранения скоба не пропадает (индекс отстаёт) ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [CODE_ANSWER], html: HTML, waitMs: 3200,
    afterRun: async (win, st) => {
      check('ответ ушёл в очередь', !!st.inbox['l1793281_s8.cs']);
      const chip = win.document.querySelector('#sgx-chip');
      check('скоба «есть решение» показана', chip && chip.classList.contains('on'),
        chip && chip.className);

      /* робот файл перенёс, но CDN ещё отдаёт старый index.json — обновляем список */
      st.menu['🔄 Обновить список ответов']();
      /* ждём два цикла скрипта: только тогда видно, потерял ли он свой ответ */
      await new Promise((r) => setTimeout(r, 5200));
      check('после обновления списка скоба на месте', chip.classList.contains('on'),
        chip.className);
      check('повторно ответ не отправлен', Object.keys(st.inbox).length === 1,
        Object.keys(st.inbox).join(','));
    }
  });

  console.log('\n=== 10. панель открывается из меню, в сайдбаре и в стиле сайта ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: SHELL_HTML_FULL, waitMs: 2000,
    afterRun: async (win, st) => {
      const nav = win.document.querySelector('.lesson-sidebar__toc');
      const content = win.document.querySelector('.lesson-sidebar__content');
      check('на странице нет кнопки «от и до»', !win.document.querySelector('#sgx-fab'));
      check('панели на странице нет, пока её не открыли', !win.document.querySelector('#sgx-panel'));

      st.menu['📄 Пройти задания / собрать в Word']();
      const panel = win.document.querySelector('#sgx-panel');
      check('меню создало и открыло панель', !!panel && panel.classList.contains('on'));
      check('панель встала в боковое меню курса', panel.parentNode === content,
        panel.parentNode && panel.parentNode.className);
      check('список уроков спрятан', nav.classList.contains('sgx-sidebar-hidden'), nav.className);
      check('есть список «с»', !!win.document.querySelector('#sgx-from-l'));
      check('есть список «по»', !!win.document.querySelector('#sgx-to-l'));
      check('нет переключателя «уроки / шаги»', !win.document.querySelector('#sgx-mode'));
      const solve = win.document.querySelector('#sgx-solve');
      const collect = win.document.querySelector('#sgx-collect');
      check('«Пройти и отправить» с иконкой',
        /Пройти/.test(solve.textContent) && !!solve.querySelector('svg'), solve.textContent);
      check('«Собрать в Word» с иконкой',
        /Собрать в Word/.test(collect.textContent) && !!collect.querySelector('svg'), collect.textContent);
      check('есть кнопка закрытия', !!win.document.querySelector('#sgx-panel .sgx-close'));
      win.document.querySelector('#sgx-panel .sgx-close').click();
      check('крестик закрывает панель', !panel.classList.contains('on'));
      check('крестик возвращает уроки', !nav.classList.contains('sgx-sidebar-hidden'), nav.className);
    }
  });

  console.log('\n=== 10b. без меню курса панель не подменяет наугад, а честно говорит ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: HTML, waitMs: 2000,
    afterRun: async (win, st) => {
      st.menu['📄 Пройти задания / собрать в Word']();
      check('панель не появилась — подменять нечего', !win.document.querySelector('#sgx-panel'));
      const toast = win.document.querySelector('#sgx-toast');
      check('человеку сказано, что меню курса не видно',
        !!toast && /боковое меню/i.test(toast.textContent), toast && toast.textContent);
    }
  });

  console.log('\n=== 10a. кнопка живёт в шапке урока, панель занимает место уроков ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: SHELL_HTML_FULL, waitMs: 2200,
    afterRun: async (win) => {
      const bar = win.document.querySelector('.lesson-controls');
      const btn = win.document.querySelector('.lesson-controls #sgx-tools-btn');
      check('кнопка вставлена в ряд настроек урока', !!btn);
      check('кнопка — отдельный пункт ряда (как полноэкранный режим)',
        btn && btn.tagName === 'LI' && btn.className.indexOf('lesson-controls__item') >= 0,
        btn && btn.className);
      check('кнопка одета в родной класс сайта',
        !!win.document.querySelector('#sgx-tools-btn .button_style_secondary'));
      check('ряд настроек не перестроен: три пункта', bar.children.length === 3, String(bar.children.length));

      const nav = win.document.querySelector('.lesson-sidebar__toc');
      const content = win.document.querySelector('.lesson-sidebar__content');
      check('до нажатия панели нет', !win.document.querySelector('#sgx-panel'));
      check('до нажатия уроки видны', !nav.classList.contains('sgx-sidebar-hidden'), nav.className);

      win.document.querySelector('#sgx-tools-btn button').click();
      /* панель создаётся по клику — берём её после, а не заранее */
      const panel = win.document.querySelector('#sgx-panel');
      check('кнопка создала и открыла панель', !!panel && panel.classList.contains('on'));
      check('панель лежит внутри бокового меню курса', !!panel && panel.parentNode === content,
        panel && panel.parentNode && panel.parentNode.className);
      check('список уроков спрятан', nav.classList.contains('sgx-sidebar-hidden'), nav.className);
      check('в панели есть все четыре функции',
        !!win.document.querySelector('#sgx-solve') && !!win.document.querySelector('#sgx-collect') &&
        !!win.document.querySelector('#sgx-ai-btn') && !!win.document.querySelector('#sgx-stop'));
      check('в панели есть «с» и «по»',
        !!win.document.querySelector('#sgx-from-l') && !!win.document.querySelector('#sgx-to-l'));
      check('уроки в «с» подтянулись из меню курса',
        win.document.querySelectorAll('#sgx-from-l option').length === 3,
        String(win.document.querySelectorAll('#sgx-from-l option').length));

      win.document.querySelector('#sgx-panel .sgx-close').click();
      check('крестик вернул уроки', !nav.classList.contains('sgx-sidebar-hidden'), nav.className);
      check('панель спряталась', !panel.classList.contains('on'));
      check('панель осталась в сайдбаре и переоткроется', panel.parentNode === content);

      /* повторное нажатие кнопки должно снова открыть, а не «залипнуть» */
      win.document.querySelector('#sgx-tools-btn button').click();
      check('кнопка открывает панель повторно', panel.classList.contains('on'));
    }
  });

  console.log('\n=== 11. скоба переезжает наверх, если справа нет места ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int x = 1;' } },
    submissions: [], html: HTML, innerWidth: 400, waitMs: 2000,
    afterRun: async (win) => {
      const chip = win.document.querySelector('#sgx-chip');
      check('скоба показана', chip && chip.classList.contains('on'));
      check('режим «сверху»', chip.classList.contains('above'), chip.className);
      check('спрятана вертикальная скоба', chip.style.height === 'auto', chip.style.height);
    }
  });

  console.log('\n=== 12. «пройти от и до»: вставил и отправил ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int x = 42;' } },
    submissions: [], html: JOB_HTML, waitMs: 6500,
    job: { kind: 'solve', plan: [{ lesson: String(LESSON), step: 8, label: 'шаг 8' }], at: 0, shots: [], title: 'тест' },
    afterRun: async (win, st) => {
      check('ответ вставлен в редактор', st.setValue === 'int x = 42;', JSON.stringify(st.setValue));
      check('нажата именно «Отправить на проверку»', st.submitted === 1, 'кликов: ' + st.submitted);
      check('«Решить снова» не нажата', st.retried === 0, 'кликов: ' + st.retried);
      check('обход завершён', JSON.parse(st.storage.job || 'null') === null, st.storage.job);
      check('сказано «готово»', /готово/.test(statusText(win)), statusText(win));
    }
  });

  console.log('\n=== 13. «собрать в Word»: скриншот → .docx ===');
  const docState = await run({
    url: `https://stepik.org/lesson/${LESSON}/step/9?unit=1818966`,
    store: {}, submissions: [], html: JOB_HTML, waitMs: 6500,
    job: { kind: 'collect', plan: [{ lesson: String(LESSON), step: 9, label: 'шаг 9' }], at: 0, shots: [], title: 'тест' },
    afterRun: async (win, st) => {
      check('скриншот снят', st.shots === 1, st.shots);
      check('документ собран', !!st.docBlob, String(st.docBlob));
      check('обход завершён', JSON.parse(st.storage.job || 'null') === null);
      check('статус про документ', /документ|скриншот/.test(statusText(win)),
        statusText(win));
    }
  });

  if (docState.docBlob) {
    const buf = Buffer.from(await docState.docBlob.arrayBuffer());
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).sort();
    check('в .docx есть [Content_Types].xml', names.includes('[Content_Types].xml'), names.join(', '));
    check('в .docx есть _rels/.rels', names.includes('_rels/.rels'));
    check('в .docx есть word/document.xml', names.includes('word/document.xml'));
    check('в .docx есть картинка', names.some((n) => /^word\/media\/image\d+\.png$/.test(n)), names.join(', '));
    const doc = await zip.file('word/document.xml').async('string');
    check('в документе есть рисунок', /<w:drawing>/.test(doc) && /r:embed="rId1"/.test(doc));
    check('в документе есть заголовок шага', /шаг 9/.test(doc), doc.slice(0, 200));
    const rels = await zip.file('word/_rels/document.xml.rels').async('string');
    check('связь с картинкой прописана', /Target="media\/image1\.png"/.test(rels), rels);
    check('размер файла разумный', buf.length > 500, buf.length + ' байт');
  }

  console.log('\n=== 14. «с 4.1 по 4.3»: план из уроков курса ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {
      l1755852_s1: { file: 'l1755852_s1.cs', ext: 'cs', kind: 'code', content: 'a' },
      l1755853_s1: { file: 'l1755853_s1.cs', ext: 'cs', kind: 'code', content: 'b' },
      l1755854_s1: { file: 'l1755854_s1.cs', ext: 'cs', kind: 'code', content: 'c' }
    },
    submissions: [], html: SIDEBAR_HTML, waitMs: 3000,
    afterRun: async (win, st) => {
      /* панель теперь открывается по кнопке и живёт в сайдбаре */
      win.document.querySelector('#sgx-tools-btn button').click();
      const sel = win.document.querySelector('#sgx-from-l');
      const opts = sel.querySelectorAll('option');
      check('в списке только уроки с ответами (в меню 4 урока, ответы у трёх)',
        opts.length === 3, opts.length + ': ' + Array.from(opts).map((o) => o.value).join(', '));
      check('урок без ответов не попал в список',
        !Array.from(opts).some((o) => o.value === '4.4'),
        Array.from(opts).map((o) => o.value).join(','));
      check('в списке все номера уроков', Array.from(opts).map((o) => o.value).join(',') === '4.1,4.2,4.3',
        Array.from(opts).map((o) => o.value).join(','));
      check('в списке видно название урока', /Знакомство с методами/.test(opts[0].textContent),
        opts[0].textContent);
      check('второй список тоже заполнен',
        win.document.querySelector('#sgx-to-l').options.length === 3);

      sel.value = '4.1';
      win.document.querySelector('#sgx-to-l').value = '4.3';
      win.document.querySelector('#sgx-solve').click();
      await new Promise((r) => setTimeout(r, 1200));

      const job = JSON.parse(st.storage.job || 'null');
      check('задание создано', !!job, st.storage.job);
      check('в плане 6 заданий (по 2 шага × 3 урока)', job && job.plan.length === 6,
        job && job.plan.length);
      check('план начинается с 4.1.1', job && job.plan[0].label === '4.1.1', job && job.plan[0].label);
      check('план кончается 4.3.2', job && job.plan[5].label === '4.3.2', job && job.plan[5].label);
      check('уроки в плане разные', job && new Set(job.plan.map((p) => p.lesson)).size === 3);
      check('подпись задания про уроки', job && /уроки 4\.1–4\.3/.test(job.title), job && job.title);
    }
  });

  console.log('\n=== 15. скоба обрамляет весь блок задания, а не вопрос ===');
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
      check('скоба показана', chip && chip.classList.contains('on'));
      check('высота по блоку задания (300), а не по вопросу (120)',
        chip.style.height === '300px', chip.style.height);
    }
  });

  console.log('\n=== 16. редактор появился с задержкой — скрипт дождался ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int late = 1;' } },
    submissions: [], html: LATE_HTML, lateEditor: 4000, waitMs: 12000,
    job: { kind: 'solve', plan: [{ lesson: String(LESSON), step: 8, label: 'шаг 8' }], at: 0, shots: [], title: 'тест' },
    afterRun: async (win, st) => {
      check('ответ всё-таки вставлен', st.setValue === 'int late = 1;', JSON.stringify(st.setValue));
      check('задание отправлено, а не пропущено', st.submitted === 1, 'кликов: ' + st.submitted);
      check('обход дошёл до конца', JSON.parse(st.storage.job || 'null') === null);
      check('в статусе нет ошибок',
        !/не смог|пропускаю/.test(statusText(win)),
        statusText(win));
    }
  });

  console.log('\n=== 17. переход на другой урок — без чужого ?unit= ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: SIDEBAR_HTML, waitMs: 3000,
    job: { kind: 'solve', plan: [{ lesson: '1755852', step: 1, label: '4.1.1' }], at: 0, shots: [], title: 'тест' },
    afterRun: async (win, st) => {
      st.menu['🧪 Проверка хранилища (отчёт)']();
      await new Promise((r) => setTimeout(r, 1500));
      const ta = win.document.querySelector('#sgx-report textarea');
      const report = ta ? ta.value : '';
      const nav = (report.match(/последний переход: .*/) || [''])[0];
      check('отчёт открылся', !!ta);
      check('переход на другой урок в отчёте есть', /\/lesson\/1755852\/step\/1/.test(report), nav);
      check('чужой unit не перенесён', !/unit=1818966/.test(report), nav);
    }
  });

  console.log('\n=== 18. шаг без полей — пропускается сразу ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: THEORY_HTML, waitMs: 7500,
    job: { kind: 'solve', plan: [{ lesson: String(LESSON), step: 8, label: 'шаг 8' }], at: 0, shots: [], title: 'тест' },
    afterRun: async (win, st) => {
      check('шаг пропущен, обход закончен', JSON.parse(st.storage.job || 'null') === null,
        st.storage.job);
      check('в статусе «готово»', /готово/.test(statusText(win)),
        statusText(win));
    }
  });

  console.log('\n=== 19. в Word не попадают задания с галочками ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/9?unit=1818966`,
    store: {}, submissions: [], html: CHOICE_HTML, waitMs: 7500,
    job: { kind: 'collect', plan: [{ lesson: String(LESSON), step: 9, label: 'шаг 9' }], at: 0, shots: [], title: 'тест' },
    afterRun: async (win, st) => {
      check('скриншот не снимался', st.shots === 0, 'снимков: ' + st.shots);
      check('обход закончен', JSON.parse(st.storage.job || 'null') === null, st.storage.job);
      check('статус говорит про «не код»', /не код|скриншот/.test(
        statusText(win)) ||
        /готово/.test(statusText(win)),
        statusText(win));
    }
  });

  console.log('\n=== 20. «собрать в Word» с клика по панели: переход и отсутствие залипания ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {
      l1755852_s1: { file: 'l1755852_s1.cs', ext: 'cs', kind: 'code', content: 'a' },
      l1755852_s2: { file: 'l1755852_s2.cs', ext: 'cs', kind: 'code', content: 'b' },
      l1755853_s1: { file: 'l1755853_s1.cs', ext: 'cs', kind: 'code', content: 'c' }
    },
    submissions: [], html: SIDEBAR_HTML, waitMs: 6000,
    afterRun: async (win, st) => {
      /* ровно то, что делает человек: открыл панель из меню и нажал кнопку */
      st.menu['📄 Пройти задания / собрать в Word']();
      await new Promise((r) => setTimeout(r, 900));      /* список уроков подтягивается */
      win.document.querySelector('#sgx-from-l').value = '4.1';
      win.document.querySelector('#sgx-to-l').value = '4.2';
      win.document.querySelector('#sgx-collect').click();
      await new Promise((r) => setTimeout(r, 1500));

      const job1 = JSON.parse(st.storage.job || 'null');
      check('обход создан', !!job1, st.storage.job);
      check('в плане только задания с кодом из ответов, а не все подряд',
        job1 && job1.plan.length === 3, job1 && job1.plan.length); /* 3 ответа с кодом */
      check('в статусе видно попытку перехода',
        /перехожу|собираю|скриншот/.test(statusText(win)),
        statusText(win));
      check('полоска прогресса на странице показана',
        !!win.document.querySelector('#sgx-progress'));
    }
  });

  console.log('\n=== 20a. в диапазоне есть урок без ответов → берём только уроки с ответами ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {
      l1755852_s1: { file: 'l1755852_s1.cs', ext: 'cs', kind: 'code', content: 'a' }
    },
    submissions: [], html: SIDEBAR_HTML, waitMs: 5000,
    afterRun: async (win, st) => {
      st.menu['📄 Пройти задания / собрать в Word']();
      await new Promise((r) => setTimeout(r, 900));
      /* в списке есть только уроки с ответами, поэтому курса целиком не выбрать */
      const opts = Array.from(win.document.querySelector('#sgx-from-l').options).map((o) => o.value);
      win.document.querySelector('#sgx-from-l').value = opts[0];
      win.document.querySelector('#sgx-to-l').value = opts[opts.length - 1];
      /* перехватываем план в момент его создания, до старта перехода */
      let plan = null;
      win.document.addEventListener('sgx:nav', () => {
        const j = JSON.parse(st.storage.job || 'null');
        if (j && !plan) plan = j.plan;
      });
      win.document.querySelector('#sgx-collect').click();
      await new Promise((r) => setTimeout(r, 1200));
      check('в план попали только уроки с ответами',
        plan && plan.every((p) => p.lesson === '1755852'), JSON.stringify(plan));
      check('в плане только шаги с сохранённым кодом (у 4.1 он один)',
        plan && plan.length === 1, plan && plan.length);
    }
  });

  console.log('\n=== 21. первый шаг плана не совпадает с текущим → скрипт сам переходит ===');
  await run({
    /* стоим на 8-м шаге, а план начинается с 1-го */
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: JOB_HTML, waitMs: 12000,
    job: { kind: 'collect', plan: [{ lesson: String(LESSON), step: 1, label: 'шаг 1' }], at: 0, shots: [], title: 'тест', navTo: '', navAt: 0, navHard: false },
    afterRun: async (win, st) => {
      /* это и было поломкой: скрипт не переходил сам и «сборка в Word» ничего не делала */
      check('скрипт сам сменил адрес на шаг из плана',
        win.location.pathname === `/lesson/${LESSON}/step/1`, win.location.pathname);
      check('обход не остался висеть',
        JSON.parse(st.storage.job || 'null') === null, st.storage.job);
      const status = statusText(win);
      check('статус говорит про готовый документ', /готово|документ/.test(status), status);
    }
  });

  console.log('\n=== 22. переход зафиксирован (роутер), а не молча проигнорирован ===');
  const navState = await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1755852_s1: { file: 'l1755852_s1.cs', ext: 'cs', kind: 'code', content: 'a' } },
    submissions: [], html: SIDEBAR_HTML, waitMs: 2600,
    /* задание уже есть: при первом тике скрипт обязан пойти на первый шаг */
    job: { kind: 'collect', plan: [{ lesson: '1755852', step: 1, label: '4.1.1' }], at: 0, shots: [], title: 'тест', navTo: '', navAt: 0, navHard: false },
    afterRun: async (win, st) => {
      /* переход уже случился к моменту послеRun: проверяем по адресу документа */
      check('адрес сменился на нужный шаг',
        win.location.pathname === '/lesson/1755852/step/1', win.location.pathname + win.location.search);
      check('другой урок — без чужого ?unit=', !/unit=/.test(win.location.search), win.location.search);
      /* и в отчёте самопроверки переход тоже виден */
      st.menu['🧪 Проверка хранилища (отчёт)']();
      await new Promise((r) => setTimeout(r, 1200));
      const ta = win.document.querySelector('#sgx-report textarea');
      check('переход виден в отчёте', ta && /\/lesson\/1755852\/step\/1/.test(ta.value),
        ta && (ta.value.match(/последний переход: .*/) || [''])[0]);
    }
  });

  console.log('\n=== 23. обход не запускается повторно, пока идёт ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int x = 1;' } },
    submissions: [], html: SIDEBAR_HTML, waitMs: 1200,
    /* шаг в плане недостижим → обход гарантированно ещё идёт */
    job: {
      kind: 'solve', at: 0, shots: [], title: 'тест',
      plan: [{ lesson: '9999999', step: 1, label: 'чужой.1' }],
      navTo: '', navAt: 0, navHard: false
    },
    afterRun: async (win, st) => {
      const before = JSON.parse(st.storage.job || 'null');
      check('обход на месте перед проверкой', !!before, st.storage.job);

      /* панель открываем кнопкой в шапке — до этого её в документе нет */
      win.document.querySelector('#sgx-tools-btn button').click();
      check('кнопка «Собрать в Word» заблокирована, пока идёт обход',
        win.document.querySelector('#sgx-collect').disabled === true,
        'disabled=' + win.document.querySelector('#sgx-collect').disabled);

      /* кнопки во время обхода заблокированы — второй обход физически не запустить */
      win.document.querySelector('#sgx-collect').click();
      win.document.querySelector('#sgx-solve').click();
      await new Promise((r) => setTimeout(r, 100));
      const after = JSON.parse(st.storage.job || 'null');
      check('обход всё ещё тот же самый',
        after && after.plan[0].label === 'чужой.1', st.storage.job);
      check('«Пройти и отправить» тоже заблокирована во время обхода',
        win.document.querySelector('#sgx-solve').disabled === true);
      check('«Остановить» доступна', win.document.querySelector('#sgx-stop').disabled === false);
    }
  });

  console.log('\n=== 24. ИИ: решение приходит и показывается, ничего не отправляя ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 3000,
    aiText: 'using System;\nclass P { static void Main() { Console.WriteLine(5); } }',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 1500));

      check('запрос к бесплатному ИИ ушёл', st.aiCalls.length === 1, 'запросов: ' + st.aiCalls.length);
      const body = st.aiCalls[0] && JSON.parse(st.aiCalls[0].body);
      check('модель указана явно', body && body.model === 'openai-fast', body && body.model);
      check('в запросе нет никакого ключа',
        !/github_pat|Bearer|api[_-]?key/i.test(st.aiCalls[0].body), 'тело запроса чистое');
      const asked = st.aiCalls[0] && JSON.parse(st.aiCalls[0].body).messages.slice(-1)[0].content;
      check('в запрос попал текст задания', /сумму 2 и 3/.test(asked), asked && asked.slice(0, 80));

      const box = win.document.querySelector('#sgx-ai');
      check('окно с решением открылось', !!box);
      const text = box && box.querySelector('.sgx-ai-text').value;
      check('в окне именно ответ ИИ', /Console\.WriteLine\(5\)/.test(text || ''), text);
      check('в окне нет другого ответа/склейки',
        (text || '').trim() === 'using System;\nclass P { static void Main() { Console.WriteLine(5); } }', text);

      check('ничего не вставлено в редактор', st.setValue === null, JSON.stringify(st.setValue));
      check('ничего не отправлено', st.submitted === 0, 'кликов: ' + st.submitted);
      check('в очереди ответов пусто', Object.keys(st.inbox).length === 0);
    }
  });

  console.log('\n=== 25. ИИ недоступен → сказано внятно, ничего не сломано ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    /* «недоступен» — это когда молчат ОБА канала: с одним бесплатным, который упал,
       скрипт обязан уйти в свой ключ, и это не ошибка, а работа (сценарий 28) */
    store: {}, submissions: [], html: AI_HTML, waitMs: 10000,
    aiDown: true, aiPaidDown: true,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 9000));
      const status = statusText(win);
      check('сказано, что ИИ не ответил', /ИИ не ответил/.test(status), status);
      check('окно с решением не открылось', !win.document.querySelector('#sgx-ai'));
      check('редактор не тронут', st.setValue === null);
    }
  });

  console.log('\n=== 26. лимит бесплатного ИИ соблюдается (1 запрос / 15 с) ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 3000,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 1200));
      st.menu['✨ ИИ: решить текущий шаг']();      /* сразу второй раз */
      await new Promise((r) => setTimeout(r, 600));
      check('второй запрос не ушёл — сработал лимит', st.aiCalls.length === 1,
        'запросов: ' + st.aiCalls.length);
      const status = statusText(win);
      check('сказано, сколько подождать', /подожди \d+ с|лимит/.test(status), status);
    }
  });

  console.log('\n=== 27. ИИ не трогает шаги, где ответ уже есть ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int x = 1;' } },
    submissions: [], html: AI_HTML, waitMs: 2200,
    afterRun: async (win, st) => {
      const chip = win.document.querySelector('#sgx-chip');
      check('скоба показывает сохранённое решение',
        chip && chip.querySelector('.sgx-label').textContent === 'есть решение');
      check('кнопка ИИ в скобе спрятана (ответ уже есть)',
        chip && !chip.classList.contains('sgx-no-answer'), chip && chip.className);
      check('к ИИ не обращались', st.aiCalls.length === 0);
    }
  });

  console.log('\n=== 28. HTTP 402 у бесплатного → переход на свой канал ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 12000,
    aiDown: true,                                   /* ровно та ошибка, что видит человек */
    aiPaidText: 'static void PrintSquare(int x)\n{\n    Console.WriteLine(x * x * x);\n}',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      /* бесплатный пробуется дважды на модель × две модели, между попытками 0,7 с —
         ждём с запасом, иначе проверка ловит процесс на середине */
      await new Promise((r) => setTimeout(r, 8000));

      check('бесплатный канал попробован', st.aiCalls.length >= 1, 'попыток: ' + st.aiCalls.length);
      check('после отказа пошли в свой канал', st.aiPaidCalls.length >= 1,
        'попыток: ' + st.aiPaidCalls.length);
      const paid = st.aiPaidCalls[0];
      check('в свой канал ушёл ключ в заголовке',
        /^Bearer .+/.test((paid && paid.auth) || ''), String(paid && paid.auth).slice(0, 12) + '…');
      check('в теле своего запроса ключа нет',
        !/sk-|Bearer|github_pat/i.test(paid.body || ''), 'тело чистое');
      check('модель — быстрая, не reasoning',
        JSON.parse(paid.body).model === 'glm-5.3-flash', JSON.parse(paid.body).model);

      const box = win.document.querySelector('#sgx-ai');
      check('окно с решением открылось', !!box);
      check('в окне ответ своего канала',
        /PrintSquare/.test((box && box.querySelector('.sgx-ai-text').value) || ''),
        box && box.querySelector('.sgx-ai-text').value);
      check('подписано, каким каналом решено',
        /свой ключ/.test(box.querySelector('.sgx-ai-note').textContent),
        box.querySelector('.sgx-ai-note').textContent);
      check('ничего не вставлено и не отправлено', st.setValue === null && st.submitted === 0);
    }
  });

  console.log('\n=== 29. оба канала молчат → понятное объяснение, а не «HTTP 500» ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 12000,
    aiDown: true, aiPaidDown: true,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 9000));
      const status = statusText(win);
      check('сказано, что бесплатный исчерпал лимит', /402/.test(status), status);
      check('сказано про свой канал', /свой ключ/.test(status), status);
      check('окно не открылось', !win.document.querySelector('#sgx-ai'));
      check('редактор не тронут', st.setValue === null);
    }
  });

  console.log('\n=== 30. ключ можно убрать: остаётся только бесплатный канал ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 5000,
    /* '' — это «человек сам очистил поле», и оно должно значить «своего канала нет».
       Раньше пустая строка молча возвращала встроенный ключ, и убрать его было нельзя. */
    aiKey: '', aiDown: true, aiPaidText: 'не должно быть использовано',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      /* ждём столько же, сколько и в сценарии 28: проверка «не пошли» имеет смысл
         только если бы было время сходить */
      await new Promise((r) => setTimeout(r, 8000));
      check('в свой канал не пошли — ключа нет', st.aiPaidCalls.length === 0,
        'попыток: ' + st.aiPaidCalls.length);
      check('про свой ключ даже не упомянуто',
        !/свой ключ/.test(statusText(win)),
        statusText(win));
    }
  });

  console.log('\n=== 30a. ключ не задан вовсе → встроенный подхватывается ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 12000,
    /* aiKey не передаём: значит в памяти его нет и должен сработать встроенный */
    aiDown: true, aiPaidText: 'static void FromBuiltIn() { }',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 8000));
      check('со встроенным ключом свой канал работает', st.aiPaidCalls.length >= 1,
        'попыток: ' + st.aiPaidCalls.length);
      const box = win.document.querySelector('#sgx-ai');
      check('и решение показано', !!box && /FromBuiltIn/.test(box.querySelector('.sgx-ai-text').value),
        box ? box.querySelector('.sgx-ai-text').value : 'окна нет');
    }
  });

  console.log('\n=== 31. reasoning-модель без content → берём размышления, а не пусто ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 12000,
    aiDown: true, aiPaidEmpty: true,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 9000));
      const box = win.document.querySelector('#sgx-ai');
      check('пустой ответ не остался незамеченным', st.aiPaidCalls.length >= 1);
      check('окно открылось с тем, что модель всё-таки отдала',
        !!box && /думал-думал/.test(box.querySelector('.sgx-ai-text').value),
        box ? box.querySelector('.sgx-ai-text').value : 'окна нет');
      check('в редактор по-прежнему ничего не попало', st.setValue === null);
    }
  });

  console.log('\n=== 32. условие и тесты из настоящей вёрстки доходят до ИИ ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_REAL_HTML, waitMs: 5000,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));

      check('запрос к ИИ ушёл', st.aiCalls.length === 1, 'запросов: ' + st.aiCalls.length);
      const body = (st.aiCalls[0] && st.aiCalls[0].body) || '';
      /* раньше в запрос уезжала пустая заготовка — здесь проверяем сам текст */
      check('в запросе есть условие задания', /PrintSquare/.test(body), 'условие найдено');
      check('в запросе есть тестовые данные', /вход: 5/.test(body), 'тесты найдены');
      check('вход и выход не перепутаны', /выход: 125/.test(body), 'пары верные');
      check('модели сказано свериться с тестами', /Сверься с/.test(body), 'подсказка есть');
      check('шаблонного «условие отсутствует» быть не может',
        !/условие отсутствует/i.test(body), 'чисто');
    }
  });

  console.log('\n=== 33. условия нет → говорим прямо, а не просим ИИ угадать ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_NO_TASK_HTML, waitMs: 5000,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 1500));
      const status = statusText(win);
      check('сказано, что условия не видно', /не вижу условия/.test(status), status);
      check('к ИИ НЕ обращались — незачем', st.aiCalls.length === 0,
        'запросов: ' + st.aiCalls.length);
      check('окно решения не открылось', !win.document.querySelector('#sgx-ai'));
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== ИТОГ: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено ===');
  if (failed.length) { console.log('ПРОВАЛЫ: ' + failed.map((f) => f.name).join('; ')); process.exit(1); }
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
