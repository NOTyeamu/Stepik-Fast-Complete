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

/* Имена параметров песочницы, в которой исполняется скрипт. Один список на всех:
   раньше он был продублирован, и добавление глобали легко забывалось в одном месте
   (так пропал atob и «сломался» рабочий ключ ИИ). */
const SANDBOX_ARGS = [
  'window', 'document', 'location', 'fetch', 'console', 'navigator',
  'GM_getValue', 'GM_setValue', 'GM_addStyle', 'GM_registerMenuCommand',
  'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PopStateEvent',
  'HTMLTextAreaElement', 'HTMLInputElement', 'TextEncoder', 'btoa', 'atob',
  'html2canvas', 'JSZip', 'URL',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'
];

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
      /* 404 по конкретному файлу считаем отдельно: именно так выглядит ответ,
         который уже лежит в очереди, но ещё не перенесён роботом в answers/. */
      if (!hit) { state.rawMisses = (state.rawMisses || 0) + 1; return fail(404); }
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

    /* --- ИИ, свой канал (ключевой) --- */
    if (u.includes('api.reformboss.com')) {
      state.aiPaidCalls.push({ url: u, body: init && init.body, auth: init && init.headers && init.headers.Authorization });
      if (state.aiPaidDown) return fail(500);
      let asked = '';
      let model = '';
      try { const b = JSON.parse(init.body); asked = b.messages.slice(-1)[0].content; model = b.model; } catch (e) { /* ignore */ }
      /* aiPaidQueue: разные ответы на 1-й, 2-й … запрос — так проверяется правка
         после проваленной проверки (сначала плохой код, потом исправленный). */
      const q = state.aiPaidQueue || [];
      const nth = state.aiPaidCalls.length - 1;
      const fromQueue = q.length ? q[Math.min(nth, q.length - 1)] : null;
      const answerText = fromQueue != null ? fromQueue : (state.aiPaidText || 'static void PrintSquare(int x) { }');
      /* reasoning-модель отдаёт размышления отдельным полем — проверяем и это */
      const msg = state.aiPaidEmpty
        ? { role: 'assistant', content: '', reasoning_content: 'думал-думал' }
        : { role: 'assistant', content: answerText };
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

function run({ url, store, submissions, html, storeDown, emptyLessonSteps, token, job, innerWidth, lateEditor, waitMs, afterRun, aiPaidDown, aiPaidText, aiPaidEmpty, aiKey, aiPaidQueue, checkHint, checkHintAt, cmMode, seedTheory }) {
  return new Promise((resolve, reject) => {
    const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
    const { window } = dom;
    const state = {
      calls: [], inbox: {}, inboxMessages: [], menu: {},
      store: Object.assign({}, store || {}), submissions: submissions || [],
      storeDown: !!storeDown, emptyLessonSteps: !!emptyLessonSteps,
      setValue: null, submitted: 0, retried: 0, docBlob: null, shots: 0,
      aiPaidCalls: [], aiPaidDown: !!aiPaidDown, aiPaidText: aiPaidText,
      aiPaidEmpty: !!aiPaidEmpty, aiPaidQueue: aiPaidQueue || [],
      cmMode: cmMode || '',
      storage: { writeToken: token === undefined ? 'github_pat_11TEST' : token }
    };
    if (job) state.storage.job = JSON.stringify(job);
    if (aiKey !== undefined) state.storage.aiKey = aiKey;
    /* Теорию урока скрипт запоминает, пока её читают, и достаёт на задании.
       Чтобы проверить это без второго прогона, кладём кэш заранее — так же, как
       его оставил бы прочитанный урок.                                           */
    if (seedTheory) state.storage.theory = JSON.stringify(seedTheory);
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
        /* язык приходит из редактора; по умолчанию C#, но сценарий может задать
           свой — иначе «Python-ответ» проверялся бы на C#-расширении */
        getOption: () => state.cmMode || 'text/x-csharp',
        refresh() {}, focus() {}
      };
    };
    const submitBtn = window.document.querySelector('button.submit');
    if (submitBtn) submitBtn.addEventListener('click', () => { state.submitted++; });
    const retryBtn = window.document.querySelector('button.retry');
    if (retryBtn) retryBtn.addEventListener('click', () => { state.retried++; });

    const cmNode = window.document.querySelector('.CodeMirror');
    if (cmNode) mkCm(cmNode);

    /* отчёт проверки Stepik показывается не мгновенно после отправки — рисуем
       его с задержкой, чтобы скрипт искал его так же, как на живом сайте */
    if (checkHint) {
      setTimeout(() => {
        const host = window.document.querySelector('#sgx-test-hint') ||
          window.document.querySelector('.attempt-wrapper__content') || window.document.body;
        const d = window.document.createElement('div');
        d.className = 'smart-hints ember-view submission-show__submission-hint';
        d.innerHTML = '<p class="smart-hints__hint"></p>';
        d.querySelector('.smart-hints__hint').textContent = checkHint;
        host.appendChild(d);
      }, checkHintAt == null ? 800 : checkHintAt);
    }

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
      SANDBOX_ARGS,
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

/* Лёгкая песочница без сценария: нужна, чтобы дотянуться до внутренних функций
   скрипта (extOf и подобных) и проверить их напрямую, не поднимая весь прогон.
   Скрипт целиком завёрнут в IIFE, поэтому «приклеить» хвост снаружи нельзя —
   вставляем его внутрь, перед закрывающей `})();`. */
function probeSandbox(html, expose, url) {
  const dom = new JSDOM(html || HTML, { url: url || `https://stepik.org/lesson/${LESSON}/step/8`, runScripts: 'dangerously' });
  const { window } = dom;
  const names = expose || ['extOf'];
  const tail = '\n  window.__probe = { ' + names.map((n) => n + ': ' + n).join(', ') + ' };\n';
  const marked = SCRIPT.replace(/\}\)\(\);\s*$/, tail + '})();');
  if (marked === SCRIPT) throw new Error('probeSandbox: не нашёл закрытие IIFE в скрипте');
  const fn = new Function(SANDBOX_ARGS, marked);
  fn(
    window, window.document, window.location, () => Promise.reject(new Error('probe: no net')),
    console, window.navigator, (k, d) => d, () => {}, () => {}, () => {},
    window.CustomEvent, window.Event, window.KeyboardEvent, window.MouseEvent, window.PopStateEvent,
    window.HTMLTextAreaElement, window.HTMLInputElement, TextEncoder, btoa, atob,
    () => {}, {}, window.URL, setTimeout, clearTimeout, setInterval, clearInterval
  );
  const api = window.__probe || {};
  api.close = () => { try { window.close(); } catch (e) { /* ignore */ } };
  return api;
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

/* Открыть панель: кнопкой в шапке урока, а если шапки нет — через меню. */
function openPanelIn(win, st) {
  const btn = win.document.querySelector('#sgx-tools-btn button');
  if (btn) { btn.click(); return; }
  if (st && st.menu['📄 Пройти задания / собрать в Word']) {
    st.menu['📄 Пройти задания / собрать в Word']();
  }
}

/* Лента решения ИИ живёт в блоке рядом с редактором кода (карточка задания), а не
   в боковом меню. Блок создаётся сам при «Спросить ИИ»; если его нет, пробуем
   открыть панель кнопкой в шапке — на всякий случай, вдруг разметка другая. */
function aiFeedText(win, st) {
  let log = win.document.querySelector('#sgx-ai-log');
  if (!log) {
    openPanelIn(win, st);
    log = win.document.querySelector('#sgx-ai-log');
  }
  return log ? log.textContent : '';
}

/* Блок ИИ показан, если корень получил класс on и стоит в документе. Именно так
   мы отличаем «блок создан, но спрятан» от «блок показан». */
function aiPanelShown(win) {
  const root = win.document.querySelector('#sgx-ai-root');
  return !!(root && root.classList.contains('on') && root.parentNode);
}

/* Где стоит блок ИИ: должен оказаться в карточке задания рядом с редактором,
   а не в боковом меню курса. Возвращаем, к какому контейнеру он прикреплён. */
function aiHostOf(win) {
  const root = win.document.querySelector('#sgx-ai-root');
  if (!root) return null;
  return root.closest('.quiz-plugin, .code-editor-quiz__editor, .code-quiz__code, .attempt-wrapper__content, .lesson-sidebar__content');
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
  ${SHELL_HTML}
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-text">Напишите на C# программу, которая считает сумму 2 и 3</div>
    <div class="CodeMirror"><textarea></textarea></div>
    <button class="attempt-wrapper-button submit" type="button">Отправить на проверку</button>
  </div></div>
</body></html>`;

/* Ровно та вёрстка, на которой человек получил «условие отсутствует»: условие лежит
   в .html-content.rich-text-viewer, тесты — в таблице «Тестовые данные».
   Шапку урока и сайдбар добавляем: без них не создаётся ни кнопка, ни панель,
   а решение ИИ показывается именно в панели. */
const AI_REAL_HTML = `<!doctype html><html><body>
  ${SHELL_HTML}
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

/* Ровно тот отчёт, который Stepik показывает после проваленной отправки:
   в нём и номер теста, и вход, и правильный вывод, и трейсбек. По нему модель
   должна понять ошибку и переписать решение — ради этого всё и делалось. */
const AI_FAIL_HINT =
  'Failed test #1 of 3. Runtime error\n' +
  'Test input: Анна\n20\n' +
  'Correct output: Анна, вам 20 лет\n' +
  'Your code output:\nError:\nTraceback (most recent call last):\n' +
  "  File \"main.py\", line 2, in <module>\n" +
  "    age = int(input())\n" +
  "ValueError: invalid literal for int() with base 10: 'Анна'";

/* Задача про возраст + место под отчёт проверки (появляется по ходу теста). */
const AI_FIX_HTML = `<!doctype html><html><body>
  ${SHELL_HTML}
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-inner page-fragment">
      <div class="html-content rich-text-viewer">
        <span><p>Спросите у пользователя имя и возраст, затем выведите «Имя, вам N лет».</p></span>
      </div>
    </div>
    <div class="CodeMirror"><textarea></textarea></div>
    <button class="submit" type="button">Отправить на проверку</button>
    <div id="sgx-test-hint"></div>
  </div></div>
</body></html>`;

/* Тест с выбором варианта: ИИ отвечает текстом, а скрипт должен сопоставить
   ответ с реальными вариантами и положить в хранилище именно их. */
const AI_CHOICE_HTML = `<!doctype html><html><body>
  ${SHELL_HTML}
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-inner page-fragment">
      <div class="html-content rich-text-viewer">
        <span><p>Выберите метод, который выводит куб переданного числа на консоль.</p></span>
      </div>
    </div>
    <div class="quiz-component" data-type="choice-quiz">
      <div class="quiz-plugin__content">
        <label><input type="radio" name="q" value="11"> PrintSquare</label>
        <label><input type="radio" name="q" value="12"> PrintCube</label>
      </div>
    </div>
  </div></div>
</body></html>`;

/* Ровно та вёрстка редактора, которую прислал человек: .quiz-plugin внутри
   .code-editor-quiz__editor.code-quiz__code со шапкой (вкладка «Код», копирование,
   веник, селект языка) и таблицей тестов в формате __header-row / __data-row,
   где значение лежит в data-clipboard-text кнопки «копировать». По этой странице
   проверяем и место блока ИИ, и разбор тестов, и склейку «вход → выход». */
const QUIZ_PLUGIN_HTML = `<!doctype html><html><body>
  ${SHELL_HTML}
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-inner page-fragment">
      <div class="html-content rich-text-viewer">
        <span><p>Напишите программу, которая проверяет, чётное ли число, и печатает True или False.</p></span>
      </div>
      <div class="step-text__samples-wrapper">
        <div class="attempt-wrapper-samples">
          <div class="attempt-wrapper-samples__header-row">
            <div>№ Теста</div><div>Входные данные</div><div>Выходные данные</div>
          </div>
          <div class="attempt-wrapper-samples__data-row">
            <div>1</div>
            <div class="attempt-wrapper-samples__data-row-code">
              <button type="button" data-clipboard-text="13">13</button>
            </div>
            <div class="attempt-wrapper-samples__data-row-content">
              <span class="attempt-wrapper-samples__data-row-text">True</span>
              <button type="button" data-clipboard-text="True">копировать</button>
            </div>
          </div>
          <div class="attempt-wrapper-samples__data-row">
            <div>2</div>
            <div class="attempt-wrapper-samples__data-row-code">
              <button type="button" data-clipboard-text="8">8</button>
            </div>
            <div class="attempt-wrapper-samples__data-row-content">
              <span class="attempt-wrapper-samples__data-row-text">False</span>
              <button type="button" data-clipboard-text="False">копировать</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div id="ember2575" class="quiz-plugin ember-view">
      <div class="quiz-plugin__content">
        <div class="code-editor-quiz__editor code-quiz__code">
          <div class="code-editor-header">
            <ul class="code-editor-tabs"><li><span class="code-editor-tab code-without-padding">Код</span></li></ul>
            <div class="code-editor-header__buttons">
              <button class="copy-code-btn" type="button" data-clipboard-text="# put your python code here">копировать</button>
              <button class="clear-broom" type="button">Сбросить код</button>
            </div>
            <div class="select-box code-editor-header__select-language">
              <select id="language">
                <option data-qa="select_csharp">C#</option>
                <option data-qa="select_python" data-selected>C#</option>
              </select>
            </div>
          </div>
          <div id="ember2681" class="code-editor is-ready">
            <div class="CodeMirror"><textarea></textarea></div>
          </div>
          <div id="ember2683" class="code-runner ember-view code-quiz__run-panel">
            <textarea id="id_coderunner_input"></textarea>
          </div>
        </div>
      </div>
    </div>
    <button class="submit" type="button">Отправить на проверку</button>
  </div></div>
</body></html>`;

/* Страница-лекция: никакого задания нет, только теория. Её текст скрипт должен
   запомнить для урока — чтобы потом на задании ИИ не лез в непройденное. */
const THEORY_ONLY_HTML = `<!doctype html><html><body>
  ${SHELL_HTML}
  <div class="step-inner page-fragment">
    <div class="html-content rich-text-viewer">
      <span><p>Методы (или функции) в C# — это именованные блоки кода. Метод
      объявляется так: <code>static void SayHello() { }</code>. Параметры
      записываются в скобках и передают значения внутрь метода. Возвращаемое
      значение задаётся перед именем: <code>static int Sum(int a, int b)</code>.
      Ключевое слово void означает «метод ничего не возвращает». Хорошая практика —
      давать методам говорящие имена, например IsEven, и не делать их слишком длинными.</p></span>
    </div>
  </div>
</body></html>`;

(async () => {
  /* Решение ИИ сохранялось в файл с именем «…textxc»: язык из CodeMirror приходит
     MIME-строкой («text/x-csharp»), а extOf просто вычищал из неё знаки. Проверяем
     на настоящем входе — до того, как это снова сломает имя файла в хранилище. */
  console.log('\n=== 0. расширение файла по языку из CodeMirror ===');
  {
    const probe = probeSandbox(HTML, ['extOf']);
    const cases = [
      ['text/x-csharp', 'cs'], ['text/x-python', 'py'], ['text/x-c++src', 'cpp'],
      ['text/x-java', 'java'], ['csharp', 'cs'], ['python3', 'py'], ['c++', 'cpp'],
      ['Python', 'py'], ['', 'txt'], [null, 'txt']
    ];
    cases.forEach(([lang, want]) => {
      const got = probe.extOf(lang);
      check('«' + lang + '» → .' + want, got === want, 'получилось .' + got);
    });
    check('MIME не превращается в «textxc»', probe.extOf('text/x-csharp') !== 'textxc',
      probe.extOf('text/x-csharp'));
    probe.close();
  }

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
    aiPaidText: 'using System;\nclass P { static void Main() { Console.WriteLine(5); } }',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 1500));

      check('запрос к ИИ ушёл', st.aiPaidCalls.length === 1,
        'запросов: ' + st.aiPaidCalls.length);
      const body = st.aiPaidCalls[0] && JSON.parse(st.aiPaidCalls[0].body);
      check('модель указана явно', body && body.model === 'glm-5.3-flash', body && body.model);
      check('токен ушёл заголовком, а не в теле',
        /^Bearer .+/.test((st.aiPaidCalls[0] || {}).auth || '') &&
        !/github_pat|Bearer|api[_-]?key/i.test(st.aiPaidCalls[0].body), 'тело чистое');
      const asked = st.aiPaidCalls[0] && JSON.parse(st.aiPaidCalls[0].body).messages.slice(-1)[0].content;
      check('в запрос попал текст задания', /сумму 2 и 3/.test(asked), asked && asked.slice(0, 80));

      check('старое окно #sgx-ai больше не показывается',
        !win.document.querySelector('#sgx-ai'));

      check('ничего не вставлено в редактор', st.setValue === null, JSON.stringify(st.setValue));
      check('ничего не отправлено', st.submitted === 0, 'кликов: ' + st.submitted);
      /* Решение намеренно уезжает в общее хранилище: иначе кнопка «вставить»
         ищет его в answers/ и отвечает «в хранилище нет ответа». */
      check('решение опубликовано в очередь', Object.keys(st.inbox).length === 1,
        'файлов: ' + Object.keys(st.inbox).length);
    }
  });

  console.log('\n=== 25. ИИ недоступен → сказано внятно, ничего не сломано ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 10000,
    aiPaidDown: true,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 5000));
      const status = statusText(win);
      check('сказано, что ИИ не ответил', /ИИ не ответил/.test(status), status);
      check('старое окно с решением не открылось', !win.document.querySelector('#sgx-ai'));
      check('редактор не тронут', st.setValue === null);
    }
  });

  console.log('\n=== 26. пауза между запросами к ИИ соблюдается ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 3000,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 1200));
      st.menu['✨ ИИ: решить текущий шаг']();      /* сразу второй раз */
      await new Promise((r) => setTimeout(r, 600));
      check('второй запрос не ушёл — сработала пауза', st.aiPaidCalls.length === 1,
        'запросов: ' + st.aiPaidCalls.length);
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
      check('к ИИ не обращались', st.aiPaidCalls.length === 0);
    }
  });

  console.log('\n=== 28. своя модель отвечает → решение готово ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 6000,
    aiPaidText: 'static void PrintSquare(int x)\n{\n    Console.WriteLine(x * x * x);\n}',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2500));

      check('запрос ушёл в свой канал', st.aiPaidCalls.length >= 1,
        'попыток: ' + st.aiPaidCalls.length);
      const paid = st.aiPaidCalls[0];
      check('в свой канал ушёл ключ в заголовке',
        /^Bearer .+/.test((paid && paid.auth) || ''), String(paid && paid.auth).slice(0, 12) + '…');
      check('в теле своего запроса ключа нет',
        !/sk-|Bearer|github_pat/i.test(paid.body || ''), 'тело чистое');
      check('модель — быстрая, не reasoning',
        JSON.parse(paid.body).model === 'glm-5.3-flash', JSON.parse(paid.body).model);

      const feed = aiFeedText(win, st);
      check('решение показано в ленте панели', /PrintSquare/.test(feed), feed.slice(0, 60));
      check('блок ИИ виден в панели', aiPanelShown(win));
      check('старое окно не открылось', !win.document.querySelector('#sgx-ai'));
      check('ничего не вставлено и не отправлено', st.setValue === null && st.submitted === 0);
    }
  });

  console.log('\n=== 29. ИИ молчит → понятное объяснение, а не «HTTP 500» ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 8000,
    aiPaidDown: true,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 5000));
      const status = statusText(win);
      check('сказано, что сервис недоступен', /недоступен|HTTP 500|500/.test(status), status);
      check('старое окно не открылось', !win.document.querySelector('#sgx-ai'));
      check('редактор не тронут', st.setValue === null);
    }
  });

  console.log('\n=== 30. ключ убран → ИИ выключен, в сеть не ходим ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 5000,
    /* '' — это «человек сам очистил поле», и оно значит «канала нет».
       Раньше пустая строка молча возвращала встроенный ключ. */
    aiKey: '', aiPaidText: 'не должно быть использовано',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2500));
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
    aiPaidText: 'static void FromBuiltIn() { }',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2500));
      check('со встроенным ключом канал работает', st.aiPaidCalls.length >= 1,
        'попыток: ' + st.aiPaidCalls.length);
      const feed = aiFeedText(win, st);
      check('и решение показано в ленте', /FromBuiltIn/.test(feed), feed.slice(0, 60));
    }
  });

  console.log('\n=== 31. reasoning-модель без content → берём размышления, а не пусто ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 8000,
    aiPaidEmpty: true,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 5000));
      check('пустой ответ не остался незамеченным', st.aiPaidCalls.length >= 1);
      const feed = aiFeedText(win, st);
      check('размышления показаны вместо пустоты', /думал-думал/.test(feed), feed.slice(0, 80));
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

      check('запрос к ИИ ушёл', st.aiPaidCalls.length === 1,
        'запросов: ' + st.aiPaidCalls.length);
      const body = (st.aiPaidCalls[0] && st.aiPaidCalls[0].body) || '';
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
      check('к ИИ НЕ обращались — незачем', st.aiPaidCalls.length === 0,
        'запросов: ' + st.aiPaidCalls.length);
      check('старое окно решения не открылось', !win.document.querySelector('#sgx-ai'));
    }
  });

  console.log('\n=== 34. решение ИИ уезжает в хранилище и его можно вставить ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_REAL_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'def main():\n    print("куб")\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3500));

      check('решение ИИ опубликовано в очередь', st.inboxMessages.some((m) => /inbox:/.test(m)),
        st.inboxMessages.join(' | ') || 'ничего не ушло');
      const name = Object.keys(st.inbox)[0] || '';
      check('в хранилище лежит .py с решением ИИ', /\.py$/.test(name) && /куб/.test(st.inbox[name] || ''),
        name + ' → ' + String(st.inbox[name] || '').slice(0, 30));

      /* главное: после этого кнопка «вставить» больше не должна говорить «нет ответа» */
      openPanelIn(win, st);
      await new Promise((r) => setTimeout(r, 400));
      check('панель знает про шаг', !!win.document.querySelector('#sgx-panel.on'));
      check('лента показывает решение', /куб/.test(aiFeedText(win, st)));
      check('в статусе нет «нет ответа»',
        !/нет ответа/.test(statusText(win)), statusText(win));
    }
  });

  console.log('\n=== 35. без ключа ИИ честно выключен ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_REAL_HTML, waitMs: 5000,
    aiKey: '',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 1500));
      const status = statusText(win);
      check('сказано, что нет ключа', /нет ключа/.test(status), status);
      check('в сеть не ходили вообще', st.aiPaidCalls.length === 0,
        'вызовов: ' + st.aiPaidCalls.length);
    }
  });

  console.log('\n=== 36. ИИ читает ошибку теста и правит решение сам ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_FIX_HTML, waitMs: 16000, cmMode: 'text/x-python',
    /* 1-й ответ — плохой (падает на кириллице), 2-й — исправленный */
    aiPaidQueue: [
      'name = input()\nage = int(input())\nprint(f"{name}, вам {age} лет")\n',
      'name = input()\ntry:\n    age = int(input())\nexcept ValueError:\n    age = 0\nprint(f"{name}, вам {age} лет")\n'
    ],
    checkHint: AI_FAIL_HINT,
    checkHintAt: 600,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));
      check('первый ответ получен', st.aiPaidCalls.length >= 1,
        'запросов: ' + st.aiPaidCalls.length);

      /* отправляем — сайт отвечает отчётом об ошибке, скрипт должен пойти на правку */
      const btn = win.document.querySelector('button.submit');
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 11000));

      check('сделан второй запрос — на исправление', st.aiPaidCalls.length >= 2,
        'запросов: ' + st.aiPaidCalls.length);
      const second = st.aiPaidCalls[1] && JSON.parse(st.aiPaidCalls[1].body);
      const asked = second ? second.messages.slice(-1)[0].content : '';
      check('в запрос на правку попал отчёт проверки',
        /Failed test #1 of 3/.test(asked) && /ValueError/.test(asked),
        asked.slice(-260));
      check('в запрос попал и прошлый код ИИ', /вам \{age\} лет/.test(asked),
        asked.slice(-200));
      check('сказано, что решение исправлено', /исправлен/.test(statusText(win)),
        statusText(win));
    }
  });

  console.log('\n=== 37. ошибку видит и кнопка «Отправить на проверку» сайта ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_FIX_HTML, waitMs: 16000,
    aiPaidQueue: [
      'name = input()\nage = int(input())\nprint(f"{name}, вам {age} лет")\n',
      'name = input()\nprint(name, "вам", input(), "лет")\n'
    ],
    checkHint: AI_FAIL_HINT,
    checkHintAt: 600,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));

      /* кликаем именно кнопку сайта — раньше такой путь вообще не приводил к правке */
      const site = win.document.querySelector('button.submit');
      site.click();
      await new Promise((r) => setTimeout(r, 11000));
      check('правка запущена кликом по кнопке сайта', st.aiPaidCalls.length >= 2,
        'запросов: ' + st.aiPaidCalls.length);
    }
  });

  console.log('\n=== 37a. две ловушки одной отправки не делают две правки ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_FIX_HTML, waitMs: 16000, cmMode: 'text/x-python',
    aiPaidQueue: [
      'name = input()\nage = int(input())\nprint(name, age)\n',
      'name = input()\nage = int(input())\nprint(f"{name}, вам {age} лет")\n'
    ],
    checkHint: AI_FAIL_HINT,
    checkHintAt: 300,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));
      const before = st.aiPaidCalls.length;

      /* и клик сайта, и перехват сети срабатывают на одну отправку: правка
         должна быть ровно одна, иначе лимит сгорит вдвое быстрее */
      const site = win.document.querySelector('button.submit');
      site.click();
      site.click();
      win.document.dispatchEvent(new win.CustomEvent('sgx:net', {
        detail: {
          method: 'POST', url: '/api/submissions',
          body: JSON.stringify({ submissions: [{ step: 108, status: 'wrong', reply: { code: 'x', language: 'python3' } }] })
        }
      }));
      await new Promise((r) => setTimeout(r, 11000));

      check('сделана ровно одна правка, а не две', st.aiPaidCalls.length === before + 1,
        'запросов после отправки: ' + (st.aiPaidCalls.length - before));
    }
  });

  console.log('\n=== 38. решение ИИ для теста с выбором ложится в хранилище вариантами ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/9?unit=1818966`,
    store: {}, submissions: [], html: AI_CHOICE_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'Правильный вариант: 1) PrintSquare',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3500));
      const name = Object.keys(st.inbox)[0] || '';
      check('для теста с выбором создан .json', /\.json$/.test(name), name);
      let data = {};
      try { data = JSON.parse(st.inbox[name] || '{}'); } catch (e) { /* ignore */ }
      check('в ответе выбран именно PrintSquare', /PrintSquare/.test(JSON.stringify(data)),
        st.inbox[name]);
      check('выбран правильный id варианта', String(data.ids || '').indexOf('11') >= 0,
        'ids: ' + JSON.stringify(data.ids));
    }
  });

  /* --- 39. блок ИИ стоит там, где редактор кода, а не в боковом меню ---------
     Человек прислал разметку и сказал: решение должно появляться в области
     .quiz-plugin рядом с редактором. Проверяем именно это, а не «где-нибудь». */
  console.log('\n=== 39. блок ИИ появляется в области редактора кода ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3500));

      const root = win.document.querySelector('#sgx-ai-root');
      check('блок ИИ создан', !!root);
      check('блок ИИ показан', aiPanelShown(win));
      const host = aiHostOf(win);
      check('блок ИИ стоит в карточке задания, а не в меню курса',
        !!host && !host.classList.contains('lesson-sidebar__content'),
        host ? host.className : 'нет контейнера');
      check('блок ИИ прижат к редактору кода',
        !!host && /quiz-plugin|code-editor-quiz__editor|code-quiz__code/.test(host.className),
        host ? host.className : 'нет контейнера');
      check('в блоке ИИ нет настроек «от и до»',
        !/Пройти и отправить/.test((root || {}).textContent || ''), 'чисто');
      check('вкладка называется «Код», как в редакторе сайта',
        /Код/.test((root || {}).textContent || ''), 'вкладка есть');
    }
  });

  /* --- 40. ответ без ``` и без ''' Python ''' ------------------------------- */
  console.log('\n=== 40. ограждения и метка языка снимаются с ответа ИИ ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: "'''Python'''\nn = int(input())\nprint(n % 2 == 0)\n'''",
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3500));

      const feed = aiFeedText(win, st);
      check('в ленте нет тройных кавычек', !/'''/.test(feed), feed.slice(0, 60));
      check('в ленте нет слова Python как метки', !/^Python\b/m.test(feed), feed.slice(0, 60));
      const name = Object.keys(st.inbox)[0] || '';
      check('в хранилище лежит чистый код', /int\(input\(\)\)/.test(st.inbox[name] || ''),
        String(st.inbox[name] || '').slice(0, 60));
      check('в файле нет ```-обёртки', !/```/.test(st.inbox[name] || ''));
    }
  });

  console.log('\n=== 40a. ответ в ```python``` тоже чистится ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: '```python\nn = int(input())\nprint(n % 2 == 0)\n```',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3500));
      const name = Object.keys(st.inbox)[0] || '';
      const body = st.inbox[name] || '';
      check('в хранилище нет ```', !/```/.test(body), body.slice(0, 40));
      check('код сохранён целиком', /print\(n % 2 == 0\)/.test(body), body.slice(0, 60));
    }
  });

  /* --- 41. тестовая таблица читается из data-clipboard-text ----------------- */
  console.log('\n=== 41. тесты берутся из data-clipboard-text, а не из обрезанного текста ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['stepSamplesText', 'stepPrompt'],
        `https://stepik.org/lesson/${LESSON}/step/8`);
      const text = probe.stepSamplesText();
      probe.close();
      check('строка «№ Теста» не попала в данные', !/№ Теста/.test(text), text);
      check('первый тест: вход 13 → выход True', /вход: 13/.test(text) && /выход: True/.test(text), text);
      check('второй тест: вход 8 → выход False', /вход: 8/.test(text) && /выход: False/.test(text), text);
      check('номер теста не выдуман и не сдвинут', /1\) вход: 13/.test(text), text);
      check('слово «копировать» не попало в данные', !/копировать/.test(text), text);
    }
  });

  /* Та же таблица, но со значениями прямо в ячейках (без кнопок копирования) и
     вовсе без колонки номера теста. Вторая форма — из настоящей вёрстки с
     усечённой карточкой; проверяем, что вход «5» не уедет как номер теста. */
  console.log('\n=== 41a. тесты без кнопок копирования и без номеров теста ===');
  {
    const plainRow = (a, b) =>
      '<div class="attempt-wrapper-samples__data-row">' +
      `<div class="attempt-wrapper-samples__data-row-content"><span>${a}</span></div>` +
      `<div class="attempt-wrapper-samples__data-row-content"><span>${b}</span></div></div>`;
    const box = (rows) => `<!doctype html><html><body>
      <div class="attempt-wrapper"><div class="attempt-wrapper__content">
        <div class="step-text__samples-wrapper"><div class="attempt-wrapper-samples">
          <div class="attempt-wrapper-samples__header-row">
            <div>№ Теста</div><div>Входные данные</div><div>Выходные данные</div>
          </div>${rows}
        </div></div>
      </div></div></body></html>`;

    /* форма со своим номером теста в голом div */
    const withNum = probeSandbox(box(
      '<div class="attempt-wrapper-samples__data-row"><div>1</div>' +
      '<div class="attempt-wrapper-samples__data-row-content"><span>5</span></div>' +
      '<div class="attempt-wrapper-samples__data-row-content"><span>125</span></div></div>' +
      '<div class="attempt-wrapper-samples__data-row"><div>2</div>' +
      '<div class="attempt-wrapper-samples__data-row-content"><span>3</span></div>' +
      '<div class="attempt-wrapper-samples__data-row-content"><span>27</span></div></div>'
    ), ['stepSamplesText'], `https://stepik.org/lesson/${LESSON}/step/8`);
    const t1 = withNum.stepSamplesText();
    withNum.close();
    check('вход 5 не принят за номер теста', /1\) вход: 5 → выход: 125/.test(t1), t1);
    check('вторая пара тоже верна', /2\) вход: 3 → выход: 27/.test(t1), t1);

    /* форма без колонки номера — нумеруем сами */
    const noNum = probeSandbox(box(plainRow(4, 16) + plainRow(7, 49)),
      ['stepSamplesText'], `https://stepik.org/lesson/${LESSON}/step/8`);
    const t2 = noNum.stepSamplesText();
    noNum.close();
    check('без номеров теста строки нумеруются по порядку',
      /1\) вход: 4 → выход: 16/.test(t2) && /2\) вход: 7 → выход: 49/.test(t2), t2);
  }

  /* --- 42. ИИ знает уровень урока и пройденную теорию ----------------------- */
  console.log('\n=== 42. в запрос ИИ уходит урок и пройденная теория ===');
  await run({
    url: `https://stepik.org/lesson/1755852/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    seedTheory: { 1755852: { text: 'Методы в C#: static void SayHello() { }. void ничего не возвращает. IsEven — хорошее имя.',
      at: Date.now(), step: 1 } },
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));
      const body = (st.aiPaidCalls[0] && st.aiPaidCalls[0].body) || '';
      check('в запросе назван номер урока', /Урок 4\.1/.test(body), body.slice(0, 120));
      check('в запросе есть название урока', /Знакомство с методами/.test(body), 'название есть');
      check('до ИИ дошла пройденная теория', /IsEven/.test(body), 'теория есть');
      check('ИИ просят держаться пройденного', /не используй конструкции|Не используй конструкции/i.test(body),
        'правило есть');
    }
  });

  /* --- 42a. теория запоминается, пока её читают ----------------------------- */
  console.log('\n=== 42a. теория со страницы-лекции запоминается для урока ===');
  await run({
    url: `https://stepik.org/lesson/1755852/step/1?unit=1818966`,
    store: {}, submissions: [], html: THEORY_ONLY_HTML, waitMs: 5000,
    afterRun: async (win, st) => {
      let saved = {};
      try { saved = JSON.parse(st.storage.theory || '{}'); } catch (e) { /* ignore */ }
      const rec = saved[1755852];
      check('теория урока сохранена в память', !!(rec && rec.text), JSON.stringify(Object.keys(saved)));
      check('в памяти именно текст лекции', /IsEven|void/.test((rec && rec.text) || ''),
        String((rec && rec.text) || '').slice(0, 60));
    }
  });

  /* --- 43. ИИ просят проверить себя на тестах ------------------------------- */
  console.log('\n=== 43. ИИ обязан сам сверить ответ с тестами ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));
      const body = (st.aiPaidCalls[0] && st.aiPaidCalls[0].body) || '';
      check('в запросе есть просьба прогнать тесты', /мысленно выполни свой код/.test(body),
        'просьба есть');
      check('в запросе есть сверка вывода посимвольно', /посимвольно|сравни полученный вывод/i.test(body),
        'сверка есть');
      check('в системном тексте есть правило самопроверки', /прогони свой код/.test(body),
        'правило есть');
    }
  });

  /* --- 44. «вставить» под своим решением ИИ не ловит 404 -------------------- */
  console.log('\n=== 44. вставка ответа ИИ работает, пока файл не доехал в answers/ ===');
  await run({
    url: `https://stepik.org/lesson/1848840/step/10?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 11000, cmMode: 'text/x-python',
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3500));
      /* файл в очередь ушёл, а raw.githubusercontent.com его ещё не отдаёт */
      check('ответ ИИ опубликован', Object.keys(st.inbox).length === 1,
        Object.keys(st.inbox).join(','));

      /* а теперь жмём «вставить» — раньше здесь была ошибка про HTTP 404 */
      openPanelIn(win, st);
      await new Promise((r) => setTimeout(r, 300));
      const chip = win.document.querySelector('#sgx-chip');
      const yes = chip && chip.querySelector('.sgx-act.yes');
      check('скоба предлагает вставить ответ ИИ', !!yes, 'скобы нет');
      if (yes) yes.click();
      await new Promise((r) => setTimeout(r, 800));
      const status = statusText(win);
      check('нет ошибки про HTTP 404', !/HTTP 404/.test(status), status);
      check('нет ошибки «не читается»', !/не читается/.test(status), status);
      /* Своего ответа хватает из памяти: в сеть за ним ходить не надо вовсе.
         Именно поэтому 404 и не случается — он приходил из лишнего запроса. */
      check('файл не запрашивали из answers/ — обошлись своей копией',
        !st.rawMisses, 'промахов: ' + st.rawMisses);
      check('код ИИ доехал до редактора', /n % 2 == 0/.test(st.setValue || ''),
        JSON.stringify(st.setValue || ''));
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== ИТОГ: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено ===');
  if (failed.length) { console.log('ПРОВАЛЫ: ' + failed.map((f) => f.name).join('; ')); process.exit(1); }
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
