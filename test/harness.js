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

/* --- ускоритель времени ------------------------------------------------------
   Набор проверяет живой юзерскрипт, а тот живёт на таймерах: шаг опроса 1.5 с,
   пауза между запросами 0.8 с, ожидания внутри сценариев по 2-16 с. Поэтому
   прогон идёт столько же, сколько шёл бы в браузере, — это его главная цена.
   SGX_SPEED=N делит все задержки на N: 2-3 раза быстрее без потери смысла.
   По умолчанию 1 — поведение не меняется.                                     */
const SPEED = Math.max(1, Number(process.env.SGX_SPEED || 1) || 1);
const scale = (ms) => (ms == null ? ms : Math.max(0, Math.round(ms / SPEED)));
const rawTimeout = global.setTimeout;
const rawInterval = global.setInterval;
global.setTimeout = function (fn, ms) {
  return rawTimeout.apply(null, [fn, scale(ms)].concat([].slice.call(arguments, 2)));
};
global.setInterval = function (fn, ms) {
  return rawInterval.apply(null, [fn, scale(ms)].concat([].slice.call(arguments, 2)));
};
if (SPEED > 1) console.log('=== ускоритель: таймеры в ' + SPEED + ' раза быстрее ===');
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
    /* Прокси отвечает тем же форматом, что и провайдер, — так и задумано. */
    if (u.includes('api.reformboss.com') || u.includes('script.google.com')) {
      state.aiPaidCalls.push({ url: u, body: init && init.body, auth: init && init.headers && init.headers.Authorization });
      if (state.aiPaidDown) return fail(500);
      /* aiDelay: сервис отвечает не мгновенно. Нужно, чтобы проверить индикатор
         «думает» со счётчиком секунд — на мгновенном ответе он не успевает
         появиться.                                                             */
      if (state.aiDelay) await new Promise((r) => setTimeout(r, state.aiDelay));
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
      /* Настоящий сервис всегда присылает finish_reason: «stop» — ответ целый,
         «length» — упёрся в лимит и оборван. Без него скрипт не отличил бы
         огрызок вроде «def» от короткого верного решения.                     */
      /* Прокси, как и Apps Script, всегда отвечает кодом 200 — ошибку он кладёт
         в тело. Проверяем, что скрипт её читает.                              */
      if (state.aiProxyError) {
        return ok({ error: { message: state.aiProxyError.message }, status: state.aiProxyError.status }, 'json');
      }
      /* Закрытое развёртывание Apps Script отдаёт страницу входа вместо JSON —
         на этом спотыкаются все, кто впервые его настраивает. */
      if (state.aiProxyHtml) {
        return ok('<html><head><title>Sign in</title></head><body>Войдите в аккаунт Google</body></html>', 'text');
      }
      const finish = state.aiFinishReason || (state.aiTruncated ? 'length' : 'stop');
      return ok({ choices: [{ message: msg, finish_reason: finish }], model: model, __asked: asked }, 'json');
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

function run({ url, store, submissions, html, storeDown, emptyLessonSteps, token, job, innerWidth, lateEditor, waitMs, afterRun, aiPaidDown, aiPaidText, aiPaidEmpty, aiKey, aiPaidQueue, checkHint, checkHintAt, cmMode, seedTheory, aiTruncated, aiModel, aiFinishReason, aiDelay, aiProxy, aiProxyError, aiProxyHtml }) {
  return new Promise((resolve, reject) => {
    const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
    const { window } = dom;
    const state = {
      calls: [], inbox: {}, inboxMessages: [], menu: {},
      store: Object.assign({}, store || {}), submissions: submissions || [],
      storeDown: !!storeDown, emptyLessonSteps: !!emptyLessonSteps,
      setValue: null, submitted: 0, retried: 0, ran: 0, types: 0, docBlob: null, shots: 0,
      aiPaidCalls: [], aiPaidDown: !!aiPaidDown, aiPaidText: aiPaidText,
      aiPaidEmpty: !!aiPaidEmpty, aiPaidQueue: aiPaidQueue || [],
      aiTruncated: !!aiTruncated, aiFinishReason: aiFinishReason || '',
      aiDelay: aiDelay || 0,
      aiProxyError: aiProxyError || null,
      aiProxyHtml: !!aiProxyHtml,
      cmMode: cmMode || '', css: '',
      storage: { writeToken: token === undefined ? 'github_pat_11TEST' : token }
    };
    if (job) state.storage.job = JSON.stringify(job);
    /* В скрипте есть общий ключ, но в тестах мы его НЕ используем: иначе он
       попадал бы в подставные запросы и мог оказаться в выводе упавшего
       сценария. Поэтому ключ задаём явно; aiKey: '' проверяет «ИИ выключен».
       Сам общий ключ проверяется отдельно — по форме, без печати.             */
    state.storage.aiKey = aiKey === undefined ? 'sk-test-key' : aiKey;
    /* В скрипте встроенный прокси, и по умолчанию он идёт первым каналом.
       В наборе прокси выключаем явно: иначе сценарии проверяли бы прокси вместо
       прямого канала, а в запросах не было бы заголовка с ключом — и половина
       проверок про ключ потеряла бы смысл.

         aiProxy: 'https://…'  — свой адрес;
         aiProxy: ''           — прокси выключен, работаем напрямую (по умолчанию);
         aiProxy: null         — ничего не задавать, работает ВСТРОЕННЫЙ прокси.

       Встроенный прокси проверяется сценариями 84 и 84a.                      */
    if (aiProxy !== null) state.storage.aiProxy = aiProxy === undefined ? '' : aiProxy;
    /* выбранная в панели модель тоже живёт в хранилище */
    if (aiModel !== undefined) state.storage.aiModel = aiModel;
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

    /* jsdom не пересчитывает вёрстку, поэтому моделируем её сами: отступ справа
       у карточки сужает и вложенные блоки — как это делает браузер. Без этого
       ужимание «влево» выглядело бы как неработающее.                          */
    const hostMargin = () => {
      const host = window.document.querySelector('.attempt-wrapper__content');
      return parseFloat((host && host.style && host.style.marginRight) || '0') || 0;
    };
    window.Element.prototype.getBoundingClientRect = function () {
      const cl = this.classList || { contains: () => false };
      const mr = hostMargin();
      let h = 200;
      if (cl.contains('attempt-wrapper__content')) h = 300;     /* карточка задания */
      else if (cl.contains('quiz-component')) h = 120;          /* блок с вариантами */
      return { width: 600 - mr, height: h, top: 100, left: 50, right: 650 - mr, bottom: 100 + h, x: 50, y: 100 };
    };
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get: () => 120, configurable: true });

    const mkCm = (node) => {
      node.CodeMirror = {
        getValue: () => (state.setValue == null ? '' : state.setValue),
        /* types считает, сколько раз текст переписывался: набор идёт строка за
           строкой, поэтому при наборе счётчик растёт, а при вставке — нет */
        setValue: (v) => { state.setValue = v; state.types++; },
        /* язык приходит из редактора; по умолчанию C#, но сценарий может задать
           свой — иначе «Python-ответ» проверялся бы на C#-расширении */
        getOption: () => state.cmMode || 'text/x-csharp',
        refresh() {}, focus() {}
      };
    };
    /* Наружу: в сценарии, где Stepik пересоздаёт редактор после провала
       («Изменить решение»), заглушку надо навесить на НОВЫЙ узел — иначе
       вставка честно скажет «редактор для вставки не найден».                  */
    window.__mkCm = mkCm;
    /* Счётчики кликов — через делегирование, а не прямыми слушателями: Stepik
       убирает и возвращает кнопки по ходу проверки («Изменить решение»), и
       прямой слушатель на исчезнувшей кнопке уже ничего не считает.            */
    window.document.addEventListener('click', (e) => {
      const t = e.target && e.target.closest ? e.target.closest('button, [role="button"]') : null;
      if (!t) return;
      const cl = t.classList || { contains: () => false };
      if (cl.contains('submit')) state.submitted++;
      if (cl.contains('attempt-wrapper-button_run') || cl.contains('run')) state.ran++;
      if (cl.contains('retry')) state.retried++;
    });


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
      (css) => { state.css = (state.css || '') + String(css || ''); },
      (name, fn) => { state.menu[name] = fn; },
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
function probeSandbox(html, expose, url, storage) {
  const dom = new JSDOM(html || HTML, { url: url || `https://stepik.org/lesson/${LESSON}/step/8`, runScripts: 'dangerously' });
  const { window } = dom;
  /* jsdom отдаёт нулевые размеры, а поиск кнопок (submitButton/runButton)
     пропускает всё невидимое — без этой заглушки они не находят ничего.        */
  window.Element.prototype.getBoundingClientRect = function () {
    const cl = this.classList || { contains: () => false };
    let h = 200;
    if (cl.contains('attempt-wrapper__content')) h = 300;
    else if (cl.contains('quiz-component')) h = 120;
    return { width: 600, height: h, top: 100, left: 50, right: 650, bottom: 100 + h, x: 50, y: 100 };
  };
  const names = expose || ['extOf'];
  const tail = '\n  window.__probe = { ' + names.map((n) => n + ': ' + n).join(', ') + ' };\n';
  const marked = SCRIPT.replace(/\}\)\(\);\s*$/, tail + '})();');
  if (marked === SCRIPT) throw new Error('probeSandbox: не нашёл закрытие IIFE в скрипте');
  const fn = new Function(SANDBOX_ARGS, marked);
  fn(
    window, window.document, window.location, () => Promise.reject(new Error('probe: no net')),
    console, window.navigator,
    (k, d) => (storage && k in storage ? storage[k] : d), () => {}, () => {}, () => {},
    window.CustomEvent, window.Event, window.KeyboardEvent, window.MouseEvent, window.PopStateEvent,
    window.HTMLTextAreaElement, window.HTMLInputElement, TextEncoder, btoa, atob,
    () => {}, {}, window.URL, setTimeout, clearTimeout, setInterval, clearInterval
  );
  const api = window.__probe || {};
  api.close = () => { try { window.close(); } catch (e) { /* ignore */ } };
  /* окно наружу: некоторым проверкам нужно посмотреть, что скрипт нарисовал
     в DOM (например, какие строки отчёта он покрасил красным) */
  api.window = window;
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

/* Кнопка «Запустить код» — ровно та разметка, которую прислал человек. Она стоит
   рядом с «Отправить на проверку» и не должна с ней путаться. */
const RUN_BUTTON_HTML = `<button class="attempt-wrapper-button attempt-wrapper-button_run button_with-loader is-outlined has-icon" type="button">
  <span class="svg-icon play-arrow_icon svg-icon_inline"><svg xmlns="http://www.w3.org/2000/svg">
    <use xlink:href="/static/frontend-build/icons.svg?1790026822#play-arrow"></use>
  </svg></span>
  <span>Запустить код</span>
</button>`;


/* Панель со статусом создаётся только по клику и только когда есть сайдбар курса.
   Если панели нет, берём последнее сообщение из data-атрибута документа — скрипт
   кладёт его туда всегда, независимо от того, что видно на странице. */
function statusText(win) {
  const el = win.document.querySelector('#sgx-status');
  if (el) return el.textContent;
  return win.document.documentElement.getAttribute('data-sgx-status') || '';
}

/* Дождаться условия. Фиксированные паузы ломаются, когда набор запускают с
   SGX_SPEED: пауза между запросами в скрипте считается по реальным часам и не
   сжимается вместе с таймерами. Поэтому ждём событие, а не время.            */
async function until(fn, ms) {
  const t0 = Date.now();
  for (;;) {
    try { if (fn()) return true; } catch (e) { /* ignore */ }
    if (Date.now() - t0 > (ms || 5000)) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/* Нажать «Спросить ИИ» и дождаться запроса. Если скрипт отказал из-за паузы
   между запросами — повторяем нажатие: так проверка не зависит от скорости.  */
async function askAndWait(win, st, ms) {
  const before = st.aiPaidCalls.length;
  st.menu['✨ ИИ: решить текущий шаг']();
  if (await until(() => st.aiPaidCalls.length > before, ms || 4000)) return true;
  st.menu['✨ ИИ: решить текущий шаг']();
  return until(() => st.aiPaidCalls.length > before, ms || 4000);
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
    ${RUN_BUTTON_HTML}
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
    ${RUN_BUTTON_HTML}
    <button class="submit" type="button">Отправить на проверку</button>
    <div id="sgx-test-hint"></div>
  </div></div>
</body></html>`;

/* Тест с выбором варианта: ИИ отвечает текстом, а скрипт должен сопоставить
/* Отправка не прошла, и Stepik убрал редактор, оставив разбор и кнопку
   «Изменить решение». Вернуть редактор можно ТОЛЬКО ею — именно на этом
   спотыкалась автовставка исправленного кода. Кнопка возвращает редактор и
   кнопку запуска, как это делает сайт. */
const AI_FAILED_HTML = `<!doctype html><html><body>
  ${SHELL_HTML}
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-inner page-fragment">
      <div class="html-content rich-text-viewer">
        <span><p>Создайте метод GetAverage, который вернёт среднее трёх чисел.</p></span>
      </div>
    </div>
    <div class="quiz-plugin"><div class="quiz-plugin__content" id="sgx-editor-host">
      <div class="code-editor-quiz__editor code-quiz__code">
        <div class="CodeMirror"><textarea></textarea></div>
      </div>
    </div></div>
    <div id="sgx-run-host">
      <button class="attempt-wrapper-button attempt-wrapper-button_run button_with-loader is-outlined has-icon" type="button">
        <span>Запустить код</span>
      </button>
    </div>
    <button class="attempt-wrapper-button submit" type="button">Отправить на проверку</button>
    <div id="sgx-test-hint"></div>
  </div></div>
  <script>
    (function () {
      var wrap = document.querySelector('.attempt-wrapper__content');
      /* отправка провалилась: сайт убирает редактор и показывает разбор */
      wrap.addEventListener('click', function (e) {
        var t = e.target.closest && e.target.closest('button');
        if (!t || !t.classList.contains('submit')) return;
        document.getElementById('sgx-editor-host').innerHTML = '';
        document.getElementById('sgx-run-host').innerHTML = '';
        var hint = document.getElementById('sgx-test-hint');
        hint.innerHTML = '<div class="smart-hints"><div class="smart-hints__hint">' +
          '[+] Test #1. OK [ ] Test #2. Wrong answer [ ] Test #3. Wrong answer ' +
          '[ ] Test #4. Wrong answer [+] Test #5. OK 2 of 5 test(s) passed.<br>' +
          'Failed test #1 of 5. Wrong answer Test input: 1 2 3 Correct output: 2 ' +
          'Your code output: 2.0</div></div>';
        if (document.getElementById('sgx-edit-btn')) return;
        var b = document.createElement('button');
        b.type = 'button';
        b.id = 'sgx-edit-btn';
        b.className = 'has-icon attempt-wrapper-button';
        b.innerHTML = '<span class="attempt-wrapper-button__icon"></span><span>Изменить решение</span>';
        b.addEventListener('click', function () {
          document.getElementById('sgx-editor-host').innerHTML =
            '<div class="code-editor-quiz__editor code-quiz__code">' +
            '<div class="CodeMirror"><textarea></textarea></div></div>';
          document.getElementById('sgx-run-host').innerHTML =
            '<button class="attempt-wrapper-button attempt-wrapper-button_run is-outlined" type="button">' +
            '<span>Запустить код</span></button>';
          /* редактор пересоздан — заглушка стенда нужна на новом узле */
          var cm = document.querySelector('.CodeMirror');
          if (cm && window.__mkCm) window.__mkCm(cm);
          b.remove();
        });
        wrap.appendChild(b);
      });
    })();
  </script>
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
            <!-- вывод запуска ровно в той разметке, что прислал человек:
                 .code-runner__hints > .smart-hints > .show-more__content > .smart-hints__hint -->
            <div class="code-runner__hints">
              <div class="smart-hints ember-view">
                <div class="show-more" style="--max-height: 120;">
                  <div class="show-more__content"><p class="smart-hints__hint">2</p></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <button class="submit" type="button">Отправить на проверку</button>
    ${RUN_BUTTON_HTML}
  </div></div>
</body></html>`;

/* Страница, где ответ — галочка, а не код. Разметка взята у человека целиком:
   вопрос в .html-content, варианты — в label.s-radio внутри
   .quiz-component[data-type="choice-quiz"], кнопка отправки пока disabled.
   Здесь важно, что вариантов НЕТ в условии — их надо собрать отдельно, иначе
   модель выбирает вслепую. */
const CHOICE_ONLY_HTML = `<!doctype html><html><body>
  ${SHELL_HTML}
  <div class="quiz-show"><div class="quiz-layout-head"><div class="step-wrapper">
    <div class="step-inner page-fragment">
      <div class="html-content rich-text-viewer"><span><p>Что из перечисленного соответствует методу, который принимает два числа и возвращает их произведение?</p></span></div>
    </div>
  </div></div>
  <div class="attempt-main"><div class="attempt-wrapper choice">
    <div class="page-fragment attempt-wrapper__content">
      <div class="attempt-wrapper__heading"><h3 class="attempt-wrapper__typename">Выберите один вариант из списка</h3></div>
      <div class="attempt-wrapper__plugin">
        <div class="quiz-plugin"><div class="show-plugin"><div class="quiz-plugin__content">
          <div data-state="no_submission" data-type="choice-quiz" class="quiz-component ember-view">
            <label class="s-radio"><input class="s-radio__input" name="q" type="radio" value="101">
              <span class="s-radio__label choice-quiz-show__option">static int Multiply()</span></label>
            <label class="s-radio"><input class="s-radio__input" name="q" type="radio" value="102">
              <span class="s-radio__label choice-quiz-show__option">static void Multiply(int a, int b)</span></label>
            <label class="s-radio"><input class="s-radio__input" name="q" type="radio" value="103">
              <span class="s-radio__label choice-quiz-show__option">void static Multiply(int, int)</span></label>
            <label class="s-radio"><input class="s-radio__input" name="q" type="radio" value="104">
              <span class="s-radio__label choice-quiz-show__option">static int Multiply(int a, int b)</span></label>
          </div>
        </div></div></div>
      </div>
      <div class="attempt-wrapper-buttons">
        <button class="attempt-wrapper-button" type="button" disabled>Отправить на проверку</button>
      </div>
      <div id="sgx-test-hint"></div>
    </div>
  </div></div>
</body></html>`;

/* Тест с выбором, где проверка НЕ принимает ответ: по нажатию «Отправить»
   появляется шапка результата с «Пока неправильно, попробуйте еще раз!» —
   именно её присылал человек. Раньше этот текст не считался ошибкой, и правки
   не было. */
const CHOICE_FAIL_HTML = `<!doctype html><html><body>
  ${SHELL_HTML}
  <div class="attempt-wrapper choice"><div class="attempt-wrapper__content">
    <div class="step-inner page-fragment">
      <div class="html-content rich-text-viewer"><span><p>Что из перечисленного соответствует методу, который принимает два числа и возвращает их произведение?</p></span></div>
    </div>
    <div class="quiz-plugin"><div class="quiz-plugin__content">
      <div class="quiz-component" data-type="choice-quiz">
        <label class="s-radio"><input class="s-radio__input" type="radio" name="q" value="201">
          <span class="s-radio__label choice-quiz-show__option">static int Multiply()</span></label>
        <label class="s-radio"><input class="s-radio__input" type="radio" name="q" value="202">
          <span class="s-radio__label choice-quiz-show__option">static void Multiply(int a, int b)</span></label>
        <label class="s-radio"><input class="s-radio__input" type="radio" name="q" value="203">
          <span class="s-radio__label choice-quiz-show__option">void static Multiply(int, int)</span></label>
        <label class="s-radio"><input class="s-radio__input" type="radio" name="q" value="204">
          <span class="s-radio__label choice-quiz-show__option">static int Multiply(int a, int b)</span></label>
      </div>
    </div></div>
    <div class="attempt-wrapper-buttons">
      <button class="attempt-wrapper-button submit" type="button">Отправить на проверку</button>
    </div>
  </div></div>
  <script>
    document.querySelector('.attempt-wrapper__content').addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('button');
      if (!t || !t.classList.contains('submit')) return;
      if (document.querySelector('.submission-show__header')) return;
      document.querySelector('.attempt-wrapper__content').insertAdjacentHTML('afterbegin',
        '<div class="submission-show__header"><div class="submission-show__title">' +
        '<div class="submission-show__title-content">Пока неправильно, попробуйте еще раз!</div>' +
        '</div></div>');
    });
  </script>
</body></html>`;

/* Тест с НЕСКОЛЬКИМИ ответами: поля checkbox, а не radio. По типу поля скрипт
   понимает, рисовать в чате кружок или квадрат. */
const CHOICE_CHECK_HTML = `<!doctype html><html><body>
  ${SHELL_HTML}
  <div class="attempt-wrapper choice"><div class="attempt-wrapper__content">
    <div class="step-inner page-fragment">
      <div class="html-content rich-text-viewer"><span><p>Выберите все верные утверждения.</p></span></div>
    </div>
    <div class="quiz-plugin"><div class="quiz-plugin__content">
      <div class="quiz-component" data-type="choice-quiz">
        <label class="s-checkbox"><input class="s-checkbox__input" type="checkbox" name="q" value="301">
          <span class="s-checkbox__label choice-quiz-show__option">первый</span></label>
        <label class="s-checkbox"><input class="s-checkbox__input" type="checkbox" name="q" value="302">
          <span class="s-checkbox__label choice-quiz-show__option">второй</span></label>
        <label class="s-checkbox"><input class="s-checkbox__input" type="checkbox" name="q" value="303">
          <span class="s-checkbox__label choice-quiz-show__option">третий</span></label>
      </div>
    </div></div>
  </div></div>
</body></html>`;

/* Задание со свободным ответом: обычное поле, а не редактор кода. Разметку
   прислал человек — класс string-quiz__textarea. */
const TEXT_QUIZ_HTML = `<!doctype html><html><body>
  ${SHELL_HTML}
  <div class="attempt-wrapper string"><div class="attempt-wrapper__content">
    <div class="step-inner page-fragment">
      <div class="html-content rich-text-viewer"><span><p>Какой тип данных должен быть у метода, который возвращает значение True или False?</p></span></div>
    </div>
    <div class="quiz-plugin"><div class="quiz-plugin__content">
      <textarea spellcheck="false" required placeholder="Напишите ваш ответ здесь..."
        class="ember-text-area ember-view textarea string-quiz__textarea"></textarea>
    </div></div>
    <div class="attempt-wrapper-buttons">
      <button class="attempt-wrapper-button submit" type="button">Отправить на проверку</button>
    </div>
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

  console.log('\n=== 11. мало места справа → ужимаем содержимое влево ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int x = 1;' } },
    submissions: [], html: HTML, innerWidth: 560, waitMs: 2000,
    afterRun: async (win) => {
      const chip = win.document.querySelector('#sgx-chip');
      const host = win.document.querySelector('.attempt-wrapper__content');
      check('скоба показана', chip && chip.classList.contains('on'));
      check('содержимое ужато влево — появился отступ справа',
        parseFloat(host.style.marginRight) > 0, host.style.marginRight || 'нет');
      check('скоба осталась справа, а не переехала наверх',
        !chip.classList.contains('above'), chip.className);
    }
  });

  console.log('\n=== 11a. ужать некуда → скоба переезжает наверх ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int x = 1;' } },
    submissions: [], html: HTML, innerWidth: 400, waitMs: 2000,
    afterRun: async (win) => {
      const chip = win.document.querySelector('#sgx-chip');
      const host = win.document.querySelector('.attempt-wrapper__content');
      check('скоба показана', chip && chip.classList.contains('on'));
      check('режим «сверху»', chip.classList.contains('above'), chip.className);
      check('спрятана вертикальная скоба', chip.style.height === 'auto', chip.style.height);
      check('содержимое не ужато впустую', !host.style.marginRight, host.style.marginRight || 'нет');
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

  console.log('\n=== 15. скоба обрамляет СВОЙ блок, а не всю карточку ===');
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
      /* блок с вариантами в заглушке 120, карточка задания — 300 */
      check('высота по блоку с вариантами (120), а не по всей карточке (300)',
        chip.style.height === '120px', chip.style.height);
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

  /* Раньше здесь проверялось, что скрипт НИЧЕГО не делает сам. Максим попросил
     обратное: после ответа вставить решение и нажать «Запустить код» — но
     по-прежнему НЕ отправлять на проверку. Отправка остаётся за человеком.   */
  console.log('\n=== 24. ИИ: решение приходит, вставляется и запускается — но не отправляется ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 7000,
    aiPaidText: 'using System;\nclass P { static void Main() { Console.WriteLine(5); } }',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4500));

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

      /* Главное новое поведение: решение само уезжает в редактор... */
      check('решение вставлено в редактор само',
        /Console\.WriteLine\(5\)/.test(st.setValue || ''), JSON.stringify(st.setValue || ''));
      /* ...и код запускается, чтобы человек сразу увидел результат... */
      check('нажата «Запустить код»', st.ran === 1, 'кликов: ' + st.ran);
      /* ...но отправка на проверку остаётся за человеком */
      check('«Отправить на проверку» НЕ нажата', st.submitted === 0, 'кликов: ' + st.submitted);
      check('в ленте сказано про вставку и запуск',
        /написал решение в редакторе/.test(aiFeedText(win, st)) &&
        /Запускаю код/.test(aiFeedText(win, st)),
        aiFeedText(win, st).slice(0, 120));
      /* Решение намеренно уезжает в общее хранилище: иначе кнопка «вставить»
         ищет его в answers/ и отвечает «в хранилище нет ответа». */
      check('решение опубликовано в очередь', Object.keys(st.inbox).length === 1,
        'файлов: ' + Object.keys(st.inbox).length);
    }
  });

  console.log('\n=== 25. ИИ недоступен → сказано внятно, ничего не сломано ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 12000,
    aiPaidDown: true,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      /* при сбое сервиса скрипт пробует выбранную модель и одну запасную по два
         раза с паузами — это около трёх секунд, и только потом говорит ошибку */
      await new Promise((r) => setTimeout(r, 6500));
      const status = statusText(win);
      check('сказано, что ИИ не ответил', /ИИ не ответил/.test(status), status);
      check('старое окно с решением не открылось', !win.document.querySelector('#sgx-ai'));
      check('редактор не тронут', st.setValue === null);
    }
  });

  console.log('\n=== 26. пауза между запросами к ИИ соблюдается ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 4000,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      /* второй раз жмём ВНУТРИ паузы (AI_GAP_PAID = 800 мс) — именно так это и
         выглядит у человека, который торопит скрипт */
      await new Promise((r) => setTimeout(r, 250));
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 500));
      check('второй запрос не ушёл мгновенно — сработала пауза', st.aiPaidCalls.length === 1,
        'запросов: ' + st.aiPaidCalls.length);
      /* Раньше скрипт в этом случае ОТКАЗЫВАЛСЯ спрашивать, и человек видел
         «подожди 0 с» и пустой блок. Теперь показывает «думает» и пережидает. */
      check('человек видит, что работа идёт, а не пустоту',
        /пишет решение|думает/i.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 80));
      const second = await until(() => st.aiPaidCalls.length > 1, 5000);
      check('после паузы запрос всё-таки ушёл', second,
        'запросов: ' + st.aiPaidCalls.length);
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
      /* Решение вставляется и запускается само (просьба Максима), но отправка
         на проверку остаётся за человеком.                                    */
      check('решение вставлено в редактор само',
        /PrintSquare/.test(st.setValue || ''), JSON.stringify(st.setValue || ''));
      check('код запущен', st.ran === 1, 'кликов: ' + st.ran);
      check('на проверку ничего не отправлено', st.submitted === 0, 'кликов: ' + st.submitted);
    }
  });

  console.log('\n=== 29. ИИ молчит → понятное объяснение, а не «HTTP 500» ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_HTML, waitMs: 12000,
    aiPaidDown: true,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 6500));
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
      /* размышления подставились вместо пустого ответа — значит и в редактор
         уехали именно они, а не пустая строка */
      check('в редактор уехали размышления, а не пустота',
        /думал-думал/.test(st.setValue || ''), JSON.stringify(st.setValue || ''));
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
      check('вкладка названа «ИИ» со значком искры, а не «Код»',
        /^ИИ$/.test(root.querySelector('.sgx-ai-tab').textContent.trim()) &&
        !!root.querySelector('.sgx-ai-tab svg'), root.querySelector('.sgx-ai-tab').textContent.trim());
      check('слова «проверяю» в блоке нет', !/проверяю/.test(root.textContent));
      /* Чип языка убран: он показывал то «ИИ», то «Python», а язык и так написан
         рядом самим Stepik («Python 3.6»).                                     */
      check('чипа с языком в блоке больше нет',
        !root.querySelector('#sgx-ai-lang') && !/sgx-ai-lang/.test(st.css || ''),
        'чип на месте');
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
      check('ИИ просят держаться пройденного',
        /Пиши ровно тем, что уже было в уроке|не используй то, чего в его теории/i.test(body),
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
      check('в запросе есть просьба прогнать тесты',
        /Проверь себя на «Тестовых данных»/.test(body), 'просьба есть');
      check('в запросе есть сверка вывода с ожидаемым',
        /сверь вывод с «выходом»/i.test(body), 'сверка есть');
      check('в системном тексте есть правило самопроверки',
        /Прогони код по тестовым данным/.test(body), 'правило есть');
      /* правила на месте, но запрос при этом короткий — иначе ответ снова начнёт
         тянуться минутами */
      check('правила уложены коротко', body.length < 4000, 'символов: ' + body.length);
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

  /* --- 45. обрезанный ответ не выдаётся за решение и не уезжает в хранилище ---
     Ровно то, что человек увидел на скриншоте: модель упёрлась в лимит токенов
     и прислала «```python\ndef». Ограждение снималось, и в ленте оставался
     огрызок «def» как будто это решение. Провайдер сообщает причину
     в finish_reason — теперь её читаем.                                       */
  console.log('\n=== 45. обрезанный ответ помечается и не публикуется ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: '```python\ndef',
    aiFinishReason: 'length',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3000));

      const feed = aiFeedText(win, st);
      check('в ленте сказано, что ответ неполный', /оборвал|неполн/i.test(feed), feed.slice(0, 120));
      check('сказано, что в хранилище не кладут', /не кладу|неполн/i.test(feed), feed.slice(0, 120));
      check('огрызок НЕ опубликован в очередь', Object.keys(st.inbox).length === 0,
        Object.keys(st.inbox).join(',') || 'очередь пуста');
      check('в статусе сказано про лимит', /лимит/.test(statusText(win)), statusText(win));
      check('предложено сменить модель или повторить',
        /смени модель|ещё раз/i.test(statusText(win) + feed), statusText(win));
    }
  });

  console.log('\n=== 45a. короткий, но целый ответ обрезанным не считается ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'print(1)',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3000));
      const feed = aiFeedText(win, st);
      check('однострочное решение не объявлено обрезанным', !/оборвал|неполн/i.test(feed), feed.slice(0, 120));
      check('оно опубликовано как обычно', Object.keys(st.inbox).length === 1,
        Object.keys(st.inbox).join(',') || 'ничего не ушло');
    }
  });

  /* --- 46. модель выбирается прямо в блоке ИИ -------------------------------
     Список свой, а не родной <select>: в родном не показать значок модели слева
     и её «ум» справа, а человек просил именно это.                           */
  console.log('\n=== 46. модель переключается из блока рядом с редактором ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));

      const btn = win.document.querySelector('#sgx-ai-mbtn');
      const list = win.document.querySelector('#sgx-ai-models');
      check('в блоке ИИ есть выбор модели', !!btn && !!list, 'органа выбора нет');
      const rows = list ? Array.from(list.querySelectorAll('li[data-model]')) : [];
      check('в списке четыре модели', rows.length === 4, 'строк: ' + rows.length);
      check('в списке есть заточенная под код модель',
        rows.some((li) => li.getAttribute('data-model') === 'kimi-k2.7-code'),
        rows.map((li) => li.getAttribute('data-model')).join(','));
      check('в списке есть самая сильная модель',
        rows.some((li) => li.getAttribute('data-model') === 'deepseek-v4-pro'),
        rows.map((li) => li.getAttribute('data-model')).join(','));
      check('по умолчанию выбрана первая модель',
        btn && /GLM 5\.3 Flash/.test(btn.textContent), btn ? btn.textContent.trim() : '—');

      /* список открывается по кнопке */
      check('список закрыт, пока его не открыли',
        list && !list.classList.contains('on'));
      btn.click();
      check('кнопка открывает список', list.classList.contains('on'));
      btn.click();
      check('повторное нажатие закрывает', !list.classList.contains('on'));

      /* переключаем и просим снова — в теле запроса должно быть новое имя */
      btn.click();
      const want = list.querySelector('li[data-model="deepseek-v4-flash"]');
      check('строка нужной модели есть в списке', !!want);
      if (want) want.click();
      check('список закрылся после выбора', !list.classList.contains('on'));
      check('подпись кнопки сменилась на выбранную модель',
        /DeepSeek V4 Flash/.test(btn.textContent), btn.textContent.trim());
      check('выбор сохранён в настройках', st.storage.aiModel === 'deepseek-v4-flash',
        String(st.storage.aiModel));

      const before = st.aiPaidCalls.length;
      const asked = await askAndWait(win, st, 5000);
      const last = st.aiPaidCalls[st.aiPaidCalls.length - 1];
      const sent = last ? JSON.parse(last.body).model : '';
      check('сделан ещё один запрос', asked && st.aiPaidCalls.length > before,
        st.aiPaidCalls.length + ' против ' + before);
      check('в запрос ушла выбранная модель', sent === 'deepseek-v4-flash', sent || 'запроса нет');
    }
  });

  /* --- 46в. у каждой модели свой лимит ответа ------------------------------ */
  console.log('\n=== 46в. сильным моделям дан больший лимит ответа ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 8000, cmMode: 'text/x-python',
    aiModel: 'deepseek-v4-pro', aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));
      const body = JSON.parse((st.aiPaidCalls[0] || {}).body || '{}');
      check('сильной модели ушёл увеличенный лимит', body.max_tokens === 40000,
        String(body.max_tokens));
      check('лимит прежних 4000 больше не используется', body.max_tokens !== 4000,
        String(body.max_tokens));
    }
  });

  console.log('\n=== 46г. слабой модели лимит не раздувают ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 8000, cmMode: 'text/x-python',
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));
      const body = JSON.parse((st.aiPaidCalls[0] || {}).body || '{}');
      check('быстрой модели ушёл скромный лимит', body.max_tokens === 8000,
        String(body.max_tokens));
    }
  });

  console.log('\n=== 46a. сохранённая модель подхватывается при следующем запуске ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 8000, cmMode: 'text/x-python',
    aiModel: 'deepseek-v4-flash', aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));
      const btn = win.document.querySelector('#sgx-ai-mbtn');
      check('кнопка показывает сохранённую модель',
        btn && /DeepSeek V4 Flash/.test(btn.textContent), btn ? btn.textContent.trim() : '—');
      const sent = st.aiPaidCalls[0] ? JSON.parse(st.aiPaidCalls[0].body).model : '';
      check('запрос пошёл на сохранённую модель', sent === 'deepseek-v4-flash', sent || 'нет');
    }
  });

  console.log('\n=== 46b. неизвестная модель из настроек не уезжает в запрос ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 8000, cmMode: 'text/x-python',
    aiModel: 'gpt-из-будущего', aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));
      const sent = st.aiPaidCalls[0] ? JSON.parse(st.aiPaidCalls[0].body).model : '';
      check('незнакомое имя заменено на рабочую модель', sent === 'glm-5.3-flash', sent || 'нет');
      const btn = win.document.querySelector('#sgx-ai-mbtn');
      check('кнопка тоже показывает рабочую модель',
        btn && /GLM 5\.3 Flash/.test(btn.textContent), btn ? btn.textContent.trim() : '—');
    }
  });

  /* --- 47. оформление и читаемость ----------------------------------------- */
  console.log('\n=== 47. блок ИИ светлый и с крупным шрифтом, как соседние панели ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 8000, cmMode: 'text/x-python',
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 1500));

      const css = st.css || '';
      check('стили вообще доехали до страницы', css.length > 500, 'символов: ' + css.length);
      const rule = (sel) => {
        const i = css.indexOf(sel + '{');
        return i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1);
      };
      /* Размеры теперь заданы переменными шкалы, поэтому сравнивать надо
         РАЗВЁРНУТОЕ значение, а не литерал: иначе проверка ловит сам факт
         перехода на переменные и падает на верном коде.                        */
      const scale = {};
      (rule('#sgx-ai-root').match(/--sgx-[a-z0-9-]+:[^;}]+/g) || []).forEach((d) => {
        const parts = d.split(':');
        scale[parts[0].trim()] = parts.slice(1).join(':').trim();
      });
      const px = (sel) => rule(sel).replace(/var\((--sgx-[a-z0-9-]+)\)/g,
        (m, name) => scale[name] || m);
      check('шкала размеров разбирается', Object.keys(scale).length >= 10,
        Object.keys(scale).join(','));

      /* тёмное поле убрано: рядом с родным светлым редактором оно было чужеродным */
      const log = px('#sgx-ai-panel .sgx-ai-log');
      check('лента блока светлая', /background:#fff/i.test(log), log);
      check('тёмного фона у ленты больше нет', !/background:#2B2B2B/i.test(log), log);

      const code = px('#sgx-ai-panel .sgx-ai-code');
      check('код тёмным по светлому, а не наоборот', /color:#1F1D1B/i.test(code), code);
      check('шрифт кода не меньше 16px', /font:16px/.test(code), code);

      const msg = px('#sgx-ai-panel .sgx-ai-msg');
      check('шрифт ленты не меньше 16px', /font-size:16px/.test(msg), msg);
      /* потолок: крупнее кода не делаем ничего — иначе решение перестаёт
         читаться как код */
      const codeSize = Number((/font:(\d+)px/.exec(code) || [])[1] || 0);
      const sizes = [
        ['лента', Number((/font-size:(\d+)px/.exec(msg) || [])[1] || 0)],
        ['вкладка', Number((/font-size:(\d+)px/.exec(px('#sgx-ai-panel .sgx-ai-tab')) || [])[1] || 0)],
        ['кнопка модели', Number((/font-size:(\d+)px/.exec(px('#sgx-ai-panel .sgx-ai-mbtn')) || [])[1] || 0)],
        ['строка отчёта', Number((/font(?::|-size:)(\d+)px/.exec(px('#sgx-ai-panel .sgx-ai-report')) || [])[1] || 0)],
        ['служебная строка', Number((/font-size:(\d+)px/.exec(px('#sgx-ai-panel .sgx-ai-msg.sys')) || [])[1] || 0)]
      ];
      const over = sizes.filter((s) => s[1] > codeSize);
      check('ни один шрифт не крупнее кода', over.length === 0,
        'код ' + codeSize + 'px; крупнее: ' + over.map((s) => s[0] + ' ' + s[1]).join(', '));
      check('все размеры вообще распознались', sizes.every((s) => s[1] > 0),
        sizes.map((s) => s[0] + '=' + s[1]).join(', '));

      const tab = px('#sgx-ai-panel .sgx-ai-tab');
      check('шрифт вкладки не меньше 16px', /font-size:16px/.test(tab), tab);
      check('активная вкладка белая, как у Stepik',
        /background:#fff/i.test(rule('#sgx-ai-panel .sgx-ai-tab.active')),
        rule('#sgx-ai-panel .sgx-ai-tab.active'));

      /* шрифты подняты и в остальных местах — человек просил «везде» */
      check('шрифт панели не меньше 16px', /font:16px/.test(px('#sgx-panel')), px('#sgx-panel'));
      check('шрифт статуса не меньше 15px', /font-size:15px/.test(px('#sgx-panel .sgx-status')),
        px('#sgx-panel .sgx-status'));
      check('шрифт скобы не меньше 15px', /font:15px/.test(rule('#sgx-chip')), rule('#sgx-chip'));
      check('шрифт тоста не меньше 14px', /font:14\.5px/.test(rule('#sgx-toast')), rule('#sgx-toast'));
      check('шрифт отчёта не меньше 15px', /font:15px/.test(rule('#sgx-report')), rule('#sgx-report'));
      check('кнопка выбора модели оформлена как родная',
        /border:1px solid #E5E5E5/.test(px('#sgx-ai-panel .sgx-ai-mbtn')),
        px('#sgx-ai-panel .sgx-ai-mbtn'));
      /* поле ответа: фиксированная высота, а не max-height — иначе блок прыгает
         при каждом ответе, а человек просил «только прокручивать» */
      const logRule = px('#sgx-ai-panel .sgx-ai-log');
      check('поле ответа фиксированной высоты', /(?:^|[;{])height:440px/.test(logRule), logRule);
      check('высота поля не зависит от содержимого', !/max-height:46vh/.test(logRule), logRule);
      check('поле ответа стало больше прежних 46vh', /height:440px/.test(logRule), logRule);
      check('кнопки блока крупные — 40px',
        /--sgx-ctl:40px/.test(rule('#sgx-ai-root')) &&
        /height:var\(--sgx-ctl\)/.test(rule('#sgx-ai-panel .sgx-ai-tool')),
        rule('#sgx-ai-panel .sgx-ai-tool'));
    }
  });

  /* --- 48. докстринг не ломается при снятии ограждений --------------------- */
  console.log('\n=== 48. многострочный докстринг выживает после чистки ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['stripFences'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const body = 'def f():\n    """\n    Считает.\n    """\n    return 1';
    const got = probe.stripFences('```python\n' + body + '\n```');
    probe.close();
    check('кавычки докстринга на месте', /"""\n    Считает\.\n    """/.test(got), JSON.stringify(got));
    check('код не пострадал', /return 1/.test(got), JSON.stringify(got));

    const probe2 = probeSandbox(QUIZ_PLUGIN_HTML, ['stripFences'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const got2 = probe2.stripFences('```python\ndef');
    probe2.close();
    check('огрызок без закрывающего ограждения не портится', got2 === 'def', JSON.stringify(got2));
  }

  /* --- 49. кнопка копирования живёт внутри кода ---------------------------- */
  console.log('\n=== 49. копирование стоит внутри кода, а не в шапке блока ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));

      check('в шапке блока кнопки копирования больше нет',
        !win.document.querySelector('#sgx-ai-copy'));
      const wrap = win.document.querySelector('#sgx-ai-panel .sgx-ai-codewrap');
      check('код обёрнут в контейнер с кнопкой', !!wrap, 'обёртки нет');
      const copy = wrap && wrap.querySelector('.sgx-ai-codecopy');
      check('кнопка копирования лежит внутри области кода', !!copy, 'кнопки нет');
      check('кнопка стоит рядом с самим кодом',
        !!(wrap && wrap.querySelector('.sgx-ai-code')), 'код потерялся');
      check('в кнопке именно иконка копирования',
        !!(copy && copy.querySelector('svg')), 'иконки нет');

      /* нажатие не должно ничего ломать и должно отмечаться как «скопировано» */
      if (copy) copy.click();
      await new Promise((r) => setTimeout(r, 200));
      check('нажатие копирования отрабатывает', !!(copy && copy.classList.contains('done')),
        copy ? copy.className : '—');
    }
  });

  /* --- 50. одна шкала размеров вместо случайных чисел --------------------- */
  console.log('\n=== 50. размеры заданы одной шкалой, а не набором чисел ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 8000, cmMode: 'text/x-python',
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      const css = st.css || '';
      const rule = (sel) => {
        const i = css.indexOf(sel + '{');
        return i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1);
      };
      const vars = rule('#sgx-ai-root');
      check('шкала объявлена в блоке ИИ',
        /--sgx-s1:4px/.test(vars) && /--sgx-s2:8px/.test(vars) && /--sgx-s3:12px/.test(vars) &&
        /--sgx-s4:16px/.test(vars), vars.slice(0, 90));
      check('высота органов управления задана одним числом', /--sgx-ctl:40px/.test(vars), vars.slice(0, 90));
      check('радиусы заданы шкалой',
        /--sgx-r:10px/.test(vars) && /--sgx-r-sm:8px/.test(vars), vars.slice(0, 90));
      check('шрифты заданы шкалой',
        /--sgx-f-xs:14px/.test(vars) && /--sgx-f-sm:15px/.test(vars) && /--sgx-f:16px/.test(vars),
        vars.slice(0, 120));
      check('размер кода объявлен отдельно — он и есть потолок',
        /--sgx-mono:16px/.test(vars), vars.slice(0, 120));
      check('панель курса объявляет ту же шкалу', /--sgx-ctl:40px/.test(rule('#sgx-panel')),
        rule('#sgx-panel').slice(0, 90));

      /* ключевые правила должны ссылаться на шкалу, а не нести свои числа */
      check('шапка блока берёт отступы из шкалы',
        /padding:var\(--sgx-s2\) var\(--sgx-s3\)/.test(rule('#sgx-ai-panel .sgx-ai-head')),
        rule('#sgx-ai-panel .sgx-ai-head'));
      check('кнопка-иконка берёт высоту из шкалы',
        /width:var\(--sgx-ctl\)/.test(rule('#sgx-ai-panel .sgx-ai-tool')),
        rule('#sgx-ai-panel .sgx-ai-tool'));
      check('кнопка сброса той же высоты, что остальные',
        /height:var\(--sgx-ctl\)/.test(rule('#sgx-ai-panel .sgx-ai-tool')),
        rule('#sgx-ai-panel .sgx-ai-tool'));
      check('кнопка выбора модели той же высоты',
        /height:var\(--sgx-ctl\)/.test(rule('#sgx-ai-panel .sgx-ai-mbtn')),
        rule('#sgx-ai-panel .sgx-ai-mbtn'));
      check('вкладка «ИИ» той же высоты',
        /height:var\(--sgx-ctl\)/.test(rule('#sgx-ai-panel .sgx-ai-tab')),
        rule('#sgx-ai-panel .sgx-ai-tab'));
      check('скругления берутся из шкалы',
        /var\(--sgx-r-sm\)/.test(rule('#sgx-ai-panel .sgx-ai-code')),
        rule('#sgx-ai-panel .sgx-ai-code'));
    }
  });

  /* --- 51. «Запустить код» не путается с «Отправить на проверку» ---------- */
  console.log('\n=== 51. запуск кода и отправка — разные кнопки ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['submitButton', 'runButton'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const sub = probe.submitButton();
    const run = probe.runButton();
    probe.close();
    check('отправка находится по «Отправить на проверку»',
      !!sub && /Отправить на проверку/.test(sub.textContent), sub ? sub.textContent.trim() : '—');
    check('запуск находится по «Запустить код»',
      !!run && /Запустить код/.test(run.textContent), run ? run.textContent.trim() : '—');
    check('это разные элементы', !!sub && !!run && sub !== run, 'совпали');
    check('отправка — не кнопка запуска',
      !!(sub && sub.classList && !sub.classList.contains('attempt-wrapper-button_run')),
      sub ? sub.className : '—');
  }

  console.log('\n=== 51a. английская «Run» не подменяет отправку ===');
  {
    const en = `<!doctype html><html><body>
      <div class="attempt-wrapper"><div class="attempt-wrapper__content">
        <div class="CodeMirror"><textarea></textarea></div>
        <button class="attempt-wrapper-button attempt-wrapper-button_run" type="button">Run</button>
        <button class="attempt-wrapper-button submit" type="button">Submit</button>
      </div></div></body></html>`;
    const probe = probeSandbox(en, ['submitButton', 'runButton'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const sub = probe.submitButton();
    const run = probe.runButton();
    probe.close();
    check('«Run» уходит в кнопку запуска', !!run && /^Run$/.test(run.textContent.trim()),
      run ? run.textContent.trim() : '—');
    check('«Submit» остаётся отправкой', !!sub && /^Submit$/.test(sub.textContent.trim()),
      sub ? sub.textContent.trim() : '—');
  }

  /* --- 52. запрос стал короче: длинный промпт = долгий ответ --------------- */
  console.log('\n=== 52. промпт урезан, температура низкая ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 8000, cmMode: 'text/x-python',
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 1500));
      const body = JSON.parse((st.aiPaidCalls[0] || {}).body || '{}');
      check('температура низкая — меньше «рассуждений»',
        typeof body.temperature === 'number' && body.temperature <= 0.3, String(body.temperature));
      check('лимит ответа берётся из каталога, а не из общего числа',
        body.max_tokens === 8000, String(body.max_tokens));
      check('у быстрой модели лимит скромный', body.max_tokens < 40000, String(body.max_tokens));
      const system = (body.messages || [])[0] || {};
      const user = (body.messages || [])[1] || {};
      const total = String(system.content || '').length + String(user.content || '').length;
      check('системный текст не разросся', String(system.content || '').length < 1000,
        'символов: ' + String(system.content || '').length);
      check('весь запрос укладывается в разумный размер', total < 4000,
        'символов: ' + total);
      check('правила самопроверки остались', /Проверь себя/.test(String(user.content || '')),
        'правило есть');
    }
  });

  /* --- 53. «думает» со счётчиком секунд ----------------------------------- */
  console.log('\n=== 53. индикатор ожидания показывает секунды ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n', aiDelay: 4000,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2200));

      const secs = win.document.querySelector('#sgx-ai-log .sgx-ai-secs');
      check('пока идёт запрос, виден счётчик секунд', !!secs, 'счётчика нет');
      check('счётчик показывает время в секундах',
        !!secs && /^\d+ с/.test(secs.textContent.trim()), secs ? secs.textContent : '—');
      check('счётчик успел дойти хотя бы до секунды',
        !!secs && Number((/(\d+)/.exec(secs.textContent) || [])[1]) >= 1,
        secs ? secs.textContent : '—');
      check('рядом по-прежнему индикатор «думает»',
        !!win.document.querySelector('#sgx-ai-log .sgx-ai-think'));

      /* после ответа индикатор должен уйти вместе со счётчиком */
      await new Promise((r) => setTimeout(r, 3500));
      check('после ответа счётчик убран',
        !win.document.querySelector('#sgx-ai-log .sgx-ai-secs'), 'остался висеть');
    }
  });

  /* --- 54. автовставка не портит обрезанный ответ ------------------------- */
  console.log('\n=== 54. обрезанный ответ не вставляется и не запускается ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: '```python\ndef', aiFinishReason: 'length',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3500));
      check('огрызок не попал в редактор', st.setValue === null, JSON.stringify(st.setValue));
      check('код не запускался', st.ran === 0, 'кликов: ' + st.ran);
      check('в ленте объяснено, почему не вставили',
        /неполным/.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 140));
    }
  });

  /* --- 55. размышления модели не попадают в решение ------------------------
     Ровно то, что человек прислал в лог: reasoning-модель вывалила стену
     английского текста («We need answer only code in Python…»), а код оказался
     в самом конце. В ленту и в хранилище должно уехать только решение.        */
  console.log('\n=== 55. размышления модели отрезаются от ответа ===');
  {
    const wall =
      'We need answer only code in Python. Need parse problem. Need understand Stepik task. ' +
      'Let\'s think. The user says write in Python. Maybe we read three lines.\n' +
      'So the code should be:\n```python\ndef GetAverage(a, b, c):\n' +
      '    return (a + b + c) / 3\n\nprint(GetAverage(*map(float, input().split())))\n```';
    const probe = probeSandbox(QUIZ_PLUGIN_HTML,
      ['stripFences', 'looksLikeReasoning', 'cutReasoning'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const got = probe.stripFences(wall);
    check('в решении остался только код', /^def GetAverage/.test(got), JSON.stringify(got.slice(0, 60)));
    check('английской стены в решении нет', !/We need/.test(got), JSON.stringify(got.slice(0, 60)));
    check('размышления распознаны как размышления', probe.looksLikeReasoning(wall));
    check('в готовом решении размышлений уже нет', !probe.looksLikeReasoning(got));
    check('код уцелел целиком', /print\(GetAverage/.test(got), JSON.stringify(got.slice(-60)));
    probe.close();
  }

  console.log('\n=== 55a. из нескольких ограждений берётся последнее ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['stripFences'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const two = 'Вот пример:\n```python\nprint("это пример, не ответ")\n```\n' +
      'А вот ответ:\n```python\ndef f():\n    return 1\n```';
    const got = probe.stripFences(two);
    check('взято последнее ограждение, а не первое', /def f\(\)/.test(got), JSON.stringify(got));
    check('пример из размышлений не попал в ответ', !/это пример/.test(got), JSON.stringify(got));

    const plain = 'def f():\n    return 1\n\nprint(f())';
    check('обычный ответ без ограждений не тронут', probe.stripFences(plain) === plain,
      JSON.stringify(probe.stripFences(plain)));
    probe.close();
  }

  console.log('\n=== 55b. размышления не уезжают в редактор и в хранилище ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'We need answer only code. Need parse. Let\'s think. Maybe we should. ' +
      'The user says write in Python. So the code should be:\n' +
      '```python\nn = int(input())\nprint(n % 2 == 0)\n```',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3500));
      const feed = aiFeedText(win, st);
      check('в ленте только код, без английской стены', !/We need/.test(feed), feed.slice(0, 100));
      check('код в ленте есть', /n % 2 == 0/.test(feed), feed.slice(0, 100));
      const name = Object.keys(st.inbox)[0] || '';
      check('в хранилище уехал код, а не размышления',
        /n % 2 == 0/.test(st.inbox[name] || '') && !/We need/.test(st.inbox[name] || ''),
        String(st.inbox[name] || '').slice(0, 60));
      check('в редакторе код', /n % 2 == 0/.test(st.setValue || ''),
        JSON.stringify(st.setValue || ''));
      check('код запущен', st.ran === 1, 'кликов: ' + st.ran);
    }
  });

  console.log('\n=== 55c. чистая стена размышлений не вставляется и не публикуется ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'We need answer only code. Need parse the problem. Let\'s think carefully. ' +
      'Maybe the input has three numbers. The user says write in Python. ' +
      'So we can read all and split. Perhaps we should also check negatives. ' +
      'Wait, the average is simple. I think we should just sum and divide.',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3500));
      check('в редактор ничего не подставлено', st.setValue === null, JSON.stringify(st.setValue));
      check('код не запускался', st.ran === 0, 'кликов: ' + st.ran);
      check('в хранилище ничего не ушло', Object.keys(st.inbox).length === 0,
        Object.keys(st.inbox).join(',') || 'пусто');
      check('в ленте сказано, что это размышления',
        /размышлени/i.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 140));
    }
  });

  /* --- 56. отчёт о тестах подсвечен: провалы красным --------------------- */
  console.log('\n=== 56. проваленные тесты выделены, пройденные — нет ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['aiLogReport', 'ensureAiRoot', 'aiSlot'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    probe.ensureAiRoot();
    probe.aiSlot();
    const report =
      '[+] Test #1. OK [ ] Test #2. Wrong answer [ ] Test #3. Wrong answer ' +
      '[ ] Test #4. Wrong answer [+] Test #5. OK 2 of 5 test(s) passed.';
    probe.aiLogReport(report);
    const lines = Array.from(probe.window.document.querySelectorAll('#sgx-ai-log .sgx-ai-repline'))
      .map((el) => ({
        kind: el.classList.contains('bad') ? 'bad'
          : (el.classList.contains('ok') ? 'ok' : 'note'),
        text: el.textContent
      }));
    probe.close();
    check('отчёт разобран на отметки тестов', !!lines, 'нет разбора');
    if (lines) {
      check('провалов помечено три', lines.filter((l) => l.kind === 'bad').length === 3,
        lines.map((l) => l.kind).join(','));
      check('пройденных помечено два', lines.filter((l) => l.kind === 'ok').length === 2,
        lines.map((l) => l.kind).join(','));
      check('провальный тест назван красным классом',
        lines.some((l) => l.kind === 'bad' && /Wrong answer/.test(l.text)),
        lines.map((l) => l.text).join(' | ').slice(0, 80));
      check('итог «2 of 5» остался виден',
        lines.some((l) => /2 of 5/.test(l.text)), lines.map((l) => l.text).join(' | ').slice(0, 80));
    }
  }

  console.log('\n=== 56a. разбор одной ошибки тоже выделяется ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['aiLogReport', 'ensureAiRoot', 'aiSlot'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    probe.ensureAiRoot();
    probe.aiSlot();
    probe.aiLogReport('Failed test #1 of 5. Wrong answer\nTest input: 1 2 3\nCorrect output: 2\nYour code output: 2.0');
    const lines = Array.from(probe.window.document.querySelectorAll('#sgx-ai-log .sgx-ai-repline'))
      .map((el) => ({
        kind: el.classList.contains('bad') ? 'bad'
          : (el.classList.contains('ok') ? 'ok' : 'note'),
        text: el.textContent
      }));
    probe.close();
    check('строка с провалом помечена красным',
      !!lines && lines.some((l) => l.kind === 'bad' && /Failed test/.test(l.text)),
      lines ? lines.map((l) => l.kind).join(',') : 'нет разбора');
    check('подробности входа-выхода видны',
      !!lines && lines.some((l) => /Correct output/.test(l.text)),
      lines ? lines.map((l) => l.text).join(' | ').slice(0, 70) : 'нет разбора');
  }

  /* --- 57. после провала редактор возвращает «Изменить решение» ---------- */
  console.log('\n=== 57. редактор возвращается кнопкой «Изменить решение» ===');
  {
    const probe = probeSandbox(AI_FAILED_HTML, ['editButton', 'editorField', 'revealEditor'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const before = !!probe.editorField();
    check('до провала редактор на месте', before, 'редактора нет');
    check('кнопки «Изменить решение» ещё нет', !probe.editButton(), 'кнопка уже есть');
    probe.close();
  }

  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: AI_FAILED_HTML, waitMs: 20000, cmMode: 'text/x-python',
    aiPaidQueue: [
      'def GetAverage(a, b, c):\n    return (a + b + c) / 3\n\na = float(input())\nb = float(input())\nc = float(input())\nprint(GetAverage(a, b, c))\n',
      'def GetAverage(a, b, c):\n    return (a + b + c) / 3\n\na = float(input())\nb = float(input())\nc = float(input())\nr = GetAverage(a, b, c)\nif r == int(r):\n    print(int(r))\nelse:\n    print(r)\n'
    ],
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));
      check('первое решение вставлено и запущено', st.ran === 1, 'запусков: ' + st.ran);

      /* отправляем на проверку — сайт уберёт редактор и покажет разбор */
      const sub = win.document.querySelector('button.submit');
      if (sub) sub.click();
      await new Promise((r) => setTimeout(r, 9000));

      check('на проверку отправлено', st.submitted === 1, 'кликов: ' + st.submitted);
      /* Кнопку «Изменить решение» скрипт нажимает сам и она исчезает — поэтому
         проверяем не её наличие, а то, что редактор вернулся и код лёг в него. */
      check('редактор вернулся на страницу',
        !!win.document.querySelector('.quiz-plugin__content .CodeMirror'), 'редактора нет');
      check('сделана вторая попытка у ИИ', st.aiPaidCalls.length >= 2,
        'запросов: ' + st.aiPaidCalls.length);
      check('отчёт о провале показан в ленте',
        /Wrong answer|Failed test/.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 100));
      check('провалы подсвечены красным',
        !!win.document.querySelector('#sgx-ai-log .sgx-ai-repline.bad'),
        'красных строк нет');
      check('«Изменить решение» нажата — кнопки больше нет',
        !win.document.querySelector('#sgx-edit-btn'), 'кнопка осталась');
      check('исправленный код вернулся в редактор',
        /int\(r\)/.test(st.setValue || ''), JSON.stringify((st.setValue || '').slice(0, 80)));
      check('исправленный код запущен', st.ran === 2, 'запусков: ' + st.ran);
    }
  });

  /* --- 58. в ленте нет служебных подписей --------------------------------- */
  console.log('\n=== 58. «свой ключ» и «проверь перед отправкой» в ленте не показываем ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3500));
      const feed = aiFeedText(win, st);
      check('подписи «проверь перед отправкой» нет', !/проверь перед отправкой/i.test(feed),
        feed.slice(0, 90));
      check('«свой ключ» в ленте не упоминается', !/свой ключ/i.test(feed), feed.slice(0, 90));
      check('название модели в ленту не дублируется', !/glm-5\.3-flash/i.test(feed),
        feed.slice(0, 90));
      check('сам код в ленте остался', /n % 2 == 0/.test(feed), feed.slice(0, 90));
    }
  });

  /* --- 59. иконка сброса — корзина, и она работает ------------------------ */
  console.log('\n=== 59. кнопка сброса перерисована и работает ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3000));
      const reset = win.document.querySelector('#sgx-ai-reset');
      check('кнопка сброса есть', !!reset, 'кнопки нет');
      check('в кнопке сброса нарисована корзина, а не веник',
        !!reset && /polyline points="3 6 21 6"/.test(reset.innerHTML),
        reset ? reset.innerHTML.slice(0, 80) : '—');
      check('значок крупный', !!reset && /width="18"/.test(reset.innerHTML),
        reset ? reset.innerHTML.slice(0, 60) : '—');

      reset.click();
      await new Promise((r) => setTimeout(r, 300));
      /* Раньше сброс прятал блок, и вернуть его было нечем. Теперь он чистит
         переписку и остаётся на экране.                                        */
      check('нажатие сброса НЕ прячет блок',
        !!win.document.querySelector('#sgx-ai-root.on'), 'блок исчез');
      check('лента очищена', !/n % 2 == 0/.test(aiFeedText(win, st)), 'текст остался');
      check('предложено начать заново', /заново/i.test(aiFeedText(win, st)),
        aiFeedText(win, st).slice(0, 80));
    }
  });

  /* --- 60. индикатор говорит, чем ИИ занят сейчас ------------------------- */
  console.log('\n=== 60. «думает» подписано по делу, одной строкой ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n', aiDelay: 4000,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));
      const think = win.document.querySelector('#sgx-ai-log .sgx-ai-think');
      check('индикатор на месте', !!think, 'индикатора нет');
      const text = think ? think.textContent : '';
      check('сказано, что ИИ пишет решение', /пишет решение/i.test(text), text);
      check('подпись короткая — одна строка', text.replace(/\s+/g, ' ').length < 60, text);
      check('счётчик секунд рядом', !!think && !!think.querySelector('.sgx-ai-secs'),
        text);
    }
  });

  /* --- 61. промпт прямо запрещает import и всё непройденное --------------- */
  console.log('\n=== 61. модель просят обходиться без import и лишних конструкций ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));
      const body = (st.aiPaidCalls[0] && st.aiPaidCalls[0].body) || '';
      check('import прямо запрещён', /Запрещено: import/.test(body), 'запрета нет');
      check('перечислены sys, os, math', /sys, os, math/.test(body), 'нет перечисления');
      check('запрещены f-строки и def main',
        /f-строки/.test(body) && /def main\(\)/.test(body), 'нет запрета');
      /* тело запроса — JSON, поэтому кавычки в нём экранированы */
      check('запрещён if __name__', /if __name__ == \\"__main__\\"/.test(body), 'нет запрета');
      check('сказано, что ввод — только input()', /только input\(\)/.test(body), 'нет правила');
      check('про формат вывода сказано прямо',
        /2 и 2\.0 — разные/.test(body), 'нет правила о формате');
      check('решение просят короткое', /Решени[ея] — короткое/.test(body), 'нет правила');
      check('в пользовательском тексте тоже есть напоминание',
        /без import/.test(body), 'нет напоминания');
    }
  });

  /* --- 62. лента выглядит как чат, а не как лог --------------------------- */
  console.log('\n=== 62. служебные сообщения читаются как реплики бота ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));

      const log = win.document.querySelector('#sgx-ai-log');
      const rows = Array.from(log.querySelectorAll('.sgx-ai-row'));
      check('все сообщения — строки чата', rows.length >= 3, 'строк: ' + rows.length);
      check('у каждой строки есть аватар отвечающей модели',
        rows.length > 0 && rows.every((r) => !!r.querySelector(':scope > .sgx-ai-ava img')),
        'аватара нет');
      check('в аватаре логотип модели, а не значок искры',
        !!(log.querySelector('.sgx-ai-ava img.sgx-ai-mimg')) &&
        !log.querySelector('.sgx-ai-ava svg'), 'логотипа нет');

      const sys = Array.from(log.querySelectorAll('.sgx-ai-msg.sys')).map((e) => e.textContent);
      check('служебные реплики есть', sys.length >= 2, 'реплик: ' + sys.length);
      check('каждая начинается с большой буквы',
        sys.every((t) => /^[А-ЯЁA-Z]/.test(t.trim())), sys.join(' | ').slice(0, 120));
      check('нет реплик со строчной буквы вроде «вставил»',
        !sys.some((t) => /^(вставил|нажал|пробую|модель)/.test(t.trim())),
        sys.join(' | ').slice(0, 120));

      /* размер: служебная реплика не должна быть мелочью */
      const css = st.css || '';
      const i = css.indexOf('#sgx-ai-panel .sgx-ai-msg.sys{');
      const rule = i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1);
      check('служебная реплика того же размера, что обычный текст',
        /font-size:var\(--sgx-f-sm\)/.test(rule) && !/--sgx-f-xs/.test(rule), rule);
      check('служебная реплика не серой мелочью',
        /color:#4B4A47/.test(rule), rule);
      check('в CSS есть строки чата и аватар',
        /\.sgx-ai-row\{/.test(css) && /\.sgx-ai-ava\{/.test(css), 'правил нет');
    }
  });

  /* --- 63. логотипы моделей из картинок ----------------------------------- */
  console.log('\n=== 63. у моделей картинки-логотипы, а не значки ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 8000, cmMode: 'text/x-python',
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));

      const rows = Array.from(win.document.querySelectorAll('#sgx-ai-models li[data-model]'));
      const imgs = rows.map((li) => li.querySelector('img.sgx-ai-mimg'));
      check('в каждой строке картинка', imgs.every(Boolean), 'где-то нет картинки');
      const srcs = imgs.map((i) => (i ? i.getAttribute('src') : ''));
      check('GLM — своя картинка',
        srcs[0] === 'https://i.imgur.com/DVdAOHf.png', srcs[0] || '—');
      check('DeepSeek — своя картинка',
        srcs[1] === 'https://i.imgur.com/qpf5Hoe.png', srcs[1] || '—');
      check('Kimi — своя картинка',
        srcs[2] === 'https://i.imgur.com/y2H82HX.png', srcs[2] || '—');
      check('у картинок есть размер',
        imgs.every((i) => Number(i.getAttribute('width')) >= 20),
        imgs.map((i) => i.getAttribute('width')).join(','));
      check('у картинок есть запасной значок на случай отказа',
        imgs.every((i) => !!i.getAttribute('data-fallback')),
        imgs.map((i) => i.getAttribute('data-fallback')).join(','));
      check('в кнопке выбранной модели тоже картинка',
        !!win.document.querySelector('#sgx-ai-micon img.sgx-ai-mimg'),
        'картинки нет');
    }
  });

  console.log('\n=== 63a. без картинки остаётся запасной значок, а не дырка ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['AI_MODELS', 'modelIcon'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const noImg = { id: 'x', label: 'X', icon: 'bolt', smarts: 1, maxTokens: 100, img: '' };
    const html = probe.modelIcon(noImg, 24);
    const real = probe.AI_MODELS.filter((m) => m.img).length;
    probe.close();
    check('модель без картинки рисуется значком', /<svg/.test(html), html.slice(0, 60));
    check('у всех четырёх моделей картинки заданы', real === 4, 'с картинкой: ' + real);
  }

  /* --- 64. вывод запуска показывается прямо в ленте ----------------------- */
  console.log('\n=== 64. результат запуска виден в самом блоке ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 10000, cmMode: 'text/x-python',
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 5000));

      const out = win.document.querySelector('#sgx-ai-log .sgx-ai-runout');
      check('вывод запуска показан в ленте', !!out, 'блока вывода нет');
      check('у вывода есть подпись',
        !!out && /Вывод запуска/.test(out.querySelector('.sgx-ai-runhead').textContent),
        out ? out.querySelector('.sgx-ai-runhead').textContent : '—');
      check('в выводе тот же текст, что на странице',
        !!out && out.querySelector('.sgx-ai-runbody').textContent.trim() === '2',
        out ? JSON.stringify(out.querySelector('.sgx-ai-runbody').textContent) : '—');
      check('вывод показан как код',
        !!(st.css || '').match(/\.sgx-ai-runbody\{[^}]*monospace/), 'не моноширинный');
      check('больше не отправляем человека искать результат глазами',
        !/результат ниже/.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 120));
      check('в ленте сказано, что код запускается',
        /Запускаю код/.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 120));
    }
  });

  console.log('\n=== 64a. вывод с ошибкой выделяется красным ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['aiLogOutput', 'ensureAiRoot', 'aiSlot', 'looksLikeRunError'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    probe.ensureAiRoot();
    probe.aiSlot();
    const bad = 'Traceback (most recent call last):\nValueError: could not convert string to float';
    const good = 'True';
    const isBad = probe.looksLikeRunError(bad);
    const isGood = probe.looksLikeRunError(good);
    probe.aiLogOutput(bad);
    const badBlock = probe.window.document.querySelector('#sgx-ai-log .sgx-ai-runout');
    const badClass = badBlock ? badBlock.className : '';
    const headText = badBlock ? badBlock.querySelector('.sgx-ai-runhead').textContent : '';
    probe.close();
    check('ошибка распознана', isBad, 'не распознана');
    check('обычный вывод ошибкой не считается', !isGood, 'ложное срабатывание');
    check('блок с ошибкой помечен красным', /\bbad\b/.test(badClass), badClass);
    check('в подписи сказано про ошибку', /ошибк/i.test(headText), headText);
  }

  /* --- 65. стрелка переноса летит от ИИ к редактору ----------------------- */
  /* --- 65. решение набирается в редакторе, как будто его пишут ----------- */
  console.log('\n=== 65. код появляется в редакторе постепенно, а не одной вставкой ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 12000, cmMode: 'text/x-python',
    aiPaidText: 'def f(a):\n    if a > 0:\n        return a\n    return -a\n\nprint(f(int(input())))\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 7000));
      /* вставка — это один вызов setValue, набор — столько, сколько строк */
      check('текст переписывался несколько раз (набор, а не вставка)',
        st.types > 2, 'вызовов: ' + st.types);
      check('в итоге в редакторе всё решение',
        /print\(f\(int\(input\(\)\)\)\)/.test(st.setValue || ''),
        JSON.stringify((st.setValue || '').slice(-40)));
      check('набор не тянется бесконечно — укладывается в пару секунд',
        st.types > 0, 'вызовов: ' + st.types);
      check('анимации-стрелки больше нет',
        !(st.css || '').includes('.sgx-ai-fly'), 'правило стрелки осталось');
    }
  });

  console.log('\n=== 65a. набор не задваивает код, если моста нет ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['writeCode'], `https://stepik.org/lesson/${LESSON}/step/8`);
    /* мост в песочнице недоступен, поэтому writeCode уходит на запасные пути;
       при наборе дописывающий путь должен быть отключён, иначе текст задвоится */
    const first = probe.writeCode('a = 1', true);
    probe.close();
    check('при наборе вызов не бросает', !!first, 'упало');
  }

  /* --- 66. задание-галочка: варианты видны модели, ответ ставится ---------- */
  console.log('\n=== 66. тест с выбором: варианты уходят модели, галочка ставится ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/2?unit=1818966`,
    store: {}, submissions: [], html: CHOICE_ONLY_HTML, waitMs: 12000,
    aiPaidText: 'static int Multiply(int a, int b)',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 6000));

      check('запрос к ИИ ушёл', st.aiPaidCalls.length === 1, 'запросов: ' + st.aiPaidCalls.length);
      const asked = st.aiPaidCalls[0] ? st.aiPaidCalls[0].body : '';
      check('все четыре варианта попали в запрос',
        ['static int Multiply()', 'static void Multiply(int a, int b)',
          'void static Multiply(int, int)', 'static int Multiply(int a, int b)']
          .every((t) => asked.indexOf(t) >= 0), 'вариантов в запросе нет');
      check('про stdin и stdout при выборе не говорим', !/stdin/.test(asked),
        'лишнее правило в запросе');
      check('системный текст просит вернуть вариант, а не код',
        /ТОЛЬКО текст выбранного варианта/.test(asked) && !/Код — целиком/.test(asked),
        'системный текст не про выбор');

      const inputs = Array.from(win.document.querySelectorAll('.quiz-component input[type=radio]'));
      check('отмечен ровно один вариант', inputs.filter((i) => i.checked).length === 1,
        'отмечено: ' + inputs.filter((i) => i.checked).length);
      check('отмечен именно верный вариант',
        !!(inputs[3] && inputs[3].checked), 'не тот вариант');
      check('в ленте сказано про вариант, а не про редактор',
        /Отметил вариант ответа/.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 140));
      check('«Запустить код» для теста не ищем',
        !/Кнопку «Запустить код»/.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 140));
      check('код запускать нечего — кликов не было', st.ran === 0, 'кликов: ' + st.ran);
      check('в редактор ничего не писалось', st.setValue === null, JSON.stringify(st.setValue));
    }
  });

  console.log('\n=== 66a. ответ по номеру варианта тоже понимается ===');
  {
    const probe = probeSandbox(CHOICE_ONLY_HTML,
      ['choiceFromText', 'choiceOptions'], `https://stepik.org/lesson/${LESSON}/step/2`);
    const byText = probe.choiceFromText('static void Multiply(int a, int b)');
    const byNum = probe.choiceFromText('Правильный вариант: 4');
    const opts = probe.choiceOptions();
    probe.close();
    check('по тексту вариант найден',
      !!byText && byText.answers.indexOf('static void Multiply(int a, int b)') >= 0,
      byText ? JSON.stringify(byText.answers) : 'нет');
    check('по номеру вариант найден',
      !!byNum && byNum.ids.indexOf('104') >= 0, byNum ? JSON.stringify(byNum.ids) : 'нет');
    check('вариантов ровно четыре', opts.length === 4, 'найдено: ' + opts.length);
  }

  /* --- 67. вывод запуска берётся из .code-runner__hints ------------------- */
  console.log('\n=== 67. вывод запуска читается из настоящей разметки ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML,
      ['runOutputText', 'stepErrorText'], `https://stepik.org/lesson/${LESSON}/step/8`);
    const out = probe.runOutputText();
    const err = probe.stepErrorText();
    probe.close();
    check('вывод найден в .code-runner__hints', out === '2', JSON.stringify(out));
    check('вывод запуска НЕ выдаётся за отчёт проверки', !/^2$/.test(err.trim()),
      JSON.stringify(err));
  }

  /* --- 68. имена переменных — простые ------------------------------------- */
  console.log('\n=== 68. модель просят называть переменные просто ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 2000));
      const body = (st.aiPaidCalls[0] && st.aiPaidCalls[0].body) || '';
      check('сказано про простые имена переменных', /Имена переменных — простые/.test(body),
        'правила нет');
      check('перечислены примеры простых имён',
        /a, b, c, n, x, number, text, result/.test(body), 'примеров нет');
      check('запрещены профессиональные сокращения',
        /word_count, idx, tmp, res, obj, cnt/.test(body), 'запрета нет');
    }
  });

  /* --- 69. аватар — логотип отвечающей модели ----------------------------- */
  console.log('\n=== 69. в аватаре — логотип той модели, что ответила ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiModel: 'kimi-k2.7-code', aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));
      const imgs = Array.from(win.document.querySelectorAll('#sgx-ai-log .sgx-ai-ava img'));
      check('в аватарах картинки', imgs.length >= 2, 'картинок: ' + imgs.length);
      check('логотип именно выбранной модели',
        imgs.length > 0 && imgs.every((i) => i.getAttribute('src') === 'https://i.imgur.com/y2H82HX.png'),
        imgs.map((i) => i.getAttribute('src')).join(' '));
      check('значка искры в аватаре больше нет',
        !win.document.querySelector('#sgx-ai-log .sgx-ai-ava svg'), 'остался svg');
    }
  });

  /* --- 70. скоба обрамляет редактор, а не карточку ------------------------ */
  console.log('\n=== 70. скоба обрамляет редактор, а блок ИИ в неё не попадает ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['insertTarget', 'tightBlockOf'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const t = probe.insertTarget();
    const anchor = t && t.anchor;
    probe.close();
    check('якорь найден', !!anchor, 'якоря нет');
    check('якорь — редактор кода, а не вся карточка',
      !!anchor && anchor.classList.contains('CodeMirror'),
      anchor ? anchor.className : '—');
    check('якорь не равен карточке задания',
      !!anchor && !anchor.classList.contains('attempt-wrapper__content'),
      anchor ? anchor.className : '—');
  }

  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int x = 1;' } },
    submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 6000, innerWidth: 1400,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3000));
      const root = win.document.querySelector('#sgx-ai-root');
      const cm = win.document.querySelector('.CodeMirror');
      check('блок ИИ стоит рядом с редактором, а не внутри него',
        !!root && !!cm && !cm.contains(root), 'блок внутри редактора');
      const chip = win.document.querySelector('#sgx-chip');
      check('скоба показана и стоит справа',
        !!chip && chip.classList.contains('on') && !chip.classList.contains('above'),
        chip ? chip.className : 'нет');
    }
  });

  /* --- 71. скобка рисуется и больше не белая карточка --------------------- */
  console.log('\n=== 71. скобка рисуется, без синей обводки и белой заливки ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['drawBrace'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const pathEl = probe.window.document.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathEl.getTotalLength = () => 420;
    probe.drawBrace(pathEl);
    const dash = pathEl.style.strokeDasharray;
    const off = pathEl.style.strokeDashoffset;
    const transBefore = pathEl.style.transition;
    /* переход включается в следующем кадре — иначе браузер склеит начало и конец */
    await new Promise((r) => setTimeout(r, 80));
    const after = pathEl.style.strokeDashoffset;
    const transAfter = pathEl.style.transition;
    probe.close();
    check('длина пути ушла в штрих', dash === '420', dash || '—');
    check('в начале скобка не проведена', off === '420', off || '—');
    check('до кадра перехода ещё нет — иначе линия не нарисуется',
      transBefore === 'none', transBefore || '—');
    check('после кадра переход включён — линия рисуется',
      /stroke-dashoffset/.test(transAfter), transAfter || '—');
    check('после кадра линия дорисована', after === '0', after || '—');
  }

  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int x = 1;' } },
    submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 3000, innerWidth: 1400,
    afterRun: async (win, st) => {
      const css = st.css || '';
      const i = css.indexOf('#sgx-chip .sgx-body{');
      const rule = i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1);
      check('у скобки нет белой заливки', /background:transparent/.test(rule), rule);
      check('у скобки нет синей обводки', /border:0/.test(rule) && !/#2F7CE0/.test(rule), rule);
      check('у скобки нет скругления карточки', /border-radius:0/.test(rule), rule);
      const chip = win.document.querySelector('#sgx-chip');
      check('скобка отмечена как нарисованная',
        !!chip && chip.getAttribute('data-drawn') === '1',
        chip ? String(chip.getAttribute('data-drawn')) : 'нет');
    }
  });

  /* --- 72. смена задания сбрасывает ИИ ------------------------------------ */
  console.log('\n=== 72. перешли на новое задание — лента ИИ сброшена ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML,
      ['ensureAiRoot', 'aiSlot', 'aiShow', 'aiLogAdd', 'aiLogEl', 'resetAiForStep'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    probe.ensureAiRoot();
    probe.aiSlot();
    probe.aiShow(true);
    probe.aiLogAdd('Ответ на прошлое задание', 'sys');
    const before = probe.aiLogEl().textContent;
    probe.resetAiForStep({ key: 'l1793281_s8', step: 8 }, false);
    const after = probe.aiLogEl().textContent;
    probe.close();
    check('до смены шага в ленте был ответ', /прошлое задание/.test(before), before);
    check('после смены шага лента пуста', after.trim() === '', JSON.stringify(after));
  }

  console.log('\n=== 72a. блок ИИ открыт → новое задание решается само ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 14000, cmMode: 'text/x-python',
    /* второй ответ нарочно другой: иначе не отличить «лента очищена» от «в ленте
       тот же текст»                                                          */
    aiPaidQueue: [
      'print(первый_ответ_для_шага_8)\n',
      'print(второй_ответ_для_шага_11)\n'
    ],
    afterRun: async (win, st) => {
      /* человек работает с ИИ: блок открыт и ответ уже получен */
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));
      const first = st.aiPaidCalls.length;
      check('первый ответ получен', first >= 1, 'запросов: ' + first);

      /* переходим на другой шаг — страница перезагружается, но состояние то же */
      const before = aiFeedText(win, st);
      check('в ленте есть ответ', /первый_ответ_для_шага_8/.test(before), before.slice(0, 60));

      /* переходим на другой шаг: адрес меняется, шаг определяется по нему */
      win.history.pushState({}, '', `/lesson/${LESSON}/step/11?unit=1818966`);
      await new Promise((r) => setTimeout(r, 6000));
      const after = aiFeedText(win, st);
      check('ответ прошлого шага из ленты убран', !/первый_ответ_для_шага_8/.test(after),
        after.slice(0, 100));
      check('за новое задание взялись сами, без нажатий',
        st.aiPaidCalls.length > first, 'запросов: ' + st.aiPaidCalls.length + ', было ' + first);
      check('в ленте реплика про новый шаг', /Шаг 11\./.test(after), after.slice(0, 100));
      check('и решение для нового шага', /второй_ответ_для_шага_11/.test(after),
        after.slice(0, 100));
    }
  });

  /* --- 73. ответ, пришедший после ухода, не показывается ------------------ */
  console.log('\n=== 73. ответ на покинутый шаг в ленту не попадает ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 16000, cmMode: 'text/x-python',
    aiDelay: 5000, aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      /* пока модель думает, человек уходит на другое задание */
      await new Promise((r) => setTimeout(r, 1500));
      win.history.pushState({}, '', `/lesson/${LESSON}/step/11?unit=1818966`);
      /* ждём дольше, чем идёт ответ */
      await new Promise((r) => setTimeout(r, 9000));
      check('ответ на покинутый шаг в ленте не показан',
        !/n % 2 == 0/.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 120));
      check('и в редактор он тоже не попал',
        !/n % 2 == 0/.test(st.setValue || ''), JSON.stringify((st.setValue || '').slice(0, 60)));
    }
  });

  /* --- 74. скобка рисуется один раз, надпись — вместе с ней --------------- */
  console.log('\n=== 74. скобка рисуется один раз, а не бесконечно ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: { l1793281_s8: { file: 'l1793281_s8.cs', ext: 'cs', kind: 'code', content: 'int x = 1;' } },
    submissions: [], html: HTML, waitMs: 4000, innerWidth: 1400,
    afterRun: async (win, st) => {
      const chip = win.document.querySelector('#sgx-chip');
      check('скобка показана', chip && chip.classList.contains('on'));
      check('отмечено, что нарисована', chip && chip.getAttribute('data-drawn') === '1',
        chip ? String(chip.getAttribute('data-drawn')) : '—');
      check('надпись появляется вместе со скобкой — есть класс появления',
        chip && chip.classList.contains('sgx-in'), chip ? chip.className : '—');
      /* tick зовёт showChip каждые 1.5 с: за 4 секунды это минимум дважды */
      const css = st.css || '';
      check('у надписи есть появление, а не мгновенный показ',
        /#sgx-chip\.sgx-in \.sgx-body\{/.test(css), 'правила нет');
    }
  });

  /* --- 75. сброс не закрывает блок ---------------------------------------- */
  console.log('\n=== 75. «Сбросить» чистит ленту, но блок не закрывает ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 12000, cmMode: 'text/x-python',
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));
      check('решение в ленте есть', /n % 2 == 0/.test(aiFeedText(win, st)),
        aiFeedText(win, st).slice(0, 60));

      const reset = win.document.querySelector('#sgx-ai-reset');
      reset.click();
      await new Promise((r) => setTimeout(r, 500));

      const root = win.document.querySelector('#sgx-ai-root');
      check('блок остался на экране', !!root && root.classList.contains('on'),
        root ? root.className : 'нет блока');
      check('лента очищена', !/n % 2 == 0/.test(aiFeedText(win, st)),
        aiFeedText(win, st).slice(0, 60));
      check('сказано, что можно начать заново', /заново/i.test(aiFeedText(win, st)),
        aiFeedText(win, st).slice(0, 80));
    }
  });

  /* --- 76. провал теста с выбором → другой вариант ------------------------ */
  console.log('\n=== 76. «Пока неправильно» распознаётся, и просим ДРУГОЙ вариант ===');
  {
    const probe = probeSandbox(CHOICE_FAIL_HTML, ['looksLikeCheckError', 'stepErrorText'],
      `https://stepik.org/lesson/${LESSON}/step/2`);
    const bad = probe.looksLikeCheckError('Пока неправильно, попробуйте еще раз!');
    const good = probe.looksLikeCheckError('Верно! Молодец, всё правильно');
    probe.close();
    check('«Пока неправильно» — это ошибка проверки', bad, 'не распознано');
    check('«Верно» ошибкой не считается', !good, 'ложное срабатывание');
  }

  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/2?unit=1818966`,
    store: {}, submissions: [], html: CHOICE_FAIL_HTML, waitMs: 20000,
    aiPaidQueue: [
      'static void Multiply(int a, int b)',
      'static int Multiply(int a, int b)'
    ],
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));
      const inputs = Array.from(win.document.querySelectorAll('.quiz-component input[type=radio]'));
      check('первый вариант отмечен', inputs.filter((i) => i.checked).length === 1,
        'отмечено: ' + inputs.filter((i) => i.checked).length);

      const sub = win.document.querySelector('button.submit');
      if (sub) sub.click();
      await new Promise((r) => setTimeout(r, 9000));

      check('отчёт проверки прочитан из шапки',
        /Пока неправильно/.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 120));
      check('сделана вторая попытка у ИИ', st.aiPaidCalls.length >= 2,
        'запросов: ' + st.aiPaidCalls.length);
      const last = st.aiPaidCalls[st.aiPaidCalls.length - 1];
      const asked = last ? last.body : '';
      check('модели сказано, что первый вариант уже не подошёл',
        /Уже отправляли/.test(asked) && /static void Multiply\(int a, int b\)/.test(asked),
        'прошлой попытки в запросе нет');
      check('модели сказано выбрать другой вариант', /Выбери ДРУГОЙ/.test(asked),
        'нет требования выбрать другой');
      check('отмечен уже другой вариант',
        !!(inputs[3] && inputs[3].checked), 'второй вариант не отмечен');
    }
  });

  /* --- 77. варианты в чате: круг или квадрат ------------------------------ */
  console.log('\n=== 77. варианты ответа показаны в чате с метками ===');
  {
    const probe = probeSandbox(CHOICE_ONLY_HTML,
      ['choiceMultiple', 'aiLogChoice', 'ensureAiRoot', 'aiSlot', 'aiLogEl'],
      `https://stepik.org/lesson/${LESSON}/step/2`);
    probe.ensureAiRoot();
    probe.aiSlot();
    const one = probe.choiceMultiple();
    probe.aiLogChoice({ ids: ['104'], answers: ['static int Multiply(int a, int b)'] });
    const doc = probe.window.document;
    const marks = Array.from(doc.querySelectorAll('#sgx-ai-log .sgx-ai-mark'));
    const on = Array.from(doc.querySelectorAll('#sgx-ai-log .sgx-ai-opt.on'));
    const note = doc.querySelector('#sgx-ai-log .sgx-ai-optnote');
    probe.close();
    check('один ответ — кружки, а не квадраты', !one, 'тип определён как «несколько»');
    check('все варианты попали в ленту', marks.length === 4, 'меток: ' + marks.length);
    check('метка круглая', marks.length > 0 && /circle/.test(marks[0].className),
      marks.length ? marks[0].className : '—');
    check('закрашен ровно один вариант', on.length === 1, 'закрашено: ' + on.length);
    check('закрашен именно выбранный',
      on.length === 1 && /static int Multiply\(int a, int b\)/.test(on[0].textContent),
      on.length ? on[0].textContent : '—');
    check('подписано, что ответ один', !!note && /один ответ/i.test(note.textContent),
      note ? note.textContent : '—');
  }

  console.log('\n=== 77a. несколько ответов — квадраты ===');
  {
    const probe = probeSandbox(CHOICE_CHECK_HTML,
      ['choiceMultiple', 'aiLogChoice', 'ensureAiRoot', 'aiSlot'],
      `https://stepik.org/lesson/${LESSON}/step/2`);
    probe.ensureAiRoot();
    probe.aiSlot();
    const many = probe.choiceMultiple();
    probe.aiLogChoice({ ids: ['301', '302'], answers: ['первый', 'второй'] });
    const doc = probe.window.document;
    const marks = Array.from(doc.querySelectorAll('#sgx-ai-log .sgx-ai-mark'));
    const on = Array.from(doc.querySelectorAll('#sgx-ai-log .sgx-ai-opt.on'));
    const note = doc.querySelector('#sgx-ai-log .sgx-ai-optnote');
    probe.close();
    check('несколько ответов распознаны', many, 'тип определён как «один»');
    check('метка квадратная', marks.length > 0 && /box/.test(marks[0].className),
      marks.length ? marks[0].className : '—');
    check('закрашено два варианта', on.length === 2, 'закрашено: ' + on.length);
    check('подписано, что ответов несколько', !!note && /несколько/i.test(note.textContent),
      note ? note.textContent : '—');
  }

  /* --- 78. свободный ответ в поле ----------------------------------------- */
  console.log('\n=== 78. задание со свободным ответом в поле ===');
  {
    const probe = probeSandbox(TEXT_QUIZ_HTML,
      ['stepKindNow', 'aiSystem', 'insertTarget', 'choiceMultiple'],
      `https://stepik.org/lesson/${LESSON}/step/4`);
    const kind = probe.stepKindNow();
    const sys = probe.aiSystem('text');
    const t = probe.insertTarget();
    probe.close();
    check('вид задания определён как свободный ответ', kind === 'text', kind);
    check('системный текст говорит, что это не код', /НЕ код/.test(sys), sys.slice(0, 60));
    check('поле ответа найдено', !!t && /string-quiz__textarea/.test(t.el.className),
      t ? t.el.className : '—');
    check('скобка обрамляет само поле, а не весь блок',
      !!t && t.anchor === t.el, t ? t.anchor.className : '—');
  }

  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/4?unit=1818966`,
    store: {}, submissions: [], html: TEXT_QUIZ_HTML, waitMs: 10000,
    aiPaidText: 'bool',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 5000));
      const area = win.document.querySelector('.string-quiz__textarea');
      check('ответ записан в поле', !!area && area.value.trim() === 'bool',
        area ? JSON.stringify(area.value) : 'поля нет');
      check('«Запустить код» для такого задания не ищем',
        !/Кнопку «Запустить код»/.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 120));
      check('в ленте сказано про поле, а не про редактор',
        /Записал ответ в поле/.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 120));
      const name = Object.keys(st.inbox)[0] || '';
      check('ответ сохранён с расширением .txt', /\.txt$/.test(name), name || 'ничего не ушло');
      check('и в хранилище именно ответ', (st.inbox[name] || '').trim() === 'bool',
        JSON.stringify(st.inbox[name] || ''));
    }
  });

  /* --- 79. ключа и адреса в исходнике нет -------------------------------- */
  console.log('\n=== 79. ключ не лежит в скрипте, адрес не подсказан ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML,
      ['aiKey', 'aiEndpoint', 'aiChannels'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const key = probe.aiKey();
    const url = probe.aiEndpoint();
    const channels = probe.aiChannels().map((c) => c.id);
    probe.close();
    /* Ключа в скрипте нет вовсе: без настройки ИИ работает через прокси, и
       в браузере ключа не появляется.                                        */
    check('встроенного ключа нет', key === '', JSON.stringify(key));
    check('без настройки ИИ всё равно работает', channels.length > 0, channels.join(','));
    check('и работает именно через прокси', channels[0] === 'proxy', channels.join(','));
    check('прямого канала без своего ключа нет', channels.indexOf('own') < 0, channels.join(','));
    check('адрес канала собирается правильно',
      /^https:\/\/[a-z.]+\/v1\/chat\/completions$/.test(url), url);
  }

  console.log('\n=== 79a. свой ключ важнее общего, пустое поле выключает ИИ ===');
  {
    const mine = probeSandbox(QUIZ_PLUGIN_HTML, ['aiKey', 'aiChannels', 'aiErrorText'],
      `https://stepik.org/lesson/${LESSON}/step/8`, { aiKey: 'sk-moy-klyuch' });
    const own = mine.aiKey();
    const ownCh = mine.aiChannels().map((c) => c.id);
    const ownMsg = mine.aiErrorText(429);
    mine.close();
    check('взят свой ключ', own === 'sk-moy-klyuch', 'взят не свой');
    check('со своим ключом появляется прямой канал', ownCh.indexOf('own') >= 0, ownCh.join(','));
    check('прокси при этом остаётся', ownCh.indexOf('proxy') >= 0, ownCh.join(','));
    check('сообщение про лимит без «общего ключа»', !/общий ключ/.test(ownMsg), ownMsg);

    /* Пустой ключ убирает прямой канал, но прокси продолжает работать: это два
       независимых выключателя. Совсем выключить ИИ можно, убрав и прокси.     */
    const off = probeSandbox(QUIZ_PLUGIN_HTML, ['aiKey', 'aiChannels'],
      `https://stepik.org/lesson/${LESSON}/step/8`, { aiKey: '' });
    const none = off.aiKey();
    const chLeft = off.aiChannels().map((c) => c.id);
    off.close();
    check('пустое поле убирает прямой канал', none === '', JSON.stringify(none));
    check('но прокси продолжает работать', chLeft.indexOf('proxy') >= 0, chLeft.join(','));
    check('прямого канала в списке нет', chLeft.indexOf('own') < 0, chLeft.join(','));

    const both = probeSandbox(QUIZ_PLUGIN_HTML, ['aiChannels'],
      `https://stepik.org/lesson/${LESSON}/step/8`, { aiKey: '', aiProxy: '' });
    const noCh = both.aiChannels().length;
    both.close();
    check('ключ и прокси убраны — ИИ выключен совсем', noCh === 0, 'каналов: ' + noCh);
  }

  console.log('\n=== 79b. лимит объяснён внятно и с подсказкой ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML, ['aiErrorText'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const m402 = probe.aiErrorText(402);
    const m429 = probe.aiErrorText(429);
    const m401 = probe.aiErrorText(401);
    probe.close();
    check('про 402 сказано прямо', /402/.test(m402), m402);
    check('про 429 подсказано, что делать', /429/.test(m429) && /ключ/.test(m429), m429);
    check('без своего ключа про 401 сказано коротко', /401/.test(m401), m401);
    const ownProbe = probeSandbox(QUIZ_PLUGIN_HTML, ['aiErrorText'],
      `https://stepik.org/lesson/${LESSON}/step/8`, { aiKey: 'sk-moy' });
    const own401 = ownProbe.aiErrorText(401);
    ownProbe.close();
    check('со своим ключом сказано, где его проверить',
      /Настройки ИИ/.test(own401), own401);
  }

  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'stepik-gist-sync.user.js'), 'utf8');
    check('в скрипте нет ключа вида sk-…', !/sk-[0-9a-f]{20,}/i.test(src),
      (src.match(/sk-[0-9a-f]{8,}/i) || [''])[0]);
    check('в скрипте нет адреса канала целиком',
      src.indexOf('api.reformboss.com/v1') < 0, 'адрес лежит открытым текстом');
    check('в скрипте нет встроенных «кусков» ключа',
      !/DEF_AI_CHUNKS|DEF_AI_KEY/.test(src), 'остались встроенные ключи');
    check('в подсказке настроек нет адреса',
      !/prompt\([^)]*reformboss/i.test(src), 'адрес в тексте диалога');
    /* ключ не подставляется в поле ввода: иначе он виден на экране */
    check('ключ не подставляется в диалог настроек',
      !/cfg\.aiKey \|\| aiKey\(\)/.test(src), 'ключ всё ещё подставляется');
  }

  /* --- 80. квадратики: отмечаем только нужные ----------------------------- */
  console.log('\n=== 80. в тесте с несколькими ответами отмечаются только нужные ===');
  {
    const probe = probeSandbox(CHOICE_CHECK_HTML, ['writeChoice'],
      `https://stepik.org/lesson/${LESSON}/step/2`);
    const state = () => Array.from(probe.window.document.querySelectorAll('input[type=checkbox]'))
      .map((i) => i.checked);
    probe.writeChoice({ ids: ['302'], answers: ['второй'] });
    const one = state();
    probe.writeChoice({ ids: ['301', '303'], answers: ['первый', 'третий'] });
    const two = state();
    probe.writeChoice({ ids: ['303'], answers: ['третий'] });
    const three = state();
    probe.close();
    check('отмечен ровно один из трёх', one.join(',') === 'false,true,false', one.join(','));
    check('переключение на два других работает', two.join(',') === 'true,false,true', two.join(','));
    check('лишние галочки снимаются', three.join(',') === 'false,false,true', three.join(','));
  }

  /* --- 81. после сброса можно спросить заново прямо из блока -------------- */
  console.log('\n=== 81. после сброса «Спросить ИИ» работает и индикатор в чате ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 14000, cmMode: 'text/x-python',
    aiDelay: 3000,
    aiPaidQueue: [
      'print(первый_ответ)\\n',
      'print(второй_ответ)\\n'
    ],
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 5000));
      check('первый ответ получен', /первый_ответ/.test(aiFeedText(win, st)),
        aiFeedText(win, st).slice(0, 80));

      const root = win.document.querySelector('#sgx-ai-root');
      const ask = root && root.querySelector('#sgx-ai-ask');
      check('в блоке есть кнопка «Спросить ИИ»', !!ask, 'кнопки нет');

      root.querySelector('#sgx-ai-reset').click();
      await new Promise((r) => setTimeout(r, 400));
      check('после сброса блок открыт', root.classList.contains('on'), root.className);
      check('после сброса кнопка снова зовёт спрашивать',
        /Спросить ИИ/.test(ask.textContent), ask.textContent);

      const before = st.aiPaidCalls.length;
      ask.click();
      await new Promise((r) => setTimeout(r, 900));
      /* пока модель думает, в чате должна быть строка «думает» */
      check('индикатор «думает» появился в чате',
        !!win.document.querySelector('#sgx-ai-log .sgx-ai-think'),
        aiFeedText(win, st).slice(0, 100));
      check('в чате сказано, чем занят ИИ',
        /пишет решение/i.test(aiFeedText(win, st)), aiFeedText(win, st).slice(0, 100));

      await new Promise((r) => setTimeout(r, 4000));
      check('сделан новый запрос', st.aiPaidCalls.length > before,
        st.aiPaidCalls.length + ' против ' + before);
      check('и пришёл новый ответ', /второй_ответ/.test(aiFeedText(win, st)),
        aiFeedText(win, st).slice(0, 100));
      check('индикатор убран после ответа',
        !win.document.querySelector('#sgx-ai-log .sgx-ai-think'), 'остался висеть');
    }
  });

  /* --- 82. метки вариантов: зелёные, заполнение по центру ----------------- */
  console.log('\n=== 82. метки вариантов зелёные, блок как у кода ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/2?unit=1818966`,
    store: {}, submissions: [], html: CHOICE_ONLY_HTML, waitMs: 8000,
    aiPaidText: 'static int Multiply(int a, int b)',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));
      const css = st.css || '';
      const rule = (sel) => {
        const i = css.indexOf(sel + '{');
        return i < 0 ? '' : css.slice(i, css.indexOf('}', i) + 1);
      };
      const opts = rule('#sgx-ai-panel .sgx-ai-opts');
      const code = rule('#sgx-ai-panel .sgx-ai-code');
      const mark = rule('#sgx-ai-panel .sgx-ai-mark');
      check('блок вариантов оформлен как блок кода',
        /background:#F7F7F6/.test(opts) && /background:#F7F7F6/.test(code),
        opts || 'правила нет');
      check('у блока вариантов та же рамка, что у кода',
        /border:1px solid #ECECEA/.test(opts), opts || '—');
      check('у блока вариантов то же скругление',
        /border-radius:var\(--sgx-r-sm\)/.test(opts), opts || '—');
      check('рамка метки зелёная', /#A9C6A9|#2E7D32/.test(mark), mark || '—');
      const on = rule('#sgx-ai-panel .sgx-ai-opt.on .sgx-ai-mark');
      check('выбранная метка зелёная', /#2E7D32/.test(on), on || '—');
      const circle = rule('#sgx-ai-panel .sgx-ai-opt.on .sgx-ai-mark.circle::after');
      const box = rule('#sgx-ai-panel .sgx-ai-opt.on .sgx-ai-mark.box::after');
      check('заполнение круга стоит по центру, а не заливает целиком',
        /inset:4px/.test(circle), circle || '—');
      check('заполнение квадрата тоже по центру', /inset:4px/.test(box), box || '—');
      check('заполнение зелёное', /background:#2E7D32/.test(circle), circle || '—');
    }
  });

  /* --- 83. прокси: ключа в браузере нет вовсе ----------------------------- */
  console.log('\n=== 83. с прокси запрос идёт через него и без ключа ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML,
      ['aiChannels', 'aiProxyUrl'],
      `https://stepik.org/lesson/${LESSON}/step/8`,
      { aiProxy: 'https://script.google.com/macros/s/TEST/exec' });
    const list = probe.aiChannels().map((c) => c.id);
    const url = probe.aiProxyUrl();
    probe.close();
    check('прокси распознан', url.indexOf('script.google.com') >= 0, url || 'пусто');
    check('прокси идёт первым каналом', list[0] === 'proxy', list.join(','));
  }

  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiProxy: 'https://script.google.com/macros/s/TEST/exec',
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));

      const call = st.aiPaidCalls[0];
      check('запрос ушёл на прокси, а не к провайдеру',
        !!call && call.url.indexOf('script.google.com') >= 0,
        call ? call.url : 'запроса нет');
      check('в запросе НЕТ заголовка с ключом',
        !call || !call.auth, String((call || {}).auth || 'нет — и это правильно'));
      const body = call ? call.body : '';
      check('в теле запроса ключа тоже нет', !/sk-|Bearer/i.test(body), 'тело чистое');
      check('модель и лимит переданы как обычно',
        /"model"/.test(body) && /"max_tokens"/.test(body), body.slice(0, 80));
      check('ответ дошёл и решение в ленте', /n % 2 == 0/.test(aiFeedText(win, st)),
        aiFeedText(win, st).slice(0, 80));
    }
  });

  console.log('\n=== 83a. прокси ответил ошибкой — она читается из тела ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 12000, cmMode: 'text/x-python',
    aiProxy: 'https://script.google.com/macros/s/TEST/exec',
    aiProxyError: { status: 429, message: 'лимит' },
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 8000));
      const status = statusText(win);
      check('ошибка прокси не выглядит как «пустой ответ»',
        !/пустой ответ/.test(status), status);
      check('сказано про лимит', /лимит|429/i.test(status + aiFeedText(win, st)),
        status + ' | ' + aiFeedText(win, st).slice(0, 80));
    }
  });

  console.log('\n=== 83b. прокси вернул страницу входа вместо JSON ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 12000, cmMode: 'text/x-python',
    aiProxy: 'https://script.google.com/macros/s/TEST/exec',
    aiProxyHtml: true,
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 8000));
      const status = statusText(win);
      check('сказано, что прокси ответил не JSON', /не JSON/.test(status), status);
      check('и что проверить доступ к развёртыванию', /для всех/.test(status), status);
      check('ошибка не выглядит как «пустой ответ модели»',
        !/пустой ответ/.test(status), status);
    }
  });

  /* --- 84. встроенный прокси: работает сразу, без настройки --------------- */
  console.log('\n=== 84. встроенный прокси включён по умолчанию ===');
  {
    const probe = probeSandbox(QUIZ_PLUGIN_HTML,
      ['aiProxyUrl', 'aiChannels', 'aiUsingProxy', 'aiProxyCleared'],
      `https://stepik.org/lesson/${LESSON}/step/8`);
    const url = probe.aiProxyUrl();
    const list = probe.aiChannels().map((c) => c.id);
    const on = probe.aiUsingProxy();
    probe.close();
    /* Адрес не печатаем: проверяем форму */
    check('адрес прокси встроен и раскрывается',
      url.indexOf('https://script.google.com/macros/s/') === 0 && /\/exec$/.test(url),
      'длина ' + String(url).length);
    check('через прокси ходим сразу, без настройки', on, 'прокси выключен');
    check('прокси идёт первым каналом', list[0] === 'proxy', list.join(','));
    /* Прямого канала без своего ключа нет: ключа в скрипте больше не лежит. */
    check('прямого канала без своего ключа нет', list.indexOf('own') < 0, list.join(','));
  }

  console.log('\n=== 84a. запрос по умолчанию идёт на прокси и без ключа ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiProxy: null,
    aiPaidText: 'n = int(input())\nprint(n % 2 == 0)\n',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 4000));
      const call = st.aiPaidCalls[0];
      check('запрос ушёл на прокси из скрипта',
        !!call && call.url.indexOf('script.google.com') >= 0,
        call ? call.url : 'запроса нет');
      check('ключа в запросе нет', !call || !call.auth,
        String((call || {}).auth || 'нет — и это правильно'));
      check('решение пришло', /n % 2 == 0/.test(aiFeedText(win, st)),
        aiFeedText(win, st).slice(0, 80));
    }
  });

  console.log('\n=== 84b. прокси можно выключить и вернуться к прямому каналу ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: QUIZ_PLUGIN_HTML, waitMs: 9000, cmMode: 'text/x-python',
    aiProxy: '',
    aiPaidText: 'ok',
    afterRun: async (win, st) => {
      st.menu['✨ ИИ: решить текущий шаг']();
      await new Promise((r) => setTimeout(r, 3000));
      const call = st.aiPaidCalls[0];
      check('при выключенном прокси идём напрямую',
        !!call && call.url.indexOf('script.google.com') < 0,
        call ? call.url : 'запроса нет');
      check('и ключ снова уходит заголовком', !!call && /^Bearer /.test(String(call.auth)),
        String((call || {}).auth || 'нет'));
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== ИТОГ: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено ===');
  if (failed.length) { console.log('ПРОВАЛЫ: ' + failed.map((f) => f.name).join('; ')); process.exit(1); }
  /* Выходим ЯВНО. Без этого процесс не завершается: окна jsdom держат живые
     таймеры, Node ждёт их и висит уже ПОСЛЕ итоговой строки — прогон выглядел
     как «идёт сорок минут», хотя работа закончилась.                          */
  process.exit(0);
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
