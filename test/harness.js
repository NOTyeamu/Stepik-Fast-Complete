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

function run({ url, store, submissions, html, storeDown, emptyLessonSteps, token, job, innerWidth, waitMs, afterRun }) {
  return new Promise((resolve, reject) => {
    const dom = new JSDOM(html, { url, runScripts: 'dangerously', pretendToBeVisual: true });
    const { window } = dom;
    const state = {
      calls: [], inbox: {}, inboxMessages: [], menu: {},
      store: Object.assign({}, store || {}), submissions: submissions || [],
      storeDown: !!storeDown, emptyLessonSteps: !!emptyLessonSteps,
      setValue: null, submitted: 0, docBlob: null, shots: 0,
      storage: { writeToken: token === undefined ? 'github_pat_11TEST' : token }
    };
    if (job) state.storage.job = JSON.stringify(job);
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
      return { width: 600, height: 200, top: 100, left: 50, right: 650, bottom: 300, x: 50, y: 100 };
    };
    Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', { get: () => 120, configurable: true });

    const cmNode = window.document.querySelector('.CodeMirror');
    if (cmNode) {
      const submitBtn = window.document.querySelector('button.submit');
      if (submitBtn) submitBtn.addEventListener('click', () => { state.submitted++; });

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
      window.CustomEvent, window.Event, window.KeyboardEvent, window.MouseEvent,
      window.HTMLTextAreaElement, window.HTMLInputElement, TextEncoder, btoa,
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

const HTML = `<!doctype html><html><body>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="CodeMirror"><textarea></textarea></div>
  </div></div>
</body></html>`;

const JOB_HTML = `<!doctype html><html><body>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-text">Напишите программу, которая выводит число</div>
    <div class="CodeMirror"><textarea></textarea></div>
    <button class="submit">Отправить</button>
  </div></div>
</body></html>`;

const SIDEBAR_HTML = `<!doctype html><html><body>
  <div class="lesson-navigation">
    <a href="/lesson/1755852">4.1 Знакомство с методами</a>
    <a href="/lesson/1755853">4.2 Перегрузка и возвращаемое значение</a>
    <a href="/lesson/1755854">4.3 Массивы и возврат значения</a>
  </div>
  <div class="attempt-wrapper"><div class="attempt-wrapper__content">
    <div class="step-text">Задание</div>
    <div class="CodeMirror"><textarea></textarea></div>
    <button class="submit">Отправить</button>
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

  console.log('\n=== 10. панель «от и до» появилась ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: HTML, waitMs: 2000,
    afterRun: async (win) => {
      const fab = win.document.querySelector('#sgx-fab');
      const panel = win.document.querySelector('#sgx-panel');
      check('кнопка «от и до» есть', !!fab, fab && fab.textContent);
      check('панель есть', !!panel);
      check('есть поле «с шага»', !!win.document.querySelector('#sgx-from'));
      check('есть выбор «уроки / шаги»', !!win.document.querySelector('#sgx-mode'));
      check('режим по умолчанию — уроки', win.document.querySelector('#sgx-mode').value === 'lessons');
      check('есть кнопка «Пройти»', /Пройти/.test(win.document.querySelector('#sgx-solve').textContent));
      check('есть кнопка «Собрать в Word»', /Word/.test(win.document.querySelector('#sgx-collect').textContent));
      fab.click();
      check('панель открывается', panel.classList.contains('on'));
      /* по умолчанию режим «уроки», а в режиме шагов номер подставляется сам */
      win.document.querySelector('#sgx-mode').value = 'steps';
      win.document.querySelector('#sgx-mode').dispatchEvent(new win.Event('change'));
      check('номер шага подставился автоматически',
        win.document.querySelector('#sgx-from').value === '8',
        win.document.querySelector('#sgx-from').value);
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
      const btn = win.document.querySelector('button.submit');
      check('задание отправлено', st.submitted === 1, 'кликов: ' + st.submitted);
      check('обход завершён', JSON.parse(st.storage.job || 'null') === null, st.storage.job);
      check('статус говорит «готово»', /готово/.test(win.document.querySelector('#sgx-status').textContent),
        win.document.querySelector('#sgx-status').textContent);
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
      check('статус про документ', /документ|скриншот/.test(win.document.querySelector('#sgx-status').textContent),
        win.document.querySelector('#sgx-status').textContent);
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
    store: {}, submissions: [], html: SIDEBAR_HTML, waitMs: 3000,
    afterRun: async (win, st) => {
      const opts = win.document.querySelectorAll('#sgx-lessons option');
      check('уроки нашлись в меню курса', opts.length === 3, opts.length + ': ' +
        Array.from(opts).map((o) => o.value).join(', '));
      check('подсказки с номерами уроков', Array.from(opts).map((o) => o.value).join(',') === '4.1,4.2,4.3',
        Array.from(opts).map((o) => o.value).join(','));

      win.document.querySelector('#sgx-from').value = '4.1';
      win.document.querySelector('#sgx-to').value = '4.3';
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

  console.log('\n=== 15. диапазон по шагам одного урока ===');
  await run({
    url: `https://stepik.org/lesson/${LESSON}/step/8?unit=1818966`,
    store: {}, submissions: [], html: SIDEBAR_HTML, waitMs: 3000,
    afterRun: async (win, st) => {
      win.document.querySelector('#sgx-mode').value = 'steps';
      win.document.querySelector('#sgx-mode').dispatchEvent(new win.Event('change'));
      win.document.querySelector('#sgx-from').value = '2';
      win.document.querySelector('#sgx-to').value = '4';
      win.document.querySelector('#sgx-collect').click();
      await new Promise((r) => setTimeout(r, 800));

      const job = JSON.parse(st.storage.job || 'null');
      check('план из трёх шагов', job && job.plan.length === 3, job && job.plan.length);
      check('все шаги текущего урока', job && job.plan.every((p) => p.lesson === String(LESSON)));
      check('первый шаг — 2', job && job.plan[0].step === 2, job && job.plan[0].step);
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n=== ИТОГ: ' + (results.length - failed.length) + '/' + results.length + ' проверок пройдено ===');
  if (failed.length) { console.log('ПРОВАЛЫ: ' + failed.map((f) => f.name).join('; ')); process.exit(1); }
})().catch((e) => { console.error('harness error:', e); process.exit(2); });
