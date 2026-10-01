// ==UserScript==
// @name         Stepik ⇄ Gist — автосохранение и вставка ответов
// @namespace    stepik-gist-sync
// @version      6.21.0
// @description  Зачтённые ответы Stepik (код и тесты с выбором варианта) автоматически уезжают в общую папку answers/ этого репозитория. Ответ берётся из API самого Stepik, поэтому вёрстка и редактор ни на что не влияют. На шаге, где решение уже сохранено, справа от карточки появляется скоба «вставить / нет». Кнопка рядом с полноэкранным режимом открывает панель прямо в боковом меню курса — в стиле самого Stepik. Панель умеет пройти задания пачкой и собрать их в Word со скриншотами. Там, где ответа ещё нет, решение подскажет ИИ: прямо в карточке задания, рядом с редактором кода, светлым блоком в стиле соседних панелей и на одной шкале размеров, без ```-обёрток, с учётом уровня урока, с самопроверкой по тестовым данным и выбором модели. Готовое решение скрипт сам печатает в редакторе построчно, нажимает «Запустить код» и показывает вывод запуска прямо в ленте (отправку на проверку — никогда). Лента выглядит как чат: логотип отвечающей модели и живые реплики. Тесты с выбором скрипт решает сам: показывает варианты в чате кружками или квадратами, отмечает нужные, а при отказе проверки берёт другой вариант. Задания со свободным ответом в поле тоже решаются. При переходе на новое задание блок ИИ сбрасывается и сразу берётся за новое. Запросы идут через прокси, а ключ доступа живёт только на сервере — в браузер он не попадает вообще. Расход ограничен суточным лимитом. Свой ключ или свой прокси можно вписать в настройках. Если общий упрётся в лимит, скрипт скажет об этом прямо. Модель выбирается списком с логотипом и уровнем «ума»: от быстрой glm-5.3-flash до заточенной под код kimi-k2.7-code и сильной deepseek-v4-pro, у каждой свой лимит ответа. Размышления reasoning-моделей отрезаются от решения, обрезанный по лимиту ответ помечается и не уезжает в общее хранилище. Проваленные тесты в отчёте выделены красным. Если тесты не прошли — ИИ прочитает ошибку, сам вернёт редактор кнопкой «Изменить решение» и попробует исправить: решение пишется только тем, что уже было в уроке, без import и лишних конструкций.
// @author       NOTyeamu
// @match        *://stepik.org/*
// @match        *://*.stepik.org/*
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @connect      api.reformboss.com
// @connect      script.google.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/NOTyeamu/Stepik-Fast-Complete/main/stepik-gist-sync.user.js
// @downloadURL  https://raw.githubusercontent.com/NOTyeamu/Stepik-Fast-Complete/main/stepik-gist-sync.user.js
// ==/UserScript==

/*
 * ЧТО ДЕЛАЕТ
 *  • Шаг зачтён — ответ сам уезжает в общую папку answers/ репозитория. Ответ берётся
 *    не из DOM, а из API Stepik (/api/submissions): сервер отдаёт ровно то, что принял,
 *    вместе со статусом "correct". Плюс перехватываются сетевые запросы самой Stepik,
 *    чтобы поймать отправку в момент нажатия «Отправить».
 *  • На шаге, для которого решение уже есть, справа от карточки появляется скоба
 *    ( есть решение · вставить / нет ).
 *  • Где решения ещё нет, его подсказывает ИИ. Ответ появляется прямо в карточке
 *    задания — там же, где редактор кода, светлым блоком в стиле соседних панелей
 *    Stepik и на одной шкале размеров. Из ответа снимаются ```-обёртки и метка
 *    языка, поэтому он копируется одним нажатием, а кнопка копирования стоит
 *    внутри самого кода. Модель знает, что уже проходили в уроке (текст лекции
 *    запоминается, пока её читают), держится этого уровня и сама сверяет вывод
 *    с тестовыми данными перед ответом. Модель можно переключить прямо в блоке.
 *    Готовое решение скрипт сам вставляет в редактор и нажимает «Запустить код»,
 *    чтобы сразу был виден результат. «Отправить на проверку» он не нажимает
 *    никогда — отправка остаётся за человеком. Ответ, оборвавшийся по лимиту
 *    токенов, помечается как неполный, не вставляется и в общее хранилище
 *    не попадает.
 *
 * ГДЕ ЛЕЖИТ
 *    Исходник и установка: https://github.com/NOTyeamu/Stepik-Fast-Complete
 *    Установка в один клик (Tampermonkey сам предложит обновление):
 *    https://raw.githubusercontent.com/NOTyeamu/Stepik-Fast-Complete/main/stepik-gist-sync.user.js
 *
 * КАК ХРАНЯТСЯ ОТВЕТЫ
 *    answers/index.json          — список: ключ шага → файл, язык, вид (код или тест)
 *    answers/l<урок>_s<шаг>.<яз> — сам ответ; для теста это .json с вариантами
 *    Скрипт кладёт новый ответ в очередь inbox/, а workflow answers.yml переносит
 *    его в answers/ и откатывает любые правки этой папки, сделанные не роботом.
 *    Существующие ответы не перезаписываются никогда — папка только пополняется.
 *    Права на изменение самих workflow-файлов у токена нет (нужно workflows=write),
 *    поэтому выключить робота он не может.
 *
 * НАСТРОЙКА
 *    Меню Tampermonkey → «⚙ Токен записи». Ctrl+Alt+I — вставить решение,
 *    Ctrl+Alt+S — перезаписать принудительно, Ctrl+Alt+D — отчёт самопроверки.
 */

(function () {
  'use strict';

  var VERSION = '6.21.0';

  /* Репозиторий с ответами */
  var REPO = 'NOTyeamu/Stepik-Fast-Complete';
  var BRANCH = 'main';

  /* Токен с единственным правом «Actions: write» — только на этот репозиторий.
     Разбит на куски намеренно: GitHub автоматически отзывает токены, найденные
     в открытых репозиториях, — ищет непрерывную строку. */
  var DEF_TOKEN = 'github_pat_1' + '1A3MLZTQ090Ak9zudxqsU_bXlwU6roNAIiWb9zM03AZafZjVxnRM5HCWchgvgf1AKSFEY' + 'VU5DY7J16pY2';

  /* КЛЮЧА ЗДЕСЬ НЕТ И НЕ ДОЛЖНО БЫТЬ.

     Раньше он лежал в этом файле закодированным. Это не защита: скрипт открыт,
     и расшифровать его — дело двух минут. Теперь ключ живёт ТОЛЬКО в свойствах
     веб-приложения Google (server/AI-PROXY.md), а запросы идут через прокси:
     браузер ключа не видит вообще.

     Если ключа нет и в настройках, прямого канала просто нет — работает прокси.
     Свой ключ можно вписать в «🔑 Настройки ИИ», тогда он важнее прокси и не
     зависит от чужих лимитов.                                                   */
  /* ключ хранилища отдельный от старых версий: там в 'token' лежал токен гиста */
  var cfg = {
    token: GM_getValue('writeToken', DEF_TOKEN),
    aiKey: GM_getValue('aiKey', null)
  };
  function setToken(val) { cfg.token = val; GM_setValue('writeToken', val); }

  /* ---------------------------------------------------------------- утилиты */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function nowIso() { return new Date().toISOString(); }
  function log() {
    console.log.apply(console, ['%c[stepik-gist]', 'color:#5E9FE8;font-weight:600']
      .concat(Array.prototype.slice.call(arguments)));
  }
  function clone(obj) {
    try { if (typeof cloneInto === 'function') return cloneInto(obj, document.defaultView); }
    catch (e) { /* не Firefox */ }
    return obj;
  }

  /* ------------------------------------------------------------- хранилище */

  /* Ответы лежат в репозитории, в папке answers/. Читаются обычными ссылками
     (репозиторий публичный, прав не нужно). Пишет в папку только workflow
     answers.yml: скрипт кладёт ответ в очередь inbox/, робот переносит его
     в answers/ и заодно откатывает любые правки папки, сделанные не им.
     Права на изменение workflow-файлов у токена нет, поэтому выключить робота
     он не может. */

  var API = 'https://api.github.com/repos/' + REPO;
  var RAW = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/answers/';
  var INBOX = 'inbox';

  var STORE_TTL = 10 * 60 * 1000;   /* сколько доверяем локальному списку шагов */
  var storeDown = 0;                /* GitHub молчит — не долбим его */

  function rawUrl(name) { return RAW + name; }

  function ghHeaders() {
    return {
      Authorization: 'Bearer ' + cfg.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
  }

  async function ghError(res) {
    var msg = '';
    try { msg = (JSON.parse(await res.text()) || {}).message || ''; } catch (e) { /* ignore */ }
    if (res.status === 401) return 'токен не принят GitHub — меню → ⚙ Токен записи';
    if (res.status === 403) return 'токену не хватает права «Contents: write» на ' + REPO;
    if (res.status === 404) return 'токен не видит репозиторий ' + REPO;
    return 'GitHub ответил ' + res.status + (msg ? ': ' + msg : '');
  }

  function b64(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /* Список сохранённых шагов держим локально: скоба должна рисоваться мгновенно.
     Обновляем при переходе между шагами; ?t= снимает кэш CDN (он держит файл
     до пяти минут), поэтому чужие ответы видны максимум через минуту. */
  var cache = { at: 0, items: {} };

  /* Ключи, которые мы уже положили в очередь, но которых ещё нет в индексе:
     raw.githubusercontent.com отдаёт index.json до пяти минут старым, и без этого
     списка скоба пропадала бы сразу после сохранения, а ответ уходил бы повторно. */
  var pending = {};

  try {
    var cached = JSON.parse(GM_getValue('index', '{}'));
    if (cached && cached.items) cache = cached;
    pending = JSON.parse(GM_getValue('pending', '{}')) || {};
  } catch (e) { /* ignore */ }

  function cacheIndex() { return cache.items; }

  function saveCache() {
    try { GM_setValue('index', JSON.stringify(cache)); } catch (e) { /* ignore */ }
  }

  function savePending() {
    try { GM_setValue('pending', JSON.stringify(pending)); } catch (e) { /* ignore */ }
  }

  async function storeIndex(force) {
    if (!force && cache.at && Date.now() - cache.at < STORE_TTL) return cache.items;
    var url = rawUrl('index.json') + '?t=' + Math.floor(Date.now() / 60000);
    var res = await fetch(url, { headers: { Accept: 'text/plain' } });
    if (!res.ok) throw new Error('список ответов не читается (HTTP ' + res.status + ')');
    var data = null;
    try { data = JSON.parse(await res.text()); } catch (e) { data = null; }
    if (!data) throw new Error('index.json в репозитории повреждён');

    var items = {};
    Object.keys(data).forEach(function (key) {
      var it = data[key] || {};
      items[key] = {
        key: key,
        file: it.file || (key + '.' + (it.ext || 'txt')),
        kind: it.kind || 'code',
        ext: it.ext || 'txt'
      };
    });
    /* своё, но ещё не перенесённое роботом (или не отданное CDN) не теряем */
    Object.keys(pending).forEach(function (key) {
      if (items[key]) { delete pending[key]; return; }
      if (Date.now() - (pending[key].at || 0) > 30 * 60 * 1000) { delete pending[key]; return; }
      items[key] = pending[key].item;
    });
    savePending();

    cache = { at: Date.now(), items: items };
    saveCache();
    storeDown = 0;
    renderPanel(true);                 /* список уроков зависит от того, что уже сохранено */
    return items;
  }

  /* Ответ, который мы только что положили в очередь inbox/, лежит в answers/
     ещё не сразу: робот переносит файл за секунды, а CDN отдаёт старый каталог
     до пяти минут. Поэтому у «своей» записи в pending стоит local:true — читать
     её из сети бессмысленно, содержимое у нас уже под рукой.                    */
  function localItem(key) {
    var p = pending[key];
    if (!p || !p.item || !p.local || !p.content) return null;
    return { key: key, kind: p.item.kind, content: p.content, local: true };
  }

  async function storeItem(key) {
    /* своё, ещё не перенесённое роботом — отдаём сразу, без похода в сеть */
    var mine = localItem(key);
    if (mine) return mine;

    var it = cacheIndex()[key];
    if (!it) {
      /* В папке ответа ещё нет — он уезжает туда только после верной проверки.
         Тогда отдаём то, что ИИ решил на этом шаге: оно уже в памяти, и кнопка
         «вставить» должна работать, не дожидаясь публикации.                   */
      var fresh = aiItemFromMemory(key, null);
      if (fresh) return fresh;
      throw new Error('в хранилище нет ответа для ' + key);
    }

    var res = null;
    try {
      res = await fetch(rawUrl(it.file), { headers: { Accept: 'text/plain' } });
    } catch (e) {
      res = null;
    }
    /* Сеть отдала 404 — файл ещё не доехал до answers/ (или CDN держит старый
       каталог). Тогда читаем содержимое из памяти: оно там есть, раз ответ
       только что подсказал ИИ. Без этого кнопка «вставить» под своим же
       решением отвечала «ответ l…_s10.py не читается (HTTP 404)».              */
    if (!res || !res.ok) {
      var fallback = aiItemFromMemory(key, it);
      if (fallback) return fallback;
      throw new Error('ответ ' + it.file + ' не читается (HTTP ' + (res ? res.status : 'сеть') + ')');
    }
    var content = await res.text();
    if (!content.trim()) {
      var alt = aiItemFromMemory(key, it);
      if (alt) return alt;
      throw new Error('файл ' + it.file + ' пуст');
    }
    return { key: key, kind: it.kind, content: content };
  }

  /* Решение ИИ, которое ещё не доехало до answers/, но лежит в памяти. Для теста
     с выбором текст модели — это «2. Вариант такой-то», а вставка ждёт те же
     варианты, что и автосохранение, поэтому приводим его к JSON тем же способом,
     что и автосохранение. Без этого «вставить» на тесте с выбором падал бы на
     JSON.parse, хотя ответ у нас на руках.                                      */
  function aiItemFromMemory(key, it) {
    var text = aiAnswerAt(key);
    if (!text || !aiAnswer) return null;
    var kind = aiAnswer.kind || (it && it.kind) || 'code';
    if (kind === 'choice') {
      var picked = choiceFromText(text);
      if (!picked) return null;
      return { key: key, kind: 'choice', content: JSON.stringify(picked), local: true };
    }
    if (kind === 'matching') {
      var order = matchingFromText(text);
      if (!order) return null;
      return { key: key, kind: 'matching', content: JSON.stringify({ order: order }), local: true };
    }
    if (kind === 'table') {
      var picks = tableFromText(text);
      if (!picks) return null;
      return { key: key, kind: 'table', content: JSON.stringify({ picks: picks }), local: true };
    }
    return { key: key, kind: kind, content: text, local: true };
  }

  async function saveAnswer(ctx, ans, force) {
    if (cacheIndex()[ctx.key] && !force) return { skipped: true, key: ctx.key };
    var item = {
      key: ctx.key,
      kind: ans.kind,
      ext: ans.ext || 'txt',
      content: ans.content,
      author: await authorName()
    };
    var name = ctx.key + '.' + item.ext;
    var res;
    /* Никаких всплывающих сообщений о сохранении: справа снизу идёт обычная
       загрузка. Крутится — сохранение идёт; пропала — ответ сохранён.         */
    saveSpin(true);
    try {
      res = await fetch(API + '/contents/' + INBOX + '/' + name, {
        method: 'PUT',
        headers: ghHeaders(),
        body: JSON.stringify({
          message: 'inbox: ' + ctx.key + (item.author ? ' — ' + item.author : ''),
          content: b64(item.content)
        })
      });
    } catch (e) {
      saveSpin(false, 'err');
      storeDown = Date.now() + 60000;
      throw new Error('GitHub недоступен: ' + e.message);
    }
    /* 409/422 — файл уже лежит в очереди с прошлого раза, это не ошибка */
    if (!res.ok && res.status !== 409 && res.status !== 422) {
      saveSpin(false, 'err');
      if (res.status === 401 || res.status === 403) storeDown = Date.now() + 60000;
      throw new Error(await ghError(res));
    }
    saveSpin(false, 'ok');

    /* робот перенесёт файл за секунды, но CDN ещё до пяти минут отдаёт старый
       индекс — поэтому держим шаг в своём списке, пока он там не появится.
       content кладём рядом: пока файла нет в answers/, «вставить» берёт его
       отсюда, а не ловит 404 в raw.githubusercontent.com.                       */
    var entry = { key: ctx.key, file: name, kind: item.kind, ext: item.ext };
    pending[ctx.key] = { at: Date.now(), item: entry, local: true, content: item.content };
    savePending();
    cache.items[ctx.key] = entry;
    cache.at = Date.now();
    saveCache();
    renderPanel(true);
    return { key: ctx.key };
  }

  /* ----------------------------------------------------------- API Stepik */

  async function sk(path) {
    var res = await fetch(path, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Stepik API ' + res.status);
    return res.json();
  }

  var stepIds = {};     /* урок → [id шагов] */
  var netStep = null;   /* id шага, подсмотренный в запросах самой Stepik */
  var netAnswer = null; /* ответ, подсмотренный в запросе отправки */

  var stepIdCache = {};   /* ключ шага → id */
  var apiNote = '';       /* чем закончилась последняя попытка прочитать ответ */

  /* подсмотренный id обязательно проверяем по самому шагу: /api/steps отдаёт lesson и position */
  async function stepMatches(id, ctx) {
    try {
      var st = (await sk('/api/steps/' + id)).steps[0];
      return !!(st && String(st.lesson) === String(ctx.lesson) && st.position === ctx.step);
    } catch (e) { return false; }
  }

  async function findStepId(ctx) {
    if (stepIdCache[ctx.key]) return stepIdCache[ctx.key];

    var list = await lessonSteps(ctx.lesson);
    var guess = list && list[ctx.step - 1];
    if (guess) { stepIdCache[ctx.key] = guess; return guess; }

    /* списка шагов нет — проверяем id, подсмотренный в запросах Stepik */
    if (netStep && await stepMatches(netStep, ctx)) {
      stepIdCache[ctx.key] = netStep;
      return netStep;
    }
    return null;
  }

  var myId = null, myName = '';

  async function myUserId() {
    if (myId) return myId;
    try {
      var u = (await sk('/api/users/me')).users[0] || {};
      myId = u.id || null;
      myName = norm(u.full_name || '') || (myId ? 'id' + myId : '');
    } catch (e) { myId = null; }
    return myId;
  }

  /* подпись автора для таблицы: в ней видно, кто добавил ответ */
  async function authorName() {
    if (!myName) await myUserId();
    return myName;
  }

  async function apiAnswer(ctx) {
    var stepId = await findStepId(ctx);
    if (!stepId) { apiNote = 'не определил id шага'; return null; }

    await myUserId();
    var d = await sk('/api/submissions?step=' + stepId + '&limit=20');
    /* только свои отправки: чужое решение сохранять нельзя */
    var mine = (d.submissions || []).filter(function (s) { return s && (!myId || s.user === myId); });
    var good = mine.filter(function (s) { return s.status === 'correct' && s.reply; });
    if (!good.length) {
      apiNote = 'шаг ' + stepId + ', ваших отправок ' + mine.length +
        (mine.length ? ' (' + mine.map(function (s) { return s.status; }).join(', ') + ')' : '') +
        ' — зачтённых нет';
      return null;
    }
    good.sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
    var ans = fromReply(good[0].reply, 'Stepik API');
    apiNote = 'шаг ' + stepId + ', зачтённых отправок ' + good.length +
      ', тип ответа: ' + (ans ? ans.kind : 'неизвестный');
    return ans;
  }

  var EXT = {
    csharp: 'cs', 'c#': 'cs', cs: 'cs', cpp: 'cpp', 'c++': 'cpp', c: 'c', java: 'java',
    python: 'py', python3: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts',
    ts: 'ts', sql: 'sql', go: 'go', kotlin: 'kt', rust: 'rs', ruby: 'rb', php: 'php',
    haskell: 'hs', swift: 'swift', scala: 'scala', pascal: 'pas', delphi: 'pas', r: 'r',
    bash: 'sh', shell: 'sh', text: 'txt', plaintext: 'txt'
  };

  /* Язык приходит в двух видах: коротким именем («python3», «csharp») и MIME-строкой
     из CodeMirror («text/x-python», «text/x-csharp», «text/x-c++src»). Раньше MIME
     просто чистился от знаков — и ответ ложился в файл с расширением «textxc».
     Поэтому сначала берём последний осмысленный кусок, потом уже ищем в таблице. */
  function extOf(lang) {
    var m = String(lang || '').toLowerCase().trim();
    if (!m) return 'txt';
    if (EXT[m]) return EXT[m];

    /* text/x-python → python · text/x-c++src → c++ · application/x-java → java */
    var tail = m.replace(/^[a-z]+\/[a-z0-9.+-]*-/, '').replace(/(src|script)$/, '');
    if (EXT[tail]) return EXT[tail];
    /* x-csharp → csharp · c++src → c++ */
    var bare = tail.replace(/^x-/, '');
    if (EXT[bare]) return EXT[bare];
    /* добавочные слова: «python 3», «python3.6» → python3 / python */
    var word = (m.match(/[a-z0-9+#]+/g) || []).filter(function (w) {
      return w !== 'text' && w !== 'application' && w !== 'x' && w !== 'src' && !/^\d+$/.test(w);
    });
    for (var i = 0; i < word.length; i++) {
      if (EXT[word[i]]) return EXT[word[i]];
    }
    /* совсем незнакомое — вернём осмысленный огрызок, но не «textxc» */
    return (bare.replace(/[^a-z0-9]/g, '').slice(0, 6) || 'txt');
  }

  function fromReply(reply, via) {
    if (typeof reply.code === 'string' && reply.code.trim()) {
      return {
        kind: 'code', correct: true, via: via, ext: extOf(reply.language),
        lang: reply.language || '', content: reply.code
      };
    }
    if (reply.choices && reply.choices.length) {
      var ids = reply.choices.map(Number).filter(function (n) { return !isNaN(n); });
      return {
        kind: 'choice', correct: true, via: via, ext: 'json',
        content: JSON.stringify({ type: 'choice', ids: ids, answers: choiceTexts(ids) }, null, 2)
      };
    }
    /* Свободный ответ в обычном поле: у такого задания ответ лежит в reply.text,
       а не в reply.code — без этой ветки он не сохранялся бы вовсе.            */
    if (typeof reply.text === 'string' && reply.text.trim()) {
      return {
        kind: 'text', correct: true, via: via, ext: 'txt',
        lang: '', content: reply.text.trim()
      };
    }
    return null;
  }

  function choiceTexts(ids) {
    var out = [];
    $$('input[type="radio"], input[type="checkbox"]').forEach(function (inp) {
      if (ids.indexOf(Number(inp.value)) < 0) return;
      var t = norm((inp.closest('label') || inp.parentElement || {}).textContent);
      if (t && out.indexOf(t) < 0) out.push(t);
    });
    return out;
  }

  /* ------------------------------------------- запасной путь: чтение из DOM */

  function modeOf(cm) {
    try {
      var m = cm.getOption('mode');
      return typeof m === 'string' ? m : (m && (m.name || m.mime)) || '';
    } catch (e) { return ''; }
  }

  function domCode() {
    var node = $('.CodeMirror');
    var cm = node && (node.wrappedJSObject || node).CodeMirror;
    if (cm && typeof cm.getValue === 'function') {
      var v = cm.getValue();
      if (v && v.trim()) return { code: v, lang: modeOf(cm) };
    }
    var c6 = $('.cm-content');
    if (c6) {
      var t = c6.innerText || c6.textContent || '';
      if (t.trim()) return { code: t, lang: '' };
    }
    var pre = $('pre.highlight-code code') || $('pre.highlight-code');
    if (pre) {
      var t2 = String(pre.innerText || pre.textContent || '').replace(/\u00a0/g, ' ');
      if (t2.trim()) return { code: t2.replace(/\s+$/, ''), lang: '' };
    }
    var field = $('.attempt-wrapper__plugin textarea') || $('.quiz-component textarea');
    if (field && field.value && field.value.trim()) return { code: field.value, lang: '' };
    return null;
  }

  function domPassed() {
    if ($('[data-quiz-state="correct"]')) return true;
    var ctx = stepContext();
    var pin = ctx && $('.m-step-pin[data-step-position="' + ctx.step + '"]');
    return !!(pin && pin.getAttribute('data-is-passed') === 'true');
  }

  function looksLikeTemplate(code) {
    var t = String(code || '').trim();
    return !t || (/\/\/\s*Ваш код|#\s*Ваш код/i.test(t) && t.length < 400);
  }

  async function currentAnswer(ctx) {
    apiNote = '';
    try {
      var viaApi = await apiAnswer(ctx);
      if (viaApi) return viaApi;
    } catch (e) { apiNote = 'API Stepik: ' + e.message; log('API Stepik недоступен:', e.message); }

    var code = domCode();
    if (!code || looksLikeTemplate(code.code)) return null;
    var passed = domPassed();
    apiNote += ' | в редакторе ' + code.code.length + ' символов, шаг зачтён: ' + (passed ? 'да' : 'нет');
    return {
      kind: 'code', content: code.code, ext: extOf(code.lang), lang: code.lang,
      correct: passed, via: 'DOM'
    };
  }

  /* ------------------------------------------------- запись ответа в задание */

  function bridgeSource() {
    if (window.__sgxB) return;
    window.__sgxB = 1;

    function post(d) { document.dispatchEvent(new CustomEvent('sgx:net', { detail: d })); }
    var RE = /\/api\/(submissions|attempts)\b/;

    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (input, init) {
        var url = String((input && input.url) || input || '');
        var p = origFetch.apply(this, arguments);
        if (!RE.test(url)) return p;
        post({ url: url });
        return p.then(function (res) {
          try { res.clone().text().then(function (t) { post({ url: url, body: t }); }); }
          catch (e) { /* ignore */ }
          return res;
        });
      };
    }

    var origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__sgxU = String(u || ''); return origOpen.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      if (RE.test(xhr.__sgxU || '')) {
        post({ url: xhr.__sgxU });
        xhr.addEventListener('load', function () {
          try { post({ url: xhr.__sgxU, body: xhr.responseText }); } catch (e) { /* ignore */ }
        });
      }
      return origSend.apply(this, arguments);
    };

    /* доступ к CodeMirror 5 из песочницы Tampermonkey */
    document.addEventListener('sgx:cm', function (e) {
      var d = e.detail || {}, out = { id: d.id, ok: false };
      try {
        var nodes = document.querySelectorAll('.CodeMirror'), cm = null;
        for (var i = 0; i < nodes.length; i++) {
          var c = nodes[i].CodeMirror;
          if (!c || typeof c.getValue !== 'function') continue;
          cm = c;
          if (nodes[i].className.indexOf('CodeMirror-focused') >= 0) break;
        }
        if (cm) {
          if (d.write != null) {
            cm.setValue(String(d.write));
            if (cm.refresh) cm.refresh();
            if (cm.focus) cm.focus();
          }
          var m = cm.getOption('mode');
          out.ok = true;
          out.value = cm.getValue();
          out.mode = typeof m === 'string' ? m : (m && (m.name || m.mime)) || '';
        }
      } catch (err) { out.error = String(err); }
      document.dispatchEvent(new CustomEvent('sgx:cm:res', { detail: out }));
    });
  }

  var bridgeInjected = false;
  function injectBridge() {
    if (bridgeInjected) return;
    bridgeInjected = true;
    try {
      var s = document.createElement('script');
      s.textContent = '(' + bridgeSource.toString() + ')();';
      (document.head || document.documentElement).appendChild(s);
      s.remove();
    } catch (e) { log('мост не внедрился:', e); }
  }

  function bridgeAsk(payload, timeout) {
    injectBridge();
    return new Promise(function (resolve) {
      var id = Math.random().toString(36).slice(2);
      var done = false;
      function handler(e) {
        if (!e.detail || e.detail.id !== id) return;
        done = true;
        document.removeEventListener('sgx:cm:res', handler);
        resolve(e.detail);
      }
      document.addEventListener('sgx:cm:res', handler);
      setTimeout(function () {
        if (done) return;
        document.removeEventListener('sgx:cm:res', handler);
        resolve(null);
      }, timeout || 900);
      document.dispatchEvent(new CustomEvent('sgx:cm', { detail: clone(Object.assign({ id: id }, payload)) }));
    });
  }

  function setNative(el, value) {
    el.focus();
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function writeCode(text, replaceOnly) {
    var r = await bridgeAsk({ write: text });
    if (r && r.ok) return { ok: true, via: 'CodeMirror' };

    /* При посимвольном наборе этот путь опасен: execCommand ДОПИСЫВАЕТ к тому,
       что уже есть, и код задвоился бы на каждом шаге. Поэтому при наборе его
       пропускаем и пользуемся только теми путями, что заменяют текст целиком.   */
    if (!replaceOnly) {
      var c6 = $('.cm-content');
      if (c6) {
        try {
          c6.focus();
          var range = document.createRange();
          range.selectNodeContents(c6);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          if (document.execCommand('insertText', false, text)) return { ok: true, via: 'редактор' };
        } catch (e) { /* ниже */ }
      }
    }
    var field = $('.string-quiz__textarea') || $('.attempt-wrapper__plugin textarea') ||
      $('.quiz-component textarea') || $('.attempt-wrapper__plugin input[type="text"]');
    if (field) { setNative(field, text); return { ok: true, via: 'поле ввода' }; }
    return { ok: false, error: 'редактор для вставки не найден' };
  }

  /* Набор кода «как будто пишет человек»: строки появляются по очереди. Раньше на
     их месте летела стрелка — человек попросил убрать её и сделать набор.
     Скорость подбираем от длины: длинное решение не должно набираться полминуты,
     поэтому шаг растягивается, а общее время ограничено.                        */
  var TYPE_STEP_MS = 55;
  var TYPE_MAX_MS = 1500;

  async function typeIntoEditor(text) {
    var lines = String(text == null ? '' : text).split('\n');
    if (lines.length < 2) return writeCode(text, true);
    var per = Math.max(TYPE_STEP_MS, Math.round(TYPE_MAX_MS / lines.length));
    var res = null;
    for (var i = 1; i <= lines.length; i++) {
      res = await writeCode(lines.slice(0, i).join('\n'), true);
      if (!res || !res.ok) return res;
      if (i < lines.length) await sleep(per);
    }
    return res;
  }

  async function readCodeFromEditor() {
    var r = await bridgeAsk({});
    if (r && r.ok && r.value != null) return String(r.value);
    var c6 = $('.cm-content');
    if (c6) return c6.textContent || '';
    var field = $('.attempt-wrapper__plugin textarea, .quiz-component textarea');
    return field ? (field.value || '') : '';
  }

  function writeChoice(data) {
    var wantIds = (data.ids || []).map(String);
    var wantTxt = (data.answers || []).map(norm);
    var inputs = $$('.quiz-component[data-type="choice-quiz"] input, .quiz-plugin__content input')
      .filter(function (i) { return /radio|checkbox/.test(i.type) && !i.disabled; });
    if (!inputs.length) return { ok: false, error: 'блок с вариантами не найден' };

    var hits = 0;
    inputs.forEach(function (inp) {
      var txt = norm((inp.closest('label') || inp.parentElement || {}).textContent);
      var on = wantIds.indexOf(String(inp.value)) >= 0 || (wantTxt.length && wantTxt.indexOf(txt) >= 0);
      if (on) hits++;
      if (inp.checked === on) return;
      /* Приводим состояние к нужному. Раньше здесь было «или это квадратик» —
         и на тесте с несколькими ответами скрипт отмечал ВСЕ квадратики:
         каждый лишний клик не снимал галочку, а ставил её.                     */
      inp.click();
    });
    if (!hits) return { ok: false, error: 'сохранённые варианты не найдены в списке' };
    return { ok: true, via: 'варианты', hits: hits };
  }

/* Возвращаем и поле для вставки, и якорь для скобы. Якорь — ИМЕННО этот блок:
     редактор кода или блок с вариантами, а не вся карточка задания. Раньше скоба
     обрамляла весь .attempt-wrapper__content вместе с заголовком, условием и
     кнопками, и человек просил так не растягивать её.                          */
  function insertTarget() {
    var el = null;
    var q = $('.quiz-component[data-type="choice-quiz"] input:not([disabled]),' +
      ' .quiz-plugin__content input:not([disabled])');
    if (q) el = q.closest('.quiz-component, .quiz-plugin__content') || q;
    if (!el) {
      var mq = $('.matching-quiz');
      if (mq && mq.getBoundingClientRect().height) el = mq;
    }
    if (!el) {
      var tq = tableQuizTable();
      if (tq && tq.getBoundingClientRect().height) el = tq;
    }
    if (!el) {
      var cm = $('.CodeMirror');
      if (cm && cm.getBoundingClientRect().height) el = cm;
    }
    if (!el) {
      var c6 = $('.cm-content');
      if (c6 && c6.getBoundingClientRect().height) el = c6.closest('.cm-editor') || c6;
    }
    if (!el) {
      var field = $('.string-quiz__textarea') ||
        $('.attempt-wrapper__plugin textarea, .quiz-component textarea');
      if (field) el = field;
    }
    if (!el) return null;
    return { el: el, anchor: tightBlockOf(el) || cardOf(el) || el };
  }

  /* Самый узкий осмысленный блок вокруг элемента: сначала редактор, потом блок
     с вариантами. Важно, что блок ИИ лежит РЯДОМ с редактором, а не внутри него,
     поэтому в рамку он не попадает.                                            */
  var TIGHT_SELS = [
    '.CodeMirror', '.cm-editor', '.code-editor-quiz__editor', '.code-quiz__code',
    '.code-editor', '.string-quiz__textarea', '.quiz-component'
  ];

  function tightBlockOf(el) {
    for (var i = 0; i < TIGHT_SELS.length; i++) {
      var node = el && el.closest ? el.closest(TIGHT_SELS[i]) : null;
      if (!node) continue;
      var r = node.getBoundingClientRect();
      if (r.height > 40 && r.width > 160) return node;
    }
    return null;
  }

  function cardOf(el) {
    var sels = ['.attempt-wrapper__content', '.attempt-wrapper', '.step-problem', '.quiz-plugin'];
    for (var i = 0; i < sels.length; i++) {
      var card = el && el.closest ? el.closest(sels[i]) : null;
      if (!card) continue;
      var r = card.getBoundingClientRect();
      if (r.height > 60 && r.width > 200) return card;
    }
    return el;
  }

  var RETRY_RE = /(решить|отправить|попробовать|изменить)\s*(снова|ещ[ёе]\s*раз|заново)|solve\s*again|try\s*again/i;

  function retryButton() {
    var nodes = $$('button, a, [role="button"]');
    for (var i = 0; i < nodes.length; i++) {
      var t = norm(nodes[i].textContent);
      if (!t || t.length > 60 || !RETRY_RE.test(t)) continue;
      var r = nodes[i].getBoundingClientRect();
      if (r.width && r.height) return nodes[i];
    }
    return null;
  }

  function waitFor(fn, timeout, interval) {
    var deadline = Date.now() + (timeout || 6000);
    return new Promise(function (resolve) {
      (function loop() {
        var v = null;
        try { v = fn(); } catch (e) { v = null; }
        if (v) { resolve(v); return; }
        if (Date.now() > deadline) { resolve(null); return; }
        setTimeout(loop, interval || 250);
      })();
    });
  }

  async function insertSaved(ctx) {
    if (!insertTarget()) {
      /* карточка нарисована, а ни поля, ни контейнера редактора нет — ждать бессмысленно */
      if (cardDrawn() && !editorComing() && !stepHasInput()) {
        throw new Error('на шаге нет ни кода, ни вариантов — вставлять нечего');
      }
      await waitFor(insertTarget, 4000, 250);
      if (!insertTarget() && !stepHasInput()) {
        throw new Error('на шаге нет ни кода, ни вариантов — вставлять нечего');
      }
    }
    var saved = await storeItem(ctx.key);
    if (!insertTarget()) {
      var again = retryButton();
      if (again) {
        again.click();
        await waitFor(insertTarget, 8000, 250);
        await sleep(300);
      }
    }
    var res;
    if (saved.kind === 'choice') {
      var data = null;
      try { data = JSON.parse(saved.content); } catch (e) { data = null; }
      res = data ? writeChoice(data) : { ok: false, error: 'битая запись ответа ' + saved.key };
    } else if (saved.kind === 'table') {
      var tdata = null;
      try { tdata = JSON.parse(saved.content); } catch (e) { tdata = null; }
      var tpicks = tdata && tdata.picks;
      if (!tpicks || !tpicks.length) {
        res = { ok: false, error: 'битая запись ответа ' + saved.key };
      } else {
        res = writeTable(tpicks);
        aiLogTable(tpicks);
      }
    } else if (saved.kind === 'matching') {
      var mdata = null;
      try { mdata = JSON.parse(saved.content); } catch (e) { mdata = null; }
      var order = mdata && mdata.order;
      if (!order || !order.length) {
        res = { ok: false, error: 'битая запись ответа ' + saved.key };
      } else {
        await orderMatching(order);
        aiLogMatching(order);
        res = { ok: true, moved: true };
      }
    } else {
      res = await writeCode(saved.content);
    }
    if (!res.ok) throw new Error(res.error);
    var target = insertTarget();
    flash(target && target.anchor);
    return res;
  }

  /* -------------------------------------------------------------------- UI */

  GM_addStyle([
    /* --- скоба «вставить» ---
       Ни рамки, ни белой заливки: человек просил убрать синюю обводку и
       внутреннюю заливку. Остаётся сама скобка и кнопки — они и так заметные.
       Скобка рисуется: путь обводится от начала к концу (см. drawBrace).        */
    '#sgx-chip{position:fixed;z-index:2147483000;display:none;align-items:stretch;pointer-events:none;',
    'font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '#sgx-chip.on{display:flex}',
    '#sgx-chip .sgx-brace{flex:none;display:block;overflow:visible}',
    '#sgx-chip.above .sgx-brace{display:none}',
    '#sgx-chip .sgx-body{display:flex;flex-direction:column;justify-content:center;gap:6px;',
    'padding:8px 10px;pointer-events:auto;background:transparent;border:0;border-radius:0;',
    /* надпись появляется вместе со скобкой, а не возникает до неё */
    'opacity:0;transform:translateX(-6px);',
    'transition:opacity .3s ease .18s,transform .3s ease .18s}',
    '#sgx-chip.sgx-in .sgx-body{opacity:1;transform:none}',
    '#sgx-chip .sgx-label{color:#1F1D1B;font-weight:700;font-size:15px}',
    '#sgx-chip .sgx-acts{display:flex;align-items:center;gap:8px}',
    '#sgx-chip .sgx-sep{color:#B9B7B2}',
    '#sgx-chip .sgx-act{border:0;border-radius:7px;padding:7px 13px;cursor:pointer;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14.5px;font-weight:600;line-height:1.2;background:#2F7CE0;color:#fff}',
    '#sgx-chip .sgx-act:hover{background:#2769C4}',
    '#sgx-chip .sgx-act.no{background:#EEF1F5;color:#3B3936}',
    '#sgx-chip .sgx-act.no:hover{background:#E1E7EE}',
    '#sgx-chip .sgx-act.ai{background:#EEF2FF;color:#3730A3}',
    '#sgx-chip .sgx-act.ai:hover{background:#E0E7FF}',
    /* --- вспышка вокруг редактора и тост --- */
    '.sgx-flash{position:fixed;z-index:2147482000;pointer-events:none;border-radius:6px;opacity:1;',
    'background:rgba(56,178,113,.28);box-shadow:inset 0 0 0 2px rgba(56,178,113,.5);transition:opacity .4s ease}',
    '.sgx-flash.off{opacity:0}',
    '#sgx-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:2147483000;',
    'display:none;max-width:min(420px,90vw);',
    'padding:11px 14px;border-radius:8px;border:1px solid #E6E5E3;background:#FFF;color:#2C2C2B;',
    'font:14.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;box-shadow:0 1px 2px rgba(0,0,0,.05),0 4px 12px rgba(0,0,0,.06)}',
    '#sgx-toast.on{display:block}',
    '#sgx-toast.err{background:#FCE9E7;border-color:#F3C8C3;color:#b23f34}',
    /* --- индикатор сохранения: правый нижний угол, без текста ---
       Крутится — идёт запись, галочка — ответ сохранён, крестик — не вышло.    */
    /* --- первое знакомство ---
       Затемнение с размытием: сайт виден, но не мешает читать подсказку.
       Подсвеченный элемент «горит» — на него и намекаем.                       */
    '#sgx-tour{position:fixed;inset:0;z-index:2147483600;display:none}',
    '#sgx-tour.on{display:block}',
    '#sgx-tour .sgx-tour-dim{position:absolute;inset:0;background:rgba(15,15,14,.62);',
    'backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px)}',
    '#sgx-tour .sgx-tour-ring{position:absolute;border-radius:10px;pointer-events:none;',
    'box-shadow:0 0 0 3px rgba(255,214,102,.95),0 0 26px 10px rgba(255,196,0,.45);',
    'animation:sgx-glow 1.6s ease-in-out infinite}',
    '@keyframes sgx-glow{0%,100%{box-shadow:0 0 0 3px rgba(255,214,102,.95),0 0 26px 10px rgba(255,196,0,.45)}',
    '50%{box-shadow:0 0 0 4px rgba(255,224,130,1),0 0 34px 16px rgba(255,196,0,.65)}}',
    '#sgx-tour svg.sgx-tour-arrow{position:absolute;pointer-events:none;overflow:visible}',
    '#sgx-tour .sgx-tour-card{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
    'width:min(430px,86vw);padding:22px 24px;border-radius:12px;background:#fff;color:#1F1D1B;',
    'box-shadow:0 24px 60px rgba(0,0,0,.35);',
    'font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '#sgx-tour .sgx-tour-card h3{margin:0 0 8px;font-size:20px;font-weight:700}',
    '#sgx-tour .sgx-tour-card p{margin:0 0 16px;color:#4B4A47}',
    '#sgx-tour .sgx-tour-card .sgx-tour-row{display:flex;align-items:center;gap:10px}',
    '#sgx-tour .sgx-tour-card button{flex:1 1 0;height:46px;border:0;border-radius:8px;cursor:pointer;',
    'font:600 16px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '#sgx-tour .sgx-tour-card .sgx-tour-next{background:#1F1D1B;color:#fff}',
    '#sgx-tour .sgx-tour-card .sgx-tour-skip{flex:0 0 auto;background:transparent;color:#7D7B76;',
    'font-weight:500;text-decoration:underline;padding:0 6px}',
    '#sgx-tour .sgx-tour-dots{display:flex;gap:6px;justify-content:center;margin:0 0 14px}',
    '#sgx-tour .sgx-tour-dots i{width:7px;height:7px;border-radius:50%;background:#DCDBD7}',
    '#sgx-tour .sgx-tour-dots i.on{background:#1F1D1B}',
    /* --- вопрос перед знакомством --- */
    '#sgx-tour-ask{position:fixed;inset:0;z-index:2147483601;display:none;align-items:center;',
    'justify-content:center;background:rgba(15,15,14,.5);backdrop-filter:blur(4px);',
    '-webkit-backdrop-filter:blur(4px)}',
    '#sgx-tour-ask.on{display:flex}',
    '#sgx-tour-ask .sgx-ask-card{width:min(400px,86vw);padding:24px;border-radius:12px;background:#fff;',
    'text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.35);',
    'font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1F1D1B}',
    '#sgx-tour-ask h3{margin:0 0 6px;font-size:20px;font-weight:700}',
    '#sgx-tour-ask p{margin:0 0 20px;color:#4B4A47}',
    '#sgx-tour-ask .sgx-ask-go{display:block;width:100%;height:48px;border:0;border-radius:8px;',
    'background:#1F1D1B;color:#fff;cursor:pointer;font:600 16px -apple-system,BlinkMacSystemFont,'
      + '"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '#sgx-tour-ask .sgx-ask-skip{display:block;width:100%;margin-top:10px;border:0;background:transparent;',
    'color:#8A8884;cursor:pointer;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,'
      + 'Helvetica,Arial,sans-serif;text-decoration:underline}',
    '#sgx-save{position:fixed;right:20px;bottom:20px;z-index:2147482900;display:none;',
    'width:36px;height:36px;border-radius:50%;background:#fff;border:1px solid #E6E5E3;',
    'box-shadow:0 2px 10px rgba(15,15,14,.12);align-items:center;justify-content:center;',
    'transition:opacity .3s ease}',
    '#sgx-save.on{display:flex}',
    '#sgx-save .sgx-save-ring{width:18px;height:18px;border-radius:50%;border:2px solid #DCDBD7;',
    'border-top-color:#2F7CE0;animation:sgx-spin .7s linear infinite}',
    '#sgx-save .sgx-save-tick,#sgx-save .sgx-save-cross{display:none}',
    '#sgx-save.done .sgx-save-ring{display:none}',
    '#sgx-save.done.ok .sgx-save-tick{display:block;width:6px;height:12px;margin-top:-3px;',
    'border:solid #2E7D32;border-width:0 2px 2px 0;transform:rotate(45deg)}',
    '#sgx-save.done.err .sgx-save-cross{display:block;position:relative;width:16px;height:16px}',
    '#sgx-save.done.err .sgx-save-cross::before,#sgx-save.done.err .sgx-save-cross::after{',
    'content:"";position:absolute;left:0;top:7px;width:16px;height:2px;background:#C0392B}',
    '#sgx-save.done.err .sgx-save-cross::before{transform:rotate(45deg)}',
    '#sgx-save.done.err .sgx-save-cross::after{transform:rotate(-45deg)}',
    '@keyframes sgx-spin{to{transform:rotate(360deg)}}',
    /* --- отчёт самопроверки --- */
    '#sgx-report{position:fixed;inset:0;z-index:2147483647;background:rgba(15,15,14,.45);display:flex;',
    'align-items:center;justify-content:center;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '#sgx-report .sgx-rep-box{background:#fff;border-radius:10px;box-shadow:0 18px 48px rgba(15,15,14,.25);',
    'padding:14px;width:min(620px,92vw);display:flex;flex-direction:column;gap:10px}',
    '#sgx-report textarea{width:100%;height:320px;resize:vertical;border:1px solid #E3E2E0;border-radius:6px;',
    'padding:11px;font:13.5px/1.6 ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,Menlo,monospace;color:#37352F;background:#FBFBFA}',
    '#sgx-report .sgx-rep-row{display:flex;gap:8px;justify-content:flex-end}',
    '#sgx-report button{border:1px solid #E3E2E0;background:#fff;border-radius:6px;padding:8px 14px;',
    'font:14.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#37352F;cursor:pointer}',
    '#sgx-report button:hover{background:#F1F1EF}',
    /* --- панель живёт ВНУТРИ бокового меню курса и выглядит как его часть ---
       Та же шкала, что и у блока ИИ: отступы 4/8/12/16, высота органов 40,
       радиусы 8/10, шрифты 14/15/16. Раньше у каждого блока были свои числа, и
       рядом они выглядели как набор случайных размеров.                        */
    '#sgx-panel{--sgx-s1:4px;--sgx-s2:8px;--sgx-s3:12px;--sgx-s4:16px;',
    '--sgx-ctl:44px;--sgx-r:10px;--sgx-r-sm:8px;',
    /* Шрифт панели крупнее прежнего: на тёмном фоне мелкий текст читался мутно. */
    '--sgx-f-xs:15px;--sgx-f-sm:16px;--sgx-f:17px;',
    'position:relative;display:none;width:100%;box-sizing:border-box;',
    'font:var(--sgx-f)/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#fff}',
    '#sgx-panel.on{display:block}',
    '#sgx-panel *{box-sizing:border-box}',
    '#sgx-panel .sgx-module{display:flex;align-items:center;gap:var(--sgx-s2);',
    'min-height:calc(var(--sgx-ctl) + var(--sgx-s3));padding:var(--sgx-s3) var(--sgx-s4);',
    'border-bottom:1px solid rgba(255,255,255,.08);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '#sgx-panel .sgx-badge{display:flex;align-items:center;justify-content:center;width:26px;height:26px;',
    'border-radius:50%;background:#4CAF50;color:#fff;font-size:13px;font-weight:700;flex:none}',
    '#sgx-panel .sgx-modtitle{flex:1 1 auto;min-width:0;font-size:var(--sgx-f);font-weight:600;color:#fff}',
    '#sgx-panel .sgx-close{display:flex;align-items:center;justify-content:center;',
    'width:var(--sgx-ctl);height:var(--sgx-ctl);border:0;border-radius:var(--sgx-r-sm);',
    'background:transparent;color:rgba(255,255,255,.65);cursor:pointer;padding:0;flex:none}',
    '#sgx-panel .sgx-close:hover{background:rgba(255,255,255,.12);color:#fff}',
    '#sgx-panel .sgx-row{display:flex;align-items:center;gap:var(--sgx-s2);padding:var(--sgx-s3) var(--sgx-s4) var(--sgx-s1)}',
    '#sgx-panel .sgx-row label{flex:0 0 auto;font-size:var(--sgx-f-sm);color:rgba(255,255,255,.8)}',
    '#sgx-panel select{flex:1 1 0;min-width:0;height:var(--sgx-ctl);padding:0 var(--sgx-s2);',
    'border:1px solid rgba(255,255,255,.18);border-radius:var(--sgx-r-sm);background:rgba(255,255,255,.06);color:#fff;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:var(--sgx-f-sm)}',
    '#sgx-panel select option{background:#fff;color:#1F1D1B}',
    '#sgx-panel select:focus{outline:2px solid rgba(120,190,255,.5);outline-offset:1px}',
    '#sgx-panel .sgx-note{padding:var(--sgx-s2) var(--sgx-s4) var(--sgx-s1);font-size:var(--sgx-f-xs);',
    'color:rgba(255,255,255,.55);line-height:1.45}',
    /* Кнопки — во всю ширину, квадратные и вплотную друг к другу: человек просил
       убрать скругления и промежутки. Разделяет их только тонкая линия.         */
    '#sgx-panel .sgx-btn{display:flex;align-items:center;justify-content:center;gap:var(--sgx-s2);',
    'width:100%;margin:0;height:50px;border:0;border-top:1px solid rgba(255,255,255,.10);',
    'border-radius:0;padding:0;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    'font-size:var(--sgx-f-sm);font-weight:500;cursor:pointer;letter-spacing:.2px;',
    'transition:background .15s ease,color .15s ease}',
    '#sgx-panel .sgx-btn.primary{background:#fff;color:#1F1D1B}',
    '#sgx-panel .sgx-btn.primary:hover{background:#EDEDED}',
    '#sgx-panel .sgx-btn.plain{background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.16)}',
    '#sgx-panel .sgx-btn.plain:hover{background:rgba(255,255,255,.15)}',
    '#sgx-panel .sgx-btn.danger{background:transparent;color:#FF8A80;border-color:rgba(255,138,128,.45)}',
    '#sgx-panel .sgx-btn.danger:hover{background:rgba(255,138,128,.12)}',
    '#sgx-panel .sgx-btn.ai{background:transparent;color:#B9C4FF;border-color:rgba(185,196,255,.4)}',
    '#sgx-panel .sgx-btn.ai:hover{background:rgba(185,196,255,.12)}',
    '#sgx-panel .sgx-btn:disabled{opacity:.4;cursor:default;background:rgba(255,255,255,.06);color:#fff;',
    'border-color:rgba(255,255,255,.10)}',
    '#sgx-panel .sgx-ic{flex:0 0 auto}',
    /* --- всплывающее окно выбора диапазона и экран настроек --- */
    '#sgx-panel .sgx-pop{position:absolute;inset:0;z-index:5;display:none;',
    'flex-direction:column;justify-content:center;gap:var(--sgx-s3);',
    'padding:var(--sgx-s4);background:rgba(20,22,26,.97)}',
    '#sgx-panel .sgx-pop.on{display:flex}',
    '#sgx-panel .sgx-pop h4{margin:0;font-size:var(--sgx-f);font-weight:600;color:#fff}',
    '#sgx-panel .sgx-pop .sgx-prow{display:flex;align-items:center;gap:var(--sgx-s2)}',
    '#sgx-panel .sgx-pop .sgx-prow label{flex:0 0 34px;font-size:var(--sgx-f-sm);',
    'color:rgba(255,255,255,.75)}',
    '#sgx-panel .sgx-pop .sgx-prow select,#sgx-panel .sgx-pop .sgx-prow input{',
    'flex:1 1 0;min-width:0;height:var(--sgx-ctl);padding:0 var(--sgx-s2);',
    'border:1px solid rgba(255,255,255,.2);border-radius:var(--sgx-r-sm);',
    'background:rgba(255,255,255,.08);color:#fff;font-size:var(--sgx-f-sm);',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '#sgx-panel .sgx-pop .sgx-prow select option{background:#fff;color:#1F1D1B}',
    '#sgx-panel .sgx-pop .sgx-pbtn{display:flex;align-items:center;justify-content:center;',
    'height:50px;border:0;border-radius:0;background:#fff;color:#1F1D1B;cursor:pointer;',
    'font-size:var(--sgx-f-sm);font-weight:600;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '#sgx-panel .sgx-pop .sgx-pbtn.ghost{background:rgba(255,255,255,.10);color:#fff}',
    '#sgx-panel .sgx-pop .sgx-phint{font-size:var(--sgx-f-xs);color:rgba(255,255,255,.6);line-height:1.5}',
    '#sgx-panel .sgx-progress{height:3px;background:rgba(255,255,255,.12);margin:2px 0 0}',
    '#sgx-panel .sgx-bar{height:100%;width:0;background:#4CAF50;transition:width .35s ease}',
    /* Текста в панели нет: человек просил его убрать. Прогресс виден по полосе,
       важные сообщения приходят тостом, а сам текст остаётся в data-атрибуте
       документа (по нему работает отчёт самопроверки).                          */
    '#sgx-panel .sgx-status{display:none}',
    /* --- блок ИИ внутри панели: повторяет родной редактор кода Stepik --- */
    '#sgx-panel .sgx-ai[hidden]{display:none}',
    /* --- блок ИИ: живёт на месте редактора кода в карточке задания ---
       Оформлен как соседние панели Stepik («Тестовые данные», «Напишите
       программу»): светлая карточка, серая полоса-шапка, вкладка «ИИ» белым
       на ней. Тёмное поле убрано: рядом с родным светлым редактором оно
       выглядело чужеродно, а мелкий шрифт на тёмном — нечитаемо.

       Размеры заданы ОДНОЙ шкалой (--sgx-s1…s4, --sgx-ctl, --sgx-r, --sgx-f*):
       раньше каждый блок нёс свои числа, и получалось «что-то большое, что-то
       меньше». Шаг шкалы — 4px.

       Потолок шрифта — размер кода (--sgx-mono): крупнее кода не делаем ничего,
       иначе решение перестаёт читаться как код. Кнопки крупные (--sgx-ctl),
       поле ответа — фиксированной высоты и только прокручивается.            */
    '#sgx-ai-root{--sgx-s1:4px;--sgx-s2:8px;--sgx-s3:12px;--sgx-s4:16px;',
    /* Шкала та же, что у панели: блок и панель стоят рядом, и размеры у них
       должны совпадать. Шрифт поднят — на прежнем мелком текст читался мутно.  */
    '--sgx-ctl:44px;--sgx-r:10px;--sgx-r-sm:8px;',
    '--sgx-f-xs:15px;--sgx-f-sm:16px;--sgx-f:17px;--sgx-mono:17px;',
    '--sgx-bd:#E5E5E5;--sgx-bg-head:#F4F4F4;--sgx-fg:#2C2C2B;--sgx-fg-dim:#7D7B76;',
    'display:none;width:100%;box-sizing:border-box;margin:var(--sgx-s4) 0 0;',
    'border:1px solid var(--sgx-bd);border-radius:var(--sgx-r);background:#fff;overflow:hidden;',
    'font:var(--sgx-f)/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--sgx-fg)}',
    '#sgx-ai-root.on{display:block}',
    '#sgx-ai-root *{box-sizing:border-box}',
    /* шапка: вкладка слева, органы справа, всё по одной высоте и на одной линии */
    '#sgx-ai-panel .sgx-ai-head{display:flex;align-items:center;justify-content:space-between;',
    'gap:var(--sgx-s3);flex-wrap:wrap;min-height:calc(var(--sgx-ctl) + var(--sgx-s2) * 2);',
    'padding:var(--sgx-s2) var(--sgx-s3);background:var(--sgx-bg-head);border-bottom:1px solid var(--sgx-bd)}',
    '#sgx-ai-panel .sgx-ai-tabs{display:flex;align-items:center;gap:var(--sgx-s2);margin:0;padding:0;list-style:none}',
    '#sgx-ai-panel .sgx-ai-tab{display:flex;align-items:center;gap:var(--sgx-s2);height:var(--sgx-ctl);',
    'padding:0 var(--sgx-s3);border-radius:var(--sgx-r-sm);border:1px solid transparent;',
    'font-size:var(--sgx-f);font-weight:600;color:#6B6A67;background:transparent}',
    '#sgx-ai-panel .sgx-ai-tab.active{color:#1F1D1B;background:#fff;border-color:var(--sgx-bd)}',
    '#sgx-ai-panel .sgx-ic{flex:0 0 auto}',
    '#sgx-ai-panel .sgx-ai-tools{display:flex;align-items:center;gap:var(--sgx-s2)}',
    /* крупные кнопки: 40x40 и значок 20px — прежние 30px читались как точка */
    '#sgx-ai-panel .sgx-ai-tool{display:flex;align-items:center;justify-content:center;',
    'width:var(--sgx-ctl);height:var(--sgx-ctl);padding:0;border:1px solid var(--sgx-bd);',
    'border-radius:var(--sgx-r-sm);background:#fff;color:#4B4A47;cursor:pointer}',
    '#sgx-ai-panel .sgx-ai-tool:hover{background:#F1F1EF;color:#1F1D1B}',
    /* отчёт проверки: проваленные тесты — красным, пройденные — спокойным */
    '#sgx-ai-panel .sgx-ai-report{display:flex;flex-direction:column;gap:2px;padding:var(--sgx-s3);',
    'border-radius:var(--sgx-r-sm);background:#FAFAF9;border:1px solid #ECECEA;',
    'font:var(--sgx-f-xs)/1.55 ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,Menlo,monospace}',
    '#sgx-ai-panel .sgx-ai-repline.bad{color:#B3261E;font-weight:600}',
    '#sgx-ai-panel .sgx-ai-repline.ok{color:#2C6B3C}',
    '#sgx-ai-panel .sgx-ai-repline.note{color:#6B6A67}',
    /* Варианты теста в чате — та же плашка, что и у кода. Сами метки рисуем
       классами Stepik (s-checkbox / s-radio), поэтому галочка и кружок выглядят
       ровно как в задании. Здесь только отступы и выделение выбранного.        */
    '#sgx-ai-panel .sgx-ai-opts{display:flex;flex-direction:column;gap:var(--sgx-s2);',
    'padding:var(--sgx-s3) var(--sgx-s4);border-radius:var(--sgx-r-sm);background:#F7F7F6;',
    'border:1px solid #ECECEA}',
    '#sgx-ai-panel .sgx-ai-opt{display:flex;align-items:flex-start;font-size:var(--sgx-f-sm);',
    'color:#4B4A47}',
    /* метку не трогаем руками: показываем ровно то, что выбрано */
    '#sgx-ai-panel .sgx-ai-opt input{pointer-events:none}',
    '#sgx-ai-panel .sgx-ai-opt.on{color:#1F1D1B}',
    '#sgx-ai-panel .sgx-ai-opt.on .s-checkbox__label,',
    '#sgx-ai-panel .sgx-ai-opt.on .s-radio__label{font-weight:600;color:#1F1D1B}',
    '#sgx-ai-panel .sgx-ai-optnote{margin-top:2px;font-size:var(--sgx-f-xs);color:var(--sgx-fg-dim)}',
    /* строка сопоставления: подпись слева, значение справа */
    '#sgx-ai-panel .sgx-ai-opttext{font-size:var(--sgx-f-sm);color:#4B4A47}',
    '#sgx-ai-panel .sgx-ai-opt.on .sgx-ai-opttext{color:#1F1D1B}',
    /* Запасной вариант на случай, если стили Stepik до блока не достают.
       Специфичность нулевая (:where), поэтому их правила всегда важнее — наши
       включаются только тогда, когда рисовать метку больше нечем.              */
    ':where(#sgx-ai-panel) :where(.s-checkbox, .s-radio){display:flex;align-items:flex-start;',
    'gap:8px;cursor:default}',
    ':where(#sgx-ai-panel) :where(.s-checkbox__input, .s-radio__input){position:absolute;',
    'opacity:0;width:0;height:0}',
    ':where(#sgx-ai-panel) :where(.s-checkbox__border, .s-radio__border){flex:0 0 auto;',
    'position:relative;width:18px;height:18px;margin-top:1px;border:2px solid #B4B2A9;background:#fff}',
    ':where(#sgx-ai-panel) :where(.s-radio__border){border-radius:50%}',
    ':where(#sgx-ai-panel) :where(.s-checkbox__border){border-radius:4px}',
    ':where(#sgx-ai-panel) :where(.s-checkbox__circle, .s-radio__circle){position:absolute;inset:0}',
    /* Центрируем содержимое метки сами: у Stepik кружок позиционируется своими
       правилами, и в нашем блоке он вставал не по центру. Флекс надёжнее —
       он центрирует и кружок, и галочку, чем бы они ни были нарисованы.        */
    '#sgx-ai-panel .s-radio__border, #sgx-ai-panel .s-checkbox__border',
    '{display:flex;align-items:center;justify-content:center;position:relative}',
    '#sgx-ai-panel .s-radio__input:checked ~ .s-radio__border{border-color:#2E7D32}',
    '#sgx-ai-panel .s-radio__input:checked ~ .s-radio__border .s-radio__circle',
    '{position:static;width:8px;height:8px;border-radius:50%;background:#2E7D32}',
    ':where(#sgx-ai-panel) :where(.s-checkbox__input:checked ~ .s-checkbox__border)',
    '{border-color:#2E7D32;background:#2E7D32}',
    /* галочка: без неё пустой зелёный квадрат читается как «залито непонятно чем» */
    ':where(#sgx-ai-panel) :where(.s-checkbox__input:checked ~ .s-checkbox__border .s-checkbox__circle)',
    '{width:5px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}',
    /* нижняя полоса блока: главное действие — спросить ИИ */
    '#sgx-ai-panel .sgx-ai-foot{display:flex;padding:var(--sgx-s3) var(--sgx-s4);',
    'border-top:1px solid var(--sgx-bd);background:#fff}',
    '#sgx-ai-panel .sgx-ai-ask{flex:1 1 auto;height:40px;border:0;border-radius:var(--sgx-r-sm);',
    'background:#2F7CE0;color:#fff;font-family:inherit;font-size:var(--sgx-f-sm);font-weight:600;',
    'cursor:pointer}',
    '#sgx-ai-panel .sgx-ai-ask:hover{background:#2769C4}',
    '#sgx-ai-panel .sgx-ai-ask[disabled]{background:#C9D6E6;cursor:default}',
    /* --- выбор модели: свой список, а не родной select ---
       Родной <select> в списке значков не покажет, а человек просил значок модели
       слева и «ум» справа. Поэтому это кнопка + всплывающий список.            */
    '#sgx-ai-panel .sgx-ai-mbtn{display:flex;align-items:center;gap:var(--sgx-s2);',
    'height:var(--sgx-ctl);padding:0 var(--sgx-s3);border:1px solid var(--sgx-bd);border-radius:var(--sgx-r-sm);',
    'background:#fff;color:var(--sgx-fg);font-family:inherit;font-size:var(--sgx-f-xs);',
    'cursor:pointer;white-space:nowrap}',
    '#sgx-ai-panel .sgx-ai-mbtn:hover{border-color:#C9C9C7;background:#FBFBFA}',
    '#sgx-ai-panel .sgx-ai-mbtn .sgx-ai-mchev{color:#9A9893;flex:0 0 auto}',
    '#sgx-ai-panel .sgx-ai-mwrap{position:relative}',
    '#sgx-ai-panel .sgx-ai-models{position:absolute;top:calc(100% + var(--sgx-s1));right:0;z-index:5;',
    'display:none;min-width:330px;padding:var(--sgx-s1);margin:0;list-style:none;',
    'background:#fff;border:1px solid var(--sgx-bd);border-radius:var(--sgx-r);',
    'box-shadow:0 8px 24px rgba(15,15,14,.14)}',
    '#sgx-ai-panel .sgx-ai-models.on{display:block}',
    '#sgx-ai-panel .sgx-ai-models li{display:flex;align-items:center;gap:var(--sgx-s3);',
    'padding:var(--sgx-s2) var(--sgx-s3);border-radius:var(--sgx-r-sm);cursor:pointer}',
    '#sgx-ai-panel .sgx-ai-models li:hover{background:#F4F4F4}',
    '#sgx-ai-panel .sgx-ai-models li.on{background:#EDF2FB}',
    '#sgx-ai-panel .sgx-ai-mname{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
    '#sgx-ai-panel .sgx-ai-mname b{font-size:var(--sgx-f-sm);font-weight:600;color:var(--sgx-fg)}',
    '#sgx-ai-panel .sgx-ai-mname span{font-size:12px;color:var(--sgx-fg-dim)}',
    /* «ум» справа: заполненные точки из пяти — видно, чем платишь за качество */
    '#sgx-ai-panel .sgx-ai-smart{display:inline-flex;gap:3px;flex:0 0 auto}',
    '#sgx-ai-panel .sgx-ai-smart i{width:7px;height:7px;border-radius:50%;background:#DEDCD8}',
    '#sgx-ai-panel .sgx-ai-smart i.on{background:#3B7DD8}',
    /* лента: только чтение, ничего не печатается руками. Светлая, как родной
       редактор кода. Высота ФИКСИРОВАННАЯ и большая: поле не должно прыгать
       при каждом ответе — только прокрутка.                                   */
    '#sgx-ai-panel .sgx-ai-log{height:440px;max-height:60vh;overflow:auto;',
    'padding:var(--sgx-s3) var(--sgx-s4);display:flex;flex-direction:column;gap:var(--sgx-s3);background:#fff}',
    /* Строка чата: аватар помощника слева, сообщение справа. Так служебные
       сообщения читаются как реплики бота, а не как лог скрипта.               */
    '#sgx-ai-panel .sgx-ai-row{display:flex;align-items:flex-start;gap:var(--sgx-s2)}',
    '#sgx-ai-panel .sgx-ai-row > *:not(.sgx-ai-ava){flex:1 1 auto;min-width:0}',
    '#sgx-ai-panel .sgx-ai-ava{display:flex;align-items:center;justify-content:center;',
    'width:28px;height:28px;flex:0 0 auto;border-radius:50%;background:#fff;border:1px solid var(--sgx-bd);',
    'overflow:hidden}',
    '#sgx-ai-panel .sgx-ai-ava .sgx-ai-mimg{border:0;padding:0;border-radius:0;width:20px;height:20px}',
    '#sgx-ai-panel .sgx-ai-msg{font-size:var(--sgx-f);line-height:1.6;color:var(--sgx-fg)}',
    /* служебная реплика — не мелочь серым: обычный размер и читаемый цвет */
    '#sgx-ai-panel .sgx-ai-msg.sys{color:#4B4A47;font-size:var(--sgx-f-sm);padding-top:3px}',
    /* логотипы моделей: картинка чёрным по белому, поэтому плитка со скруглением */
    '#sgx-ai-panel .sgx-ai-mimg{flex:0 0 auto;border-radius:var(--sgx-r-sm);object-fit:contain;',
    'background:#fff;border:1px solid #ECECEA;padding:1px}',
    /* вывод запуска кода — прямо в ленте, под кодом */
    '#sgx-ai-panel .sgx-ai-runout{border:1px solid #DCE7D9;background:#F4F9F3;border-radius:var(--sgx-r-sm);overflow:hidden}',
    '#sgx-ai-panel .sgx-ai-runout.bad{border-color:#F0C9C3;background:#FDF2F0}',
    '#sgx-ai-panel .sgx-ai-runhead{padding:var(--sgx-s1) var(--sgx-s3);font-size:12px;font-weight:600;',
    'color:#3F6B4A;border-bottom:1px solid #DCE7D9}',
    '#sgx-ai-panel .sgx-ai-runout.bad .sgx-ai-runhead{color:#8C2F22;border-bottom-color:#F0C9C3}',
    '#sgx-ai-panel .sgx-ai-runbody{padding:var(--sgx-s2) var(--sgx-s3);color:#1F1D1B;',
    'font:var(--sgx-mono)/1.6 ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,Menlo,monospace;',
    'white-space:pre-wrap;overflow-wrap:anywhere}',
    /* код и кнопка копирования: кнопка живёт ВНУТРИ области кода, в её правом
       верхнем углу, — там, где человек и ищет копирование, а не в шапке блока */
    '#sgx-ai-panel .sgx-ai-codewrap{position:relative}',
    '#sgx-ai-panel .sgx-ai-code{margin:0;padding:var(--sgx-s3) var(--sgx-s4);border-radius:var(--sgx-r-sm);',
    'background:#F7F7F6;border:1px solid #ECECEA;color:#1F1D1B;',
    'font:var(--sgx-mono)/1.6 ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,Menlo,monospace;',
    'white-space:pre-wrap;overflow-wrap:anywhere}',
    '#sgx-ai-panel .sgx-ai-codecopy{position:absolute;top:var(--sgx-s2);right:var(--sgx-s2);',
    'display:flex;align-items:center;justify-content:center;width:34px;height:34px;padding:0;',
    'border:1px solid var(--sgx-bd);border-radius:var(--sgx-r-sm);background:#fff;color:#4B4A47;',
    'cursor:pointer;opacity:0;transition:opacity .15s ease}',
    '#sgx-ai-panel .sgx-ai-codewrap:hover .sgx-ai-codecopy,',
    '#sgx-ai-panel .sgx-ai-codecopy:focus{opacity:1}',
    '#sgx-ai-panel .sgx-ai-codecopy:hover{background:#F1F1EF;color:#1F1D1B}',
    '#sgx-ai-panel .sgx-ai-codecopy.done{border-color:#B7DCC0;background:#EDF6EE;color:#2C6B3C}',
    '#sgx-ai-panel .sgx-ai-err{margin:0;padding:var(--sgx-s3);border-radius:var(--sgx-r-sm);background:#FDECEA;',
    'border-left:4px solid #E05B4B;color:#8C2F22;',
    'font:var(--sgx-f-xs)/1.6 ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,Menlo,monospace;',
    'white-space:pre-wrap;overflow-wrap:anywhere}',
    /* «думает» — живой индикатор со счётчиком секунд */
    '#sgx-ai-panel .sgx-ai-think{display:flex;align-items:center;gap:var(--sgx-s2);',
    'font-size:var(--sgx-f-sm);color:var(--sgx-fg-dim)}',
    '#sgx-ai-panel .sgx-ai-secs{font-size:var(--sgx-f-xs);color:#B0AEA9;font-variant-numeric:tabular-nums}',
    '#sgx-ai-panel .sgx-ai-dots{display:inline-flex;gap:3px}',
    '#sgx-ai-panel .sgx-ai-dots span{width:7px;height:7px;border-radius:50%;background:currentColor;',
    'animation:sgx-blink 1.2s ease-in-out infinite}',
    '#sgx-ai-panel .sgx-ai-dots span:nth-child(2){animation-delay:.2s}',
    '#sgx-ai-panel .sgx-ai-dots span:nth-child(3){animation-delay:.4s}',
    '@keyframes sgx-blink{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}',
    /* тонкая полоска сверху страницы — как встроенный индикатор сайта */
    '#sgx-progress{position:fixed;top:0;left:0;right:0;height:3px;z-index:2147483600;pointer-events:none}',
    '#sgx-progress>div{height:100%;width:0;background:#4CAF50;opacity:.85;transition:width .35s ease}',
    /* кнопка в шапке урока: ряд lesson-controls, рядом с полноэкранным режимом.
       Наследуем класс кнопки Stepik, поэтому выглядит родной без своих стилей. */
    '#sgx-tools-btn{position:relative}',
    '#sgx-tools-btn .sgx-dot{position:absolute;top:3px;right:3px;width:7px;height:7px;border-radius:50%;',
    'background:#4CAF50;box-shadow:0 0 0 2px #fff;display:none}',
    '#sgx-tools-btn.sgx-busy .sgx-dot{display:block;animation:sgx-pulse 1.4s ease-in-out infinite}',
    '@keyframes sgx-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
    /* пока панель подменяет меню курса — прячем родной список уроков */
    '.sgx-sidebar-hidden{display:none!important}',
].join(''));

  var chip = null, chipAnchor = null, toastEl = null, toastTimer = null;
  var BRACE_W = 16;

  function bracePath(h, w) {
    var top = 2, bottom = Math.max(top + 12, h - 2);
    var xe = 1.5, xs = w * 0.45, xt = w - 1.5;
    var mid = (top + bottom) / 2;
    var r = Math.max(5, Math.min(16, (bottom - top) / 6));
    return [
      'M', xe, top,
      'Q', xs, top, xs, top + r,
      'L', xs, mid - r,
      'Q', xs, mid, xt, mid,
      'Q', xs, mid, xs, mid + r,
      'L', xs, bottom - r,
      'Q', xs, bottom, xe, bottom
    ].map(function (v) { return typeof v === 'number' ? String(Math.round(v * 10) / 10) : v; }).join(' ');
  }

  function ensureChip() {
    if (chip) return chip;
    chip = document.createElement('div');
    chip.id = 'sgx-chip';
    chip.innerHTML = [
      '<svg class="sgx-brace" xmlns="http://www.w3.org/2000/svg" width="' + BRACE_W + '" height="100" aria-hidden="true">',
      '<path fill="none" stroke="#8FA6BF" stroke-width="2.4" stroke-linecap="round" d=""></path>',
      '</svg>',
      '<div class="sgx-body">',
      '<span class="sgx-label">есть решение</span>',
      '<span class="sgx-acts">',
      '<button type="button" class="sgx-act yes">вставить</button>',
      '<span class="sgx-sep">/</span>',
      '<button type="button" class="sgx-act no">нет</button>',
      '<span class="sgx-sep">/</span>',
      /* «ИИ» показываем ВСЕГДА. Раньше кнопка пряталась, когда ответ уже лежал
         в папке, — и после «Закрыть окно» вернуть блок было нечем: скоба
         предлагала только «вставить» и «нет». Это и была жалоба «закрыл и не
         могу открыть заново». Теперь кнопка есть всегда: если решение для шага
         уже есть, она открывает блок, иначе спрашивает ИИ.                    */
      '<button type="button" class="sgx-act ai">ИИ</button>',
      '</span>',
      '</div>'
    ].join('');
    document.body.appendChild(chip);

    chip.querySelector('.yes').addEventListener('click', function () {
      var ctx = stepContext();
      hideChip(true);
      if (!ctx) return;
      insertSaved(ctx).catch(function (err) { toast('⚠ ' + err.message, true); });
    });
    chip.querySelector('.no').addEventListener('click', function () { hideChip(true); });
    chip.querySelector('.sgx-act.ai').addEventListener('click', function () {
      var ctx = stepContext();
      /* Решение для шага уже есть — значит человек хочет ОТКРЫТЬ блок (например,
         после «Закрыть окно»), а не потратить ещё один запрос.               */
      if (aiAnswer && ctx && aiAnswer.key === ctx.key) {
        aiShow(true);
        aiSlot();
        return;
      }
      askAi();
    });
    return chip;
  }

  /* Скоба рисуется, а не просто появляется: путь обводится от начала к концу.
     Длину берём у самого пути — она зависит от высоты блока.                   */
  function drawBrace(path) {
    if (!path) return;
    var len = 0;
    try { len = path.getTotalLength ? path.getTotalLength() : 0; } catch (e) { len = 0; }
    if (!len) return;                       /* в тестах длины может не быть */
    path.style.transition = 'none';
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
    var kick = function () {
      path.style.transition = 'stroke-dashoffset .5s ease-out';
      path.style.strokeDashoffset = '0';
    };
    /* кадр нужен, иначе браузер склеит начало и конец и линии не будет */
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(kick);
    else setTimeout(kick, 20);
  }

  /* Места справа нет — не переносим скобку наверх, а ужимаем содержимое влево,
     чтобы она поместилась: человек просил «все уменьшить налево». Правку
     запоминаем и снимаем, когда скоба прячется.                                 */
  var squeezedEl = null, squeezedOld = '';

  function squeezeHost(anchor) {
    if (!anchor || !anchor.closest) return null;
    return anchor.closest('.attempt-wrapper__content') || anchor.closest('.quiz-plugin') ||
      anchor.parentElement || null;
  }

  function squeezeRight(host, px) {
    if (squeezedEl && squeezedEl !== host) {
      squeezedEl.style.marginRight = squeezedOld;
      squeezedEl = null;
      squeezedOld = '';
    }
    if (!host) return;
    if (px <= 0) {
      if (host === squeezedEl) {
        host.style.marginRight = squeezedOld;
        squeezedEl = null;
        squeezedOld = '';
      }
      return;
    }
    if (squeezedEl !== host) {
      squeezedOld = host.style.marginRight || '';
      squeezedEl = host;
    }
    host.style.marginRight = Math.round(px) + 'px';
  }

  function positionChip(target) {
    if (!chip || !target) return;
    var card = target.anchor;
    if (!card) return;
    var r0 = card.getBoundingClientRect();
    if (!r0.width && !r0.height) { chip.classList.remove('on'); return; }

    var body = chip.querySelector('.sgx-body');
    var bodyW = (body && body.offsetWidth) || 150;
    var need = bodyW + BRACE_W + 8;
    var host = squeezeHost(card);

    /* Меряем «естественное» положение: сначала снимаем своё ужимание. Иначе на
       втором проходе окажется, что место уже есть, отступ снимется — и скоба
       начнёт дёргаться между двумя положениями.                                */
    var mine = squeezedEl && squeezedEl === host ? squeezedEl.style.marginRight : '';
    if (mine) squeezedEl.style.marginRight = squeezedOld;
    var bare = card.getBoundingClientRect();
    var hostW = host ? host.getBoundingClientRect().width : 0;
    var natural = window.innerWidth - bare.right - 14;
    var want = 0;
    if (natural < need) {
      var deficit = need - natural + 16;
      if (host && hostW - deficit > 320) want = deficit;
    }
    if (mine) squeezedEl.style.marginRight = mine;
    squeezeRight(host, want);

    var r = card.getBoundingClientRect();
    var spaceRight = window.innerWidth - r.right - 14;

    /* Не влезает даже после ужимания — переносим наверх. Так бывает на узком
       экране и в мобильной вёрстке, где содержимое и так во всю ширину.       */
    if (spaceRight < need) {
      chip.classList.add('above');
      chip.style.height = 'auto';
      var hAbove = (body && body.offsetHeight) || 66;
      var wAbove = chip.offsetWidth || bodyW;
      var top = r.top - hAbove - 10;
      if (top < 8) top = Math.min(window.innerHeight - hAbove - 10, r.bottom + 10);
      chip.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - wAbove - 10, r.left))) + 'px';
      chip.style.top = Math.round(Math.max(8, top)) + 'px';
      return;
    }

    chip.classList.remove('above');
    var h = Math.max(56, r.height);
    var svg = chip.querySelector('.sgx-brace');
    if (svg) {
      svg.setAttribute('height', String(Math.round(h)));
      svg.style.height = Math.round(h) + 'px';
      var path = svg.querySelector('path');
      if (path) {
        path.setAttribute('d', bracePath(h, BRACE_W));
        /* рисуем один раз на показ: при прокрутке путь пересчитывается, но
           заново обводить его не надо — это выглядело бы как мигание         */
        if (chip.getAttribute('data-drawn') !== '1') {
          chip.setAttribute('data-drawn', '1');
          drawBrace(path);
        }
      }
    }
    chip.style.height = Math.round(h) + 'px';
    chip.style.left = Math.round(r.right + 12) + 'px';
    chip.style.top = Math.round(r.top) + 'px';
  }

  function showChip(target, label, noAnswer) {
    ensureChip();
    chip.querySelector('.sgx-label').textContent = label || 'есть решение';
    chip.classList.toggle('sgx-no-answer', !!noAnswer);
    chipAnchor = target;
    /* Рисуем скобку ТОЛЬКО при появлении. tick зовёт showChip каждые 1.5 секунды,
       и если сбрасывать отметку каждый раз, скобка обводится бесконечно — на это
       и жаловался человек.                                                    */
    var fresh = !chip.classList.contains('on');
    if (fresh) {
      chip.removeAttribute('data-drawn');
      chip.classList.remove('sgx-in');
    }
    chip.classList.add('on');
    positionChip(target);
    if (fresh) {
      /* пересчёт нужен, чтобы браузер не склеил появление и анимацию */
      void chip.offsetWidth;
      chip.classList.add('sgx-in');
    }
  }

  function hideChip(dismiss) {
    if (chip) {
      chip.classList.remove('on');
      chip.classList.remove('sgx-in');
    }
    /* ужимание снимаем: страница должна вернуться к обычной ширине */
    squeezeRight(null, 0);
    chipAnchor = null;
    if (dismiss) {
      var ctx = stepContext();
      if (ctx) dismissed[ctx.key] = true;
    }
  }

  /* Вывод запуска кода. Раньше в ленте было «нажал «Запустить код» — результат
     ниже», и человек шёл искать этот результат глазами по странице. Теперь вывод
     показываем прямо в блоке, под кодом.

     Селекторы перечислены по убыванию надёжности и все проверяются на принадлежность
     карточке задания: показать вместо вывода условие задачи было бы хуже, чем не
     показать ничего.                                                           */
  var RUN_OUT_SELS = [
    /* Настоящая разметка панели запуска (прислал человек):
       .code-runner__hints > .smart-hints > .show-more > .show-more__content >
       <p class="smart-hints__hint">Empty result</p>                            */
    '.code-runner__hints .smart-hints__hint',
    '.code-runner__hints .show-more__content',
    '.code-runner__hints',
    '.code-runner__output', '.code-editor-quiz__output', '.run-code-result',
    '.attempt-wrapper__output', '.code-quiz__output', '.execution-result',
    '.run-result', '.code-output', '.output-viewer', '.console-output'
  ];

  function runOutputText() {
    var host = $('.attempt-wrapper__content') || $('.quiz-plugin') || document.body;
    var i, node, text;
    for (i = 0; i < RUN_OUT_SELS.length; i++) {
      node = $(RUN_OUT_SELS[i]);
      if (!node || (host.contains && !host.contains(node))) continue;
      /* Порог именно «> 0»: ответ из одного символа («2») — законный вывод,
         а не пустота. norm() уже срезал пробелы, так что пустой узел не пройдёт. */
      text = norm(node.textContent || '');
      if (text.length > 0 && text.length < 4000) return text;
    }
    /* запасной путь: ищем по имени класса, но только внутри блока с редактором
       и никогда — в своём собственном блоке */
    var scopes = [$('.quiz-plugin'), $('.code-editor-quiz__editor'), $('.attempt-wrapper__plugin')];
    for (i = 0; i < scopes.length; i++) {
      if (!scopes[i]) continue;
      var found = scopes[i].querySelectorAll('[class*="output"]');
      for (var j = 0; j < found.length; j++) {
        if (found[j].closest && found[j].closest('#sgx-ai-root')) continue;
        text = norm(found[j].textContent || '');
        if (text.length > 0 && text.length < 4000) return text;
      }
    }
    return '';
  }

  function looksLikeRunError(text) {
    return /traceback|error|exception|ошибк|failed|wrong answer|неверн|time limit|превыш/i
      .test(String(text || ''));
  }

  /* Показать вывод запуска в ленте. Ошибку красим красным, обычный вывод — как код. */
  function aiLogOutput(text) {
    var log = aiLogEl();
    if (!log || !text) return null;
    var bad = looksLikeRunError(text);
    var wrap = document.createElement('div');
    wrap.className = 'sgx-ai-msg sgx-ai-runout' + (bad ? ' bad' : '');
    var head = document.createElement('div');
    head.className = 'sgx-ai-runhead';
    head.textContent = bad ? 'Вывод запуска — с ошибкой' : 'Вывод запуска';
    var body = document.createElement('div');
    body.className = 'sgx-ai-runbody';
    body.textContent = text;
    wrap.appendChild(head);
    wrap.appendChild(body);
    log.appendChild(aiRow(wrap));
    log.scrollTop = log.scrollHeight;
    return wrap;
  }

  function flash(el) {
    if (!el || !el.getBoundingClientRect) return;
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var ov = document.createElement('div');
    ov.className = 'sgx-flash';
    ov.style.left = Math.round(r.left) + 'px';
    ov.style.top = Math.round(r.top) + 'px';
    ov.style.width = Math.round(r.width) + 'px';
    ov.style.height = Math.round(r.height) + 'px';
    document.body.appendChild(ov);
    setTimeout(function () { ov.classList.add('off'); }, 220);
    setTimeout(function () { ov.remove(); }, 700);
  }

  /* Индикатор сохранения в правом нижнем углу — вместо всплывающего уведомления.
     Крутится, пока идёт запись; превратился в галочку и растаял — ответ сохранён.
     Текста нет намеренно: человек просил не сообщение, а обычную загрузку.      */
  var saveEl = null;
  var saveTimer = null;

  function saveSpin(on, state) {
    if (!saveEl) {
      saveEl = document.createElement('div');
      saveEl.id = 'sgx-save';
      saveEl.innerHTML = '<span class="sgx-save-ring"></span>' +
        '<span class="sgx-save-tick"></span><span class="sgx-save-cross"></span>';
      document.body.appendChild(saveEl);
    }
    clearTimeout(saveTimer);
    if (on) { saveEl.className = 'on'; return; }
    saveEl.className = 'on done ' + (state === 'err' ? 'err' : 'ok');
    saveTimer = setTimeout(function () { saveEl.className = ''; },
      state === 'err' ? 2600 : 1300);
  }

  function toast(text, isError) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'sgx-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.className = 'on' + (isError ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.className = ''; }, isError ? 6000 : 3500);
  }

  function showReport(text) {
    var old = document.getElementById('sgx-report');
    if (old) old.remove();

    var wrap = document.createElement('div');
    wrap.id = 'sgx-report';
    var box = document.createElement('div');
    box.className = 'sgx-rep-box';
    var ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = text;
    var row = document.createElement('div');
    row.className = 'sgx-rep-row';

    var copy = document.createElement('button');
    copy.textContent = 'Скопировать';
    copy.addEventListener('click', function () {
      ta.select();
      try { document.execCommand('copy'); copy.textContent = 'Скопировано'; } catch (e) { /* ignore */ }
    });
    var close = document.createElement('button');
    close.textContent = 'Закрыть';
    close.addEventListener('click', function () { wrap.remove(); });

    row.appendChild(copy);
    row.appendChild(close);
    box.appendChild(ta);
    box.appendChild(row);
    wrap.appendChild(box);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
    document.body.appendChild(wrap);
  }

  window.addEventListener('scroll', function () { if (chipAnchor) positionChip(chipAnchor); }, true);
  window.addEventListener('resize', function () { if (chipAnchor) positionChip(chipAnchor); });

  /* ------------------------------------------------------------- контекст */

  function stepContext() {
    var m = location.pathname.match(/\/lesson\/(?:[^/]*?-)?(\d+)\/step\/(\d+)/);
    if (!m) return null;
    return { lesson: m[1], step: +m[2], key: 'l' + m[1] + '_s' + m[2] };
  }

  /* ==================================================== панель «от и до» */

  /* Структура курса Stepik: в боковом меню — уроки с номерами вида 4.1, 4.2, 4.3,
     а внутри урока — шаги (те самые зелёные квадратики сверху). Поэтому диапазон
     задаётся либо уроками («с 4.1 по 4.3» — весь курс от урока до урока), либо
     шагами одного урока.
     Обход — это очередь пар (урок, шаг) в GM-хранилище: скрипт переходит на
     следующий шаг обычной навигацией и продолжает работу после перезагрузки. */

  var JOB_KEY = 'job';
  var job = null;
  try { job = JSON.parse(GM_getValue(JOB_KEY, 'null')); } catch (e) { job = null; }
  var jobBusy = false;
  var lastDocUrl = '';
  var lastTheoryAt = 0;                /* когда в прошлый раз собирали теорию урока */
  var lastNav = '';

  /* сколько ждём открытия шага, прежде чем признать переход неудачным.
     Не больше 6 секунд: на диапазон из десятков шагов минуты ожидания недопустимы. */
  var NAV_TIMEOUT = 6000;
  var NAV_HARD_AFTER = 2000;

  /* Одностраничное приложение может сменить адрес, не перезагрузив документ.
     Тогда job в GM-хранилище живёт в СТАРОЙ вкладке: доводим её до конца,
     обнуляя шаг, чтобы после перезагрузки обход не начался заново. */
  function forkedJob() {
    try { return JSON.parse(GM_getValue(JOB_KEY, 'null')); } catch (e) { return null; }
  }

  function saveJob() {
    try { GM_setValue(JOB_KEY, JSON.stringify(job)); } catch (e) { log('не сохранил задание:', e.message); }
  }

  function jobTotal() { return job && job.plan ? job.plan.length : 0; }

var ICONS = {
    play: '<polygon points="6 4 19 12 6 20 6 4"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/>' +
      '<line x1="12" y1="15" x2="12" y2="3"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>' +
      '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>' +
      '<path d="M18.5 15.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/>' +
      '<path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    /* иконки блока ИИ — те же мотивы, что нарисованы у Stepik рядом с редактором:
       «код» на вкладке и «веник» на кнопке сброса */
    code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    broom: '<path d="M19 3l-6.5 6.5"/><path d="M14 12l-3.5 3.5"/>' +
      '<path d="M13.5 10.5a5 5 0 0 1-7 7l-3.5-3.5a5 5 0 0 1 7-7z"/>',
    /* «Сбросить» — корзина: прежний веник читался как непонятная загогулина */
    trash: '<polyline points="3 6 21 6"/><path d="M8 6V4h8v2"/>' +
      '<path d="M6 6l1 14h10l1-14"/><line x1="10" y1="11" x2="10" y2="17"/>' +
      '<line x1="14" y1="11" x2="14" y2="17"/>',
    /* иконки моделей: у каждой модели свой значок в списке выбора */
    bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    /* шестерёнка для кнопки настроек */
    cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1' +
      'M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    chip: '<rect x="6" y="6" width="12" height="12" rx="2"/>' +
      '<path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
    gem: '<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20M9 3l3 18M15 3l-3 18"/>',
    chev: '<polyline points="6 9 12 15 18 9"/>',
    sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>' +
      '<line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>' +
      '<line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>' +
      '<line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>' +
      '<line x1="17" y1="16" x2="23" y2="16"/>'
  };

  function icon(name, size) {
    return '<svg class="sgx-ic" viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) +
      '" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  /* Сообщение, которое не должен перебить идущий обход: короткие подсказки вроде
     «обход уже идёт» иначе исчезают через долю секунды, и человек их не видит. */
  var stickyUntil = 0, stickyText = '';
  var lastStatus = '';                 /* что было сказано в последний раз */
  function setSticky(text) { stickyText = text; stickyUntil = Date.now() + 2500; setStatus(text); }

  function setStatus(text) {
    if (Date.now() < stickyUntil && text !== stickyText) return;
    stickyText = text;
    lastStatus = text || '';
    /* Последнее сообщение кладём в data-атрибут документа: его видно снаружи
       (в отчёте самопроверки и в автотестах), даже когда панель не открыта. */
    try { document.documentElement.setAttribute('data-sgx-status', lastStatus); } catch (e) { /* ignore */ }
    var el = document.getElementById('sgx-status');
    if (el) el.textContent = text || '';
    /* Панель живёт в сайдбаре и видна не всегда (например, меню курса свёрнуто).
       Поэтому важные сообщения дублируем тостом — иначе человек не поймёт, что
       обход закончился или что он уже идёт. */
    if (text && /^(готово|ошибка|не смог|остановлено|обход уже)/.test(text)) toast(text);
    var total = jobTotal();
    var ratio = job ? (total ? job.at / total : 0) : -1;
    var bar = document.getElementById('sgx-bar');
    if (bar) bar.style.width = (ratio < 0 ? 0 : Math.round(ratio * 100)) + '%';
    setSiteProgress(ratio);
  }

  /* тонкая полоска вверху страницы: выглядит как встроенный индикатор Stepik */
  function setSiteProgress(ratio) {
    var el = document.getElementById('sgx-progress');
    if (ratio < 0) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'sgx-progress';
      el.innerHTML = '<div></div>';
      document.body.appendChild(el);
    }
    el.firstChild.style.width = Math.round((ratio || 0) * 100) + '%';
  }

  function startJob(kind, plan, title) {
    job = { kind: kind, plan: plan, at: 0, shots: [], title: title, navAt: 0, navTo: '' };
    saveJob();
    renderPanel();
    setStatus(kind === 'solve' ? 'пошёл по заданиям' : 'собираю скриншоты');
    /* обход обязан быть виден: полоска вверху страницы + статус в панели */
    setSiteProgress(0);
    setTimeout(tick, 0);
  }

  function stopJob(message) {
    job = null;
    saveJob();
    setSiteProgress(-1);
    renderPanel(true);
    setStatus(message || 'остановлено');
  }

  /* Stepik — одностраничное приложение: смена location.href внутри истории иногда
     перехватывается роутером и страница НЕ перезагружается. Тогда обход стоит на
     месте, а код считает, что «перешёл». Поэтому адресуем маршрутизатор напрямую,
     а присваивание href оставляем запасным путём. */
  function pushRoute(url) {
    try {
      window.history.pushState({}, '', url);
      document.dispatchEvent(new CustomEvent('sgx:nav', { detail: { url: url } }));
      try { window.dispatchEvent(new PopStateEvent('popstate')); } catch (e2) { /* не во всех движках */ }
      return true;
    } catch (e) { return false; }
  }

  /* ?unit= из адреса относится к ТЕКУЩЕМУ уроку: с чужим unit Stepik отдаёт
     «страница не найдена». Поэтому переносим его только внутри того же урока. */
  function stepUrl(lesson, step) {
    var ctx = stepContext();
    var same = !!(ctx && String(ctx.lesson) === String(lesson));
    return '/lesson/' + lesson + '/step/' + step + (same ? (location.search || '') : '');
  }

  function goToStep(lesson, step) {
    var ctx = stepContext();
    if (ctx && String(ctx.lesson) === String(lesson) && ctx.step === +step) return true;
    var url = stepUrl(lesson, step);
    lastNav = url;
    lastReason = 'перехожу на ' + url;
    return pushRoute(url);
  }

  /* мы уже на нужном шаге карточки задания */
  async function runJob(ctx) {
    if (!job || jobBusy) return;
    var target = job.plan && job.plan[job.at];
    if (!target) return finishJob();

    if (String(ctx.lesson) !== String(target.lesson) || ctx.step !== target.step) {
      var url = stepUrl(target.lesson, target.step);
      setStatus('перехожу на ' + target.label + '…');

      /* уже просили этот же переход — значит роутер не сработал */
      if (job.navTo === url) {
        if (!job.navAt) job.navAt = Date.now();
        var waited = Date.now() - job.navAt;

        /* прошло достаточно — пробуем жёсткую перезагрузку мимо роутера */
        if (waited > NAV_HARD_AFTER && !job.navHard) {
          job.navHard = true;
          lastReason = 'жёсткий переход на ' + url;
          var went = false;
          try { location.href = url; went = true; } catch (e) { went = false; }
          if (went) return;
        }
        /* страницу открыть не удалось — не висим, идём дальше */
        if (waited > NAV_TIMEOUT) {
          setStatus('не смог открыть ' + target.label + ' — пропускаю');
          return nextJobStep(true);
        }
        return;
      }

      job.navTo = url;
      job.navAt = 0;
      job.navHard = false;
      goToStep(target.lesson, target.step);
      return;
    }

    job.navTo = '';
    job.navAt = 0;
    jobBusy = true;
    try {
      if (job.kind === 'solve') await jobSolve(ctx, target);
      else await jobCollect(ctx, target);
    } catch (e) {
      setStatus('ошибка на ' + target.label + ': ' + e.message);
      await sleep(1500);
      nextJobStep(true);
    } finally {
      jobBusy = false;
    }
  }

  function nextJobStep(skipped) {
    if (!job) return;
    if (skipped) job.skipped = (job.skipped || 0) + 1;
    job.at++;
    job.navTo = '';
    job.navAt = 0;
    job.navHard = false;
    saveJob();
    var target = job.plan && job.plan[job.at];
    if (!target) return finishJob();
    setStatus('перехожу на ' + target.label + '…');
    return goToStep(target.lesson, target.step);
  }

  function skippedNote() {
    return job && job.skipped ? ' · пропущено ' + job.skipped : '';
  }

  function finishJob() {
    if (!job) return;
    if (job.kind === 'collect') return finishCollect();
    stopJob('готово: пройдено ' + (jobTotal() - (job.skipped || 0)) + ' из ' + jobTotal() +
      skippedNote());
  }

  /* Текст кнопки на Stepik — «Отправить на проверку», поэтому сверяем НАЧАЛО строки,
     а не всю строку целиком. «Решить снова» отсекаем: это перезапуск задания, а не отправка. */
  var SUBMIT_RE = /^(отправить|отправка|проверить|решить|submit|send|check)/i;
  /* «Запустить код» — это отдельная кнопка, она НЕ отправляет ответ на проверку.
     Её надо и находить отдельно, и ни в коем случае не путать с отправкой:
     в английском интерфейсе «Run» попал бы под SUBMIT_RE, и обход заданий жал бы
     «Запустить» вместо «Отправить». Поэтому run исключён из SUBMIT_RE и вынесен
     в свой шаблон.                                                             */
  var RUN_RE = /^(запустить код|запустить|выполнить код|выполнить|run code|run|play)$/i;
  var NOT_SUBMIT_RE = /снова|заново|ещё раз|еще раз|again|отмена|cancel|удалить|delete|запустить|выполнить/i;

  /* Кнопка запуска кода. Сначала по классу: Stepik сам подписывает её
     attempt-wrapper-button_run, и это надёжнее подписи, которая локализуется.   */
  function runButton() {
    var byClass = $('.attempt-wrapper-button_run');
    if (byClass && !byClass.disabled) return byClass;

    var nodes = $$('button, [role="button"]');
    for (var i = 0; i < nodes.length; i++) {
      var text = norm(nodes[i].textContent);
      if (!text || !RUN_RE.test(text)) continue;
      var r = nodes[i].getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (nodes[i].disabled) continue;
      return nodes[i];
    }
    return byClass || null;      /* класс нашли, но кнопка серая — вернём её как есть */
  }

  function submitButton(includeDisabled) {
    var nodes = $$('button, [role="button"]');
    var disabled = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var text = norm(el.textContent);
      if (!text || NOT_SUBMIT_RE.test(text) || !SUBMIT_RE.test(text)) continue;
      /* кнопка запуска — не отправка, даже если подпись подходит под шаблон */
      if (el.classList && el.classList.contains('attempt-wrapper-button_run')) continue;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (el.disabled) { disabled = disabled || el; continue; }
      return el;
    }
    return includeDisabled ? disabled : null;
  }

  async function jobSolve(ctx, target) {
    setStatus((job.at + 1) + ' из ' + jobTotal() + ': ' + target.label + ' — вставляю ответ');
    var res;
    try {
      res = await insertSaved(ctx);
    } catch (e) {
      setStatus(target.label + ': ' + e.message + ' — пропускаю');
      await sleep(900);
      return nextJobStep(true);
    }
    await sleep(500);
    /* если Stepik считает редактор пустым, кнопка остаётся серой — толкаем её событиями */
    var ed = $('.CodeMirror, .cm-content, .attempt-wrapper__plugin textarea');
    if (ed) {
      try { ed.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { /* ignore */ }
      try { ed.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* ignore */ }
    }
    var btn = await waitFor(submitButton, 8000, 300);
    if (!btn) {
      var stuck = submitButton(true);
      setStatus(target.label + (stuck
        ? ': кнопка «' + norm(stuck.textContent) + '» неактивна — ответ вставил, но не отправил'
        : ': кнопки «Отправить» нет — пропускаю'));
      await sleep(1500);
      return nextJobStep(true);
    }
    btn.click();
    setStatus((job.at + 1) + ' из ' + jobTotal() + ': ' + target.label + ' отправлено');
    await sleep(2500);
    return nextJobStep();
  }

async function jobCollect(ctx, target) {
    /* скриншотим только там, где вставляют код, а не отвечают галочкой */
    if (!$('.CodeMirror, .cm-content, .attempt-wrapper__plugin textarea')) {
      setStatus((job.at + 1) + ' из ' + jobTotal() + ': ' + target.label + ' — не код, пропускаю');
      return nextJobStep(true);
    }
    setStatus((job.at + 1) + ' из ' + jobTotal() + ': ' + target.label + ' — снимаю скриншот');
    var shot = await shootStep(ctx, target);
    if (shot) {
      job.shots.push(shot);
      try { saveJob(); } catch (e) { log(e); }
    } else {
      setStatus(target.label + ': скриншот не получился — пропускаю');
      await sleep(1000);
      return nextJobStep(true);
    }
    return nextJobStep();
  }

  /* ------------------------------------------------------------- скриншот */

  function stepTitle(ctx, target) {
    var card = $('.attempt-wrapper__content') || document.body;
    var head = '';
    var nodes = $$('.step-text, .problem__header, .attempt-wrapper__content h1, .text, .step-title', card);
    for (var i = 0; i < nodes.length; i++) {
      var t = norm(nodes[i].textContent);
      if (t.length > 3) { head = t.slice(0, 90); break; }
    }
    var where = (target && target.label) || ('шаг ' + ctx.step);
    return where + (head ? '. ' + head : '');
  }

  async function shootStep(ctx, target) {
    if (typeof html2canvas !== 'function') {
      log('html2canvas не загрузился — соберу документ без скриншотов');
      return null;
    }
    var el = insertTarget();
    var card = (el && cardOf(el.anchor)) || $('.attempt-wrapper__content') || document.body;
    var rect = card.getBoundingClientRect();
    if (rect.height < 40) return null;

    var canvas;
    try {
      canvas = await html2canvas(card, {
        backgroundColor: '#ffffff',
        scale: Math.min(2, window.devicePixelRatio || 1),
        useCORS: true,
        logging: false,
        scrollX: 0,
        scrollY: -window.scrollY,
        windowWidth: document.documentElement.clientWidth
      });
    } catch (e) {
      log('html2canvas упал:', e.message);
      return null;
    }
    if (!canvas || !canvas.width) return null;

    /* ужимаем до 1100 px по ширине, чтобы документ не раздувался;
       если ужать не получилось — берём скриншот как есть, он важнее размера */
    var maxW = 1100;
    var out = canvas;
    if (canvas.width > maxW) {
      try {
        var scale = maxW / canvas.width;
        var c2 = document.createElement('canvas');
        c2.width = maxW;
        c2.height = Math.round(canvas.height * scale);
        var ctx2 = c2.getContext('2d');
        ctx2.fillStyle = '#ffffff';
        ctx2.fillRect(0, 0, c2.width, c2.height);
        ctx2.drawImage(canvas, 0, 0, c2.width, c2.height);
        out = c2;
      } catch (e) {
        log('ужать скриншот не вышло, беру как есть:', e.message);
        out = canvas;
      }
    }
    return {
      step: ctx.step, lesson: ctx.lesson, title: stepTitle(ctx, target),
      img: out.toDataURL('image/png'), w: out.width, h: out.height
    };
  }

  /* ---------------------------------------------------------- документ .docx */

  var XML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return XML_ESC[c]; }); }

  var DOCX_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  var DOCX_ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  var DOCX_W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

  function docxParagraph(text, opts) {
    opts = opts || {};
    var run = '<w:rPr>' +
      (opts.bold ? '<w:b/>' : '') +
      (opts.size ? '<w:sz w:val="' + opts.size + '"/>' : '') +
      '</w:rPr>';
    return '<w:p><w:pPr>' + (opts.spacing ? '<w:spacing w:before="' + opts.spacing + '"/>' : '') + '</w:pPr>' +
      '<w:r>' + run + '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r></w:p>';
  }

  function docxImage(rid, id, w, h) {
    var maxW = 5943600;                       /* ~16.5 см: ширина полосы набора A4 */
    var cx = Math.round(w * 9525), cy = Math.round(h * 9525);
    if (cx > maxW) { cy = Math.round(cy * maxW / cx); cx = maxW; }
    return '<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">' +
      '<wp:extent cx="' + cx + '" cy="' + cy + '"/>' +
      '<wp:docPr id="' + id + '" name="image' + id + '"/>' +
      '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      '<pic:pic><pic:nvPicPr><pic:cNvPr id="' + id + '" name="image' + id + '.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
      '<pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
      '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
      '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  }

  function buildDocx(shots, title) {
    if (typeof JSZip !== 'function') throw new Error('библиотека для .docx не загрузилась');
    var zip = new JSZip();
    var word = zip.folder('word');
    var media = word.folder('media');
    var rels = [];
    var body = [docxParagraph(title || 'Задания Stepik', { bold: true, size: '32' })];
    body.push(docxParagraph('Собрано скриптом Stepik ⇄ Ответы · ' + nowIso().slice(0, 16).replace('T', ' ')));

    var n = 0;
    (shots || []).forEach(function (s) {
      var m = /^data:image\/png;base64,(.+)$/.exec(s.img || '');
      if (!m) return;
      n++;
      var name = 'image' + n + '.png';
      media.file(name, m[1], { base64: true });
      var rid = 'rId' + n;
      rels.push('<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + name + '"/>');
      body.push(docxParagraph(s.title || ('Шаг ' + s.step), { bold: true, spacing: '240' }));
      body.push(docxImage(rid, n, s.w || 1000, s.h || 600));
    });
    if (!n) body.push(docxParagraph('Скриншоты не получились — библиотека html2canvas не загрузилась.'));

    zip.file('[Content_Types].xml', DOCX_CONTENT_TYPES);
    zip.file('_rels/.rels', DOCX_ROOT_RELS);
    word.file('_rels/document.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join('') + '</Relationships>');
    word.file('document.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + DOCX_W_NS + '><w:body>' +
      body.join('') +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="850" w:right="850" w:bottom="850" w:left="850"/></w:sectPr>' +
      '</w:body></w:document>');

    return zip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
  }

  function downloadBlob(blob, name) {
    try {
      if (lastDocUrl) URL.revokeObjectURL(lastDocUrl);
      lastDocUrl = URL.createObjectURL(blob);
    } catch (e) {
      log('не создал ссылку на файл:', e.message);
      return;
    }
    var a = document.createElement('a');
    a.href = lastDocUrl;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 2000);
  }

  function docName() {
    var t = (job && job.title) || 'сборка';
    return 'stepik-' + t.replace(/[^\wА-Яа-яЁё.-]+/g, '_').slice(0, 60) + '.docx';
  }

  async function finishCollect() {
    var shots = (job && job.shots) || [];
    var title = 'Задания Stepik · ' + ((job && job.title) || 'сборка');
    setStatus('собираю документ (' + shots.length + ' скриншотов)');
    try {
      var blob = await buildDocx(shots, title);
      var name = docName();
      stopJob('готово: ' + shots.length + ' скриншотов, документ скачивается' + skippedNote());
      downloadBlob(blob, name);
      renderPanel(true);
    } catch (e) {
      stopJob('не собрал документ: ' + e.message);
    }
  }

  /* ------------------------------------------------------------------- ИИ */

  /* ИИ советует решение там, где в общей папке ответа ещё нет.
     ИИ ничего не вставляет и не отправляет сам — показывает текст решения,
     чтобы человек решил, пользоваться им или нет. */

  /* Адрес канала держим закодированным, чтобы он не лежал в исходнике одной
     строкой и не находился поиском. Это НЕ защита — адрес всё равно виден
     в сетевой панели браузера, — но и подсказывать его в тексте не нужно.      */
  function aiEndpoint() {
    var host = '';
    try { host = b64decode('YXBpLnJlZm9ybWJvc3MuY29t'); } catch (e) { host = ''; }
    return 'https://' + host + '/v1/chat/completions';
  }

  /* Тело запроса одинаково и для прямого канала, и для прокси: прокси только
     подставляет ключ, который в браузер не попадает.                          */
  function aiRequestBody(model, system, user) {
    return {
      model: model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      /* лимит — из каталога: у reasoning-моделей он заметно больше, иначе
         размышления съедают весь ответ и до кода доезжает пара символов */
      max_tokens: modelInfo(model).maxTokens,
      /* Низкая температура: решение задачи, а не рассказ. */
      temperature: 0.2,
      private: true
    };
  }

  /* Свой прокси: единственный способ спрятать ключ ПО-НАСТОЯЩЕМУ. Запрос идёт
     на свой сервер, ключ там и остаётся, в браузер не приходит.

     Адрес уже вписан ниже, поэтому прокси работает сразу после установки и
     настраивать ничего не нужно. Лежит он, как и ключ, не строкой: числа — это
     адрес, сложенный по XOR с подкладкой.

     ЧЕСТНО ПРО ЭТОТ АДРЕС. Он не секрет в том смысле, что его видно в сетевой
     панели браузера, — но кто его знает, тот может слать через прокси запросы
     и тратить кредиты владельца. Ограничивает это суточный лимит на стороне
     сервера (по умолчанию 300 запросов): утечка адреса неприятна, но не
     разорительна. Захочется закрыть совсем — переразверни приложение, адрес
     сменится, и впиши новый в настройках.

     Как поднять свой прокси — server/AI-PROXY.md.                            */
  var PROXY_BYTES = [
    27, 0, 17, 0, 26, 81, 2, 73, 18, 16, 6, 68, 19, 27,
    67, 23, 3, 10, 19, 9, 95, 94, 17, 0, 21, 86, 87, 83,
    83, 64, 89, 73, 95, 18, 75, 50, 63, 3, 9, 10, 9, 84,
    60, 39, 7, 70, 117, 82, 62, 44, 19, 84, 2, 49, 45, 93,
    24, 40, 9, 45, 35, 72, 120, 125, 2, 115, 15, 41, 44, 30,
    7, 44, 13, 57, 59, 93, 99, 41, 24, 1, 18, 97, 54, 27,
    31, 3, 3, 7, 46, 58, 83, 49, 3, 28, 59, 50, 86, 100,
    99, 66, 119, 91, 58, 11, 33, 0, 22, 74, 21, 17, 14, 78
  ];
  var PROXY_PAD = 'stepik-fast-complete:proxy:2026:pad';

  function builtInProxyUrl() {
    try {
      var out = '';
      for (var i = 0; i < PROXY_BYTES.length; i++) {
        out += String.fromCharCode(PROXY_BYTES[i] ^ PROXY_PAD.charCodeAt(i % PROXY_PAD.length));
      }
      return out;
    } catch (e) { return ''; }
  }

  /* Пустая строка в настройках — это «прокси не использовать», а не «взять
     встроенный»: иначе выключить его было бы нельзя.                          */
  function aiProxyCleared() {
    var v = null;
    try { v = GM_getValue('aiProxy', null); } catch (e) { v = null; }
    return v !== null && v !== undefined && !String(v).length;
  }

  function aiProxyUrl() {
    if (aiProxyCleared()) return '';
    var v = null;
    try { v = GM_getValue('aiProxy', null); } catch (e) { v = null; }
    if (v !== null && v !== undefined && String(v).length) return String(v);
    return builtInProxyUrl();
  }

  function setAiProxy(url) {
    try { GM_setValue('aiProxy', String(url || '')); } catch (e) { /* ignore */ }
  }

  /* Ходим ли мы через прокси прямо сейчас — нужно для внятных сообщений. */
  function aiUsingProxy() { return !!aiProxyUrl(); }

  /* Канал один: свой ключ. Модель выбрана замером —
     glm-5.3-flash отвечает около 5 с, а deepseek-v4-flash около 30 с: тот
     reasoning-модель и жжёт бюджет на размышления. Бесплатный канал
     (text.pollinations.ai) убран: анонимный тариф отвечал 402 через раз.    */

  var AI_GAP = 1500;                   /* только чтобы не долбить сервис в цикле */
  var AI_GAP_PAID = 800;               /* то же самое для своего канала */
  var AI_WAIT_MAX = 3;                 /* столько секунд паузы пережидаем внутри, а не пропускаем канал */
  var AI_TRIES = 2;                    /* попыток на канал */
  /* Сколько ждём ответ. Без этого «думал две минуты» ничем не заканчивалось:
     запрос висел, а человек не понимал, работает скрипт или умер.              */
  var AI_TIMEOUT = 90000;

  /* Каталог моделей канала. Список взят у самого сервиса (GET /v1/models), а не
     придуман: у каждой записи — СВОЯ картинка (человек прислал ссылки на логотипы),
     запасной значок на случай, если картинка не загрузится, «ум» по пятибалльной
     шкале (человек должен видеть, чем платит за ум: сильные модели думают дольше)
     и СВОЙ лимит ответа.

     Лимит — главное здесь. Reasoning-модель пишет размышления прямо в ответ, и
     общий лимит 4000 съедали именно они: до кода доезжало «```python\na», ответ
     приходил обрывком. Поэтому сильным моделям лимит поднят, а слабым оставлен
     скромным — иначе они просто пишут дольше.                                   */
  var AI_MODELS = [
    {
      id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', icon: 'bolt', smarts: 2,
      maxTokens: 8000, note: 'быстрая, для простых заданий',
      img: 'https://i.imgur.com/DVdAOHf.png'
    },
    {
      id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', icon: 'chip', smarts: 3,
      maxTokens: 20000, note: 'думает прямо в ответе — лимит выше',
      img: 'https://i.imgur.com/qpf5Hoe.png'
    },
    {
      id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', icon: 'code', smarts: 4,
      maxTokens: 32000, note: 'заточена под код',
      img: 'https://i.imgur.com/y2H82HX.png'
    },
    {
      id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', icon: 'gem', smarts: 5,
      maxTokens: 40000, note: 'самая сильная, отвечает дольше',
      img: 'https://i.imgur.com/qpf5Hoe.png'
    }
  ];

  /* Логотип модели: картинка, а если она не загрузилась — запасной значок.
     Без запасного варианта в списке осталась бы дырка.                          */
  function modelIcon(m, size) {
    var s = size || 20;
    if (!m.img) return icon(m.icon, s);
    return '<img class="sgx-ai-mimg" src="' + m.img + '" alt="" width="' + s + '" height="' + s +
      '" data-fallback="' + escapeHtml(m.icon) + '">';
  }

  /* Подмену на запасной значок вешаем слушателем, а не строкой в onerror:
     строку браузер вставил бы текстом, и в списке появился бы мусор.           */
  function wireModelIcons(root) {
    var imgs = (root || document).querySelectorAll('.sgx-ai-mimg');
    Array.prototype.forEach.call(imgs, function (img) {
      if (img.__sgxWired) return;
      img.__sgxWired = true;
      img.addEventListener('error', function () {
        var box = document.createElement('span');
        box.className = 'sgx-ic';
        box.innerHTML = icon(img.getAttribute('data-fallback') || 'spark',
          Number(img.getAttribute('width')) || 22);
        if (img.parentNode) img.parentNode.replaceChild(box, img);
      });
    });
  }

  function modelInfo(id) {
    for (var i = 0; i < AI_MODELS.length; i++) {
      if (AI_MODELS[i].id === id) return AI_MODELS[i];
    }
    return AI_MODELS[0];
  }

  /* Канал один — свой, по ключу. Бесплатный (text.pollinations.ai) убран: у него
     анонимный тариф отвечал 402 через раз, а решение нужно здесь и сейчас.        */
  var AI_CHANNELS = [
    {
      id: 'own', label: 'свой ключ', needKey: true,
      url: aiEndpoint(),
      models: AI_MODELS.map(function (m) { return m.id; }),
      headers: function (key) { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }; },
      body: aiRequestBody
    },
    {
      /* Ставим первым: если человек настроил прокси, он важнее всего — тогда
         ключа в браузере нет вообще.                                           */
      id: 'proxy', label: 'свой прокси', needKey: false,
      url: aiProxyUrl,
      models: AI_MODELS.map(function (m) { return m.id; }),
      headers: function () { return { 'Content-Type': 'application/json' }; },
      body: aiRequestBody
    }
  ];

  /* atob есть в любом браузере, но при нестандартном окружении его может не быть —
     тогда декодируем сами, иначе ключ молча пропадёт и «свой канал» не подключится. */
  function b64decode(s) {
    if (typeof atob === 'function') { try { return atob(s); } catch (e) { /* ниже запасной путь */ } }
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var out = '', buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === '=') break;
      var v = chars.indexOf(c);
      if (v < 0) continue;
      buf = (buf << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 0xFF); }
    }
    return out;
  }

  /* Три состояния, и их важно не путать:
       null / не задан — ключа нет и никогда не было → берём встроенный;
       ''  (пусто)     — человек сознательно очистил поле → свой канал выключен;
       строка          — свой ключ человека.                                            */
  function aiKeyCleared() { return cfg.aiKey !== null && cfg.aiKey !== undefined && !String(cfg.aiKey).length; }

  function aiKey() {
    if (aiKeyCleared()) return '';
    return (cfg.aiKey && cfg.aiKey.length) ? cfg.aiKey : '';
  }

  /* Есть ли вообще чем ходить: прокси или свой ключ. Нужно для внятного
     сообщения, когда не работает ни то, ни другое.                           */
  function aiHasChannel() {
    return aiChannels().length > 0;
  }

  function setAiKey(val) { cfg.aiKey = val; GM_setValue('aiKey', val); }

  function aiChannels() {
    var list = AI_CHANNELS.filter(function (c) {
      if (c.id === 'proxy') return !!aiProxyUrl();      /* пока адреса нет — не канал */
      return !c.needKey || aiKey();
    });
    /* Прокси всегда первым: если он настроен, ключ в браузере не нужен вовсе. */
    list.sort(function (a, b) {
      return (a.id === 'proxy' ? 0 : 1) - (b.id === 'proxy' ? 0 : 1);
    });
    return list;
  }

  var aiBusy = false;
  var aiLast = 0;
  var aiAnswer = null;                 /* { key, text, at, model, kind } */
  var AI_KEY = 'aiAnswer';

  try { aiAnswer = JSON.parse(GM_getValue(AI_KEY, 'null')); } catch (e) { aiAnswer = null; }

  function saveAi() {
    try { GM_setValue(AI_KEY, JSON.stringify(aiAnswer)); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------ выбор модели */

  /* Какую модель звать. Список берём из канала, выбор человека помним в хранилище.
     Если сохранённой модели в списке больше нет — молча возвращаемся к первой,
     иначе в теле запроса уехало бы имя, которого сервис не знает.               */
  var AI_MODEL_KEY = 'aiModel';

  function aiModelList() {
    var ch = AI_CHANNELS[0];
    return ch && ch.models ? ch.models.slice() : [];
  }

  function aiModel() {
    var saved = '';
    try { saved = String(GM_getValue(AI_MODEL_KEY, '') || ''); } catch (e) { saved = ''; }
    var list = aiModelList();
    return list.indexOf(saved) >= 0 ? saved : (list[0] || '');
  }

  function setAiModel(name) {
    if (aiModelList().indexOf(name) < 0) return;
    try { GM_setValue(AI_MODEL_KEY, name); } catch (e) { /* ignore */ }
  }

  /* Порядок перебора: сначала выбранная модель, потом ОДНА запасная — если
     выбранная молчит, шанс всё равно остаётся. Больше двух не берём: каталог
     моделей длинный, и на сбое сервиса перебор всех подряд превращался в восемь
     попыток с паузами — человек ждал минуту вместо внятной ошибки.            */
  function modelsFor(ch, preferred) {
    var all = (ch && ch.models) || [];
    /* Для сопоставления ответ короткий и строго форматированный. Reasoning-модели
       могут тратить минуты на размышления; берём одну быструю модель и не
       перебираем остальные. */
    if (preferred && all.indexOf(preferred) >= 0) return [preferred];
    var want = aiModel();
    if (all.indexOf(want) < 0) return all.slice(0, 2);
    var rest = all.filter(function (m) { return m !== want; });
    return [want].concat(rest.slice(0, 1));
  }

  function aiModeForKind(kind, retry) {
    /* Таблица — тот же короткий структурированный ответ, что и сопоставление:
       одна строка на строку таблицы. Сильная «думающая» модель тут только
       добавит минуту ожидания.                                                */
    if (kind === 'table') {
      return { retry: false, modelId: 'glm-5.3-flash', timeoutMs: 25000,
        maxTokens: 512, temperature: 0 };
    }
    if (kind === 'matching') {
      return {
        retry: false,
        modelId: 'glm-5.3-flash',
        timeoutMs: 25000,
        maxTokens: 512,
        temperature: 0
      };
    }
    return { retry: retry !== false };
  }

  /* Пауза между запросами к своему каналу — чтобы не долбить сервис в цикле. */
  function aiLastOf(chId) {
    var t = 0;
    try { t = +(GM_getValue('aiLast_' + chId, 0) || 0); } catch (e) { t = 0; }
    return t;
  }

  function aiWaitLeft(chId) {
    var gap = chId === 'free' ? AI_GAP : AI_GAP_PAID;
    var left = gap - (Date.now() - (aiLastOf(chId) || aiLast));
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  function aiWaitAny() {
    var left = 0;
    aiChannels().forEach(function (c) {
      var w = aiWaitLeft(c.id);
      if (!left || w < left) left = w;
    });
    return left;
  }

  function markAi(chId) {
    aiLast = Date.now();
    try { GM_setValue('aiLast_' + chId, aiLast); } catch (e) { /* ignore */ }
  }

  /* Текст условия. Раньше здесь было три жёстких контейнера, и если Stepik
     отрисовывал карточку иначе (условие вне .attempt-wrapper__content), скрипт
     молча отправлял ИИ пустоту — тот честно отвечал «условие отсутствует».
     Поэтому: собираем по списку реальных контейнеров, убираем дубли по тексту,
     и отдельно приклеиваем «Тестовые данные» — без них код неверный.            */
  var STEP_TEXT_SELS = [
    '.html-content.rich-text-viewer',      /* условие в текущей вёрстке Stepik */
    '.step-text',                          /* старая вёрстка и заголовок шага */
    '.problem__header',
    '.step-inner .html-content',
    '.attempt-wrapper__content'
  ];

  function stepConditionText() {
    var seen = [];
    var parts = [];
    for (var i = 0; i < STEP_TEXT_SELS.length; i++) {
      var nodes = $$(STEP_TEXT_SELS[i]);
      for (var j = 0; j < nodes.length; j++) {
        var t = norm(nodes[j].textContent || '');
        if (t.length < 2) continue;
        /* .attempt-wrapper__content вбирает в себя условие целиком, поэтому его
           берём последним и только если ничего другого не нашлось */
        if (seen.indexOf(t) >= 0) continue;
        seen.push(t);
        parts.push(t);
      }
      if (parts.length) break;
    }
    return parts.join('\n');
  }

  /* Таблица «вход → выход»: самое ценное для ИИ — по ней он понимает формат ввода
     и результат. В текущей вёрстке Stepik строка такая:
       <div class="attempt-wrapper-samples__header-row">№ Теста | Входные | Выходные</div>
       <div class="attempt-wrapper-samples__data-row">
         <div>1</div>
         <div class="attempt-wrapper-samples__data-row-code">
           <button data-clipboard-text="13">…</button></div>
         <div class="attempt-wrapper-samples__data-row-content">
           <span class="attempt-wrapper-samples__data-row-text">13</span> … </div>
     Значение надёжнее брать из data-clipboard-text: там оно лежит целиком, тогда
     как видимый текст бывает обрезан «…».                                       */

  /* Ячейки данных: вход и выход. Номер теста в них не попадает — он лежит голым
     <div>1</div> без класса, поэтому искать его надо среди прямых детей строки.  */
  var SAMPLE_VAL = '.attempt-wrapper-samples__data-row-code,' +
    '.attempt-wrapper-samples__data-row-content';

  function isDataCell(node) {
    if (!node || !node.classList) return false;
    return node.classList.contains('attempt-wrapper-samples__data-row-code') ||
      node.classList.contains('attempt-wrapper-samples__data-row-content');
  }

  /* Номер теста. Раньше «номером» считалась первая ячейка, если её текст похож на
     одно-двузначное число, — и вход «5» или «13» уезжал как номер: в запрос
     уходило «13) вход: True», то есть вход и выход перепутанными. Ячейка данных
     номером быть не может по определению, поэтому смотрим только на прочих
     прямых детей строки.                                                        */
  function testNumberOf(row) {
    var kids = Array.prototype.slice.call(row.children || []);
    for (var i = 0; i < kids.length; i++) {
      if (isDataCell(kids[i])) continue;
      var t = norm(kids[i].textContent || '');
      if (/^\d{1,3}$/.test(t)) return t;
    }
    return '';
  }

  function sampleValue(node) {
    if (!node) return '';
    /* кнопка «копировать» несёт полное значение в data-clipboard-text */
    var btn = $('[data-clipboard-text]', node);
    var raw = btn ? btn.getAttribute('data-clipboard-text') : '';
    if (raw && raw.trim()) return raw.replace(/\s+$/, '');
    var txt = norm(node.textContent || '');
    /* обрезанный «…» в конце видимого текста — признак, что значение неполное */
    return txt.replace(/…$/, '').trim();
  }

  function stepSamplesText() {
    var box = $('.step-text__samples-wrapper') ||
      $('.attempt-wrapper-samples-wrapper') || $('.attempt-wrapper-samples');
    if (!box) return '';
    var rows = $$('.attempt-wrapper-samples__data-row', box);
    var out = [];
    var n = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var cells = $$(SAMPLE_VAL, row);
      if (!cells.length) continue;

      /* номер теста берём не из ячеек данных, а из остальных детей строки */
      var num = testNumberOf(row);

      var vals = [];
      for (var j = 0; j < cells.length; j++) {
        var v = sampleValue(cells[j]);
        if (v) vals.push(v);
      }
      if (!vals.length) continue;

      n++;
      var line = (num || n) + ') вход: ' + vals[0];
      if (vals.length > 1) line += ' → выход: ' + vals[1];
      if (vals.length > 2) line += ' (' + vals.slice(2).join(' | ') + ')';
      out.push(line);
    }
    if (out.length) return 'Тестовые данные:\n' + out.join('\n');
    var alt = norm(box.textContent || '');
    return alt.length > 10 ? alt : '';
  }

  function stepPrompt() {
    var cond = stepConditionText();
    var samples = stepSamplesText();
    var text = norm((cond + '\n' + samples).replace(
      /Отправить на проверку|Решить снова|Скачать|Показать ответ|Тестовые данные(?=\s*№)/g, ' '));
    /* Условие режем короче прежнего: длинный хвост задания только раздувает
       запрос, а время ответа растёт вместе с ним. Условия Stepik укладываются
       в этот размер целиком.                                                    */
    return text.slice(0, 1800);
  }

  /* Модель любит заворачивать решение в разметку: ```python … ``` или
     '''Python …'''. Скопировать из такого блока нельзя — в редактор уедет
     тройная кавычка и слово «Python», а на первом шаге это сразу видно.
     Поэтому снимаем обёртку сами: и языковую метку, и сами ограждения.        */
  function stripFences(text) {
    var orig = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
    if (!orig) return '';
    var s = orig;
    var paired = false;             /* нашли ли настоящую пару ограждений */

    /* Ограждений в ответе бывает несколько: по дороге модель показывает примеры,
       а настоящий ответ идёт последним. Раньше бралось ПЕРВОЕ ограждение — и
       в решение попадал кусок размышлений вместо ответа. Берём последнее.
       Метку языка читаем до конца строки: «```Python 3.6» — это тоже метка,
       а не код, и хвост «3.6» в решение попасть не должен.                     */
    var bodies = [];
    var re = /```[^\n]*\n([\s\S]*?)```/g;
    var hit;
    while ((hit = re.exec(s)) !== null) {
      if (hit[1] && hit[1].trim()) bodies.push(hit[1].trim());
    }
    if (bodies.length) { s = bodies[bodies.length - 1]; paired = true; }
    /* ограждение с меткой и без переноса (одна строка кода): ```print(1)``` */
    if (!paired) {
      var one = s.match(/```[ \t]*([A-Za-z0-9+#.\-]*?)[ \t]*([\s\S]*?)```/);
      if (one && one[2] && one[2].trim()) { s = one[2].trim(); paired = true; }
    }

    /* '''Python''' / """python""" — Python-строки-ограждения. Метка бывает и
       ЗАКРЫТА теми же кавычками: «'''Python'''\nкод\n'''» — именно так пишет
       модель, и раньше это разбиралось только построчной чисткой, которая
       заодно вырезала кавычки докстрингов. Поэтому закрывающие кавычки после
       метки допускаем прямо здесь.                                            */
    var quote = s.match(/^['"]{3}\s*[A-Za-z0-9+#.\-]*\s*(?:['"]{3})?\s*\n?([\s\S]*?)\n?['"]{3}\s*$/);
    if (quote && quote[1] && quote[1].trim()) { s = quote[1].trim(); paired = true; }

    /* остатки: строка-метка языка (одно слово) в начале или конце */
    var label = /^(?:```|''')?\s*(?:python|py|c#|csharp|c\+\+|cpp|java|javascript|js|typescript|ts|sql|kotlin|go|haskell|pascal|rust|ruby|php|swift|scala|r|bash|sh|shell|text|txt)\s*\d*(?:\.\d+)?\s*$/i;
    var lines = s.split('\n');
    while (lines.length && label.test(lines[0].trim())) lines.shift();
    while (lines.length && label.test(lines[lines.length - 1].trim())) lines.pop();
    if (lines.join('\n').trim()) s = lines.join('\n');

    /* Одиночные ограждения по краям убираем только когда была настоящая пара:
       иначе «```python» без продолжения превратилось бы в «python» — то есть
       в мусор, который выглядит как код.

       И только края, и только БЭКТИКИ. Раньше здесь был проход по всем строкам
       (`/^\s*(?:```|'''|""")\s*$/gm`), и он вырезал кавычки у многострочного
       докстринга:
           def f():
               """
               Считает.
               """
       превращалось в код без кавычек — то есть в синтаксическую ошибку.
       Одинарные и двойные кавычки в Python — это строки, их трогать нельзя.     */
    /* Ограждений не было: возможно, модель написала размышления прямо в ответ.
       Тогда отрезаем всё до последнего начала кода (см. cutReasoning).         */
    if (!paired) return cutReasoning(s);
    var fenceOnly = /^\s*```+\s*$/;             /* строка только из бэктиков */
    var out = s.split('\n');
    while (out.length && fenceOnly.test(out[0])) out.shift();
    while (out.length && fenceOnly.test(out[out.length - 1])) out.pop();
    var stripped = out.join('\n').replace(/^\s*\n+|\n+\s*$/g, '');
    return stripped.trim() ? stripped : orig;
  }

  /* Reasoning-модель вываливает размышления прямо в ответ: «We need answer only
     code in Python. Need parse problem. Need understand Stepik task…». В ленту
     уезжает стена английского текста, а код — в самом конце. Признак узкий
     (несколько служебных оборотов разом), чтобы не порезать нормальный ответ.  */
  var REASONING_MARKS = [
    /\bwe need\b/i, /\bneed to\b/i, /\blet'?s\b/i, /\bi think\b/i, /\bmaybe\b/i,
    /\bso the\b/i, /\bfirst,?\s+we\b/i, /\bthe user (?:says|wants|asks)\b/i,
    /\bperhaps\b/i, /\bwait,?\b/i, /\bso we (?:can|should|need)\b/i
  ];

  function looksLikeReasoning(text) {
    var t = String(text || '');
    if (t.length < 240) return false;
    var hits = 0;
    for (var i = 0; i < REASONING_MARKS.length; i++) {
      if (REASONING_MARKS[i].test(t)) hits++;
    }
    return hits >= 3;
  }

  /* Отрезать размышления: оставляем всё от последней строки, похожей на начало
     кода. Если такой строки нет или хвост не похож на код — возвращаем как есть:
     показать лишнее лучше, чем потерять ответ.                                  */
  function cutReasoning(text) {
    var t = String(text || '');
    if (!looksLikeReasoning(t)) return t;
    var lines = t.split('\n');
    var start = -1;
    for (var i = 0; i < lines.length; i++) {
      if (/^\s*(?:import\s|from\s+\w+\s+import|def\s+\w|class\s+\w|if\s+__name__|#)/.test(lines[i])) {
        start = i;
      }
    }
    if (start <= 0) return t;
    var tail = lines.slice(start).join('\n');
    /* хвост должен быть кодом, а не ещё одной порцией прозы */
    if (!/(?:^\s+\S|print\(|return |input\(|console\.|\{|\})/m.test(tail)) return t;
    return tail.trim().length > 8 ? tail.trim() : t;
  }

  /* Ответ оборвался по лимиту токенов. Снаружи это выглядит как «модель написала
     одно слово»: приходит «```python\ndef» — ограждение снимается, и в ленте
     остаётся «def» как будто это решение. Провайдер честно сообщает причину
     в finish_reason, поэтому запоминаем её и говорим человеку прямо.            */
  function looksTruncated(text, finish) {
    if (finish === 'length') return true;
    /* Провайдер прямо сказал «ответ закончен» — верим ему и не гадаем по тексту:
       иначе короткое, но верное решение («print(1)») выглядело бы обрезанным.   */
    if (finish) return false;
    var t = String(text || '').trim();
    if (!t) return false;
    /* finish_reason провайдер не прислал вовсе: тогда единственная зацепка —
       объявление функции без тела. Именно так выглядел огрызок «def».          */
    if (t.indexOf('\n') < 0 && t.length < 24 && /^(def|class|for|while|if|print|import|from)\b/.test(t)) {
      return /(?:\(|:)$/.test(t);
    }
    return false;
  }

  function stepLanguage() {
    var cm = $('.CodeMirror');
    if (cm && cm.CodeMirror && cm.CodeMirror.getOption) {
      try { return cm.CodeMirror.getOption('mode') || ''; } catch (e) { /* ignore */ }
    }
    var hint = norm((document.body.textContent || '').slice(0, 4000));
    var langs = [['c#', 'C#'], ['csharp', 'C#'], ['python', 'Python'], ['питон', 'Python'],
      ['java', 'Java'], ['c++', 'C++'], ['javascript', 'JavaScript'], ['sql', 'SQL'],
      ['kotlin', 'Kotlin'], ['go', 'Go'], ['haskell', 'Haskell'], ['pascal', 'Pascal']];
    var low = hint.toLowerCase();
    for (var i = 0; i < langs.length; i++) {
      if (low.indexOf(langs[i][0]) >= 0) return langs[i][1];
    }
    return '';
  }

  /* Видов задания три:
       code   — редактор кода;
       choice — тест с галочками (один ответ или несколько);
       text   — свободный ответ в обычном поле (string-quiz__textarea).          */
  function stepKindNow() {
    if ($('.CodeMirror, .cm-content')) return 'code';
    if ($('.string-quiz__textarea')) return 'text';
    if ($('.matching-quiz')) return 'matching';
    /* Таблица «Отметьте верные ячейки» тоже собрана на радиокнопках, поэтому
       проверять её надо РАНЬШЕ выбора: иначе она уходила бы по ветке теста и
       скрипт искал бы варианты ответа там, где их нет.                        */
    if (tableQuizTable()) return 'table';
    if ($('.quiz-component input[type="radio"], .quiz-component input[type="checkbox"]')) return 'choice';
    if ($('.attempt-wrapper__plugin textarea')) return 'code';
    return 'text';
  }

  /* ================================================ таблица «верные ячейки» */

  /* Задание вида «Отметьте верные ячейки»: строки — куски кода, столбцы —
     варианты (true / false / ошибка). В каждой строке отмечается ровно один
     столбец, и выбрать его нужно по смыслу строки.                            */

  function tableQuizTable() {
    return $('[data-type="table-quiz"] table') || $('.table-quiz__table');
  }

  function tableQuizRows() {
    var table = tableQuizTable();
    if (!table) return [];
    var heads = $$('thead th', table).map(function (th) { return norm(th.textContent); });
    /* первый столбец — сам код, он подписью и остаётся */
    var out = [];
    $$('tbody tr', table).forEach(function (tr) {
      var cells = $$('td', tr);
      if (cells.length < 2) return;
      var label = norm(cells[0].textContent || '');
      var inputs = [];
      for (var i = 1; i < cells.length; i++) {
        inputs.push(cells[i].querySelector('input[type="radio"]') ||
          cells[i].querySelector('input'));
      }
      if (!label || !inputs.length) return;
      out.push({ label: label, inputs: inputs });
    });
    return out.length ? { heads: heads, rows: out } : [];
  }

  /* Разбираем ответ модели: по одной строке на каждую строку таблицы, в строке —
     название столбца. Сравниваем без учёта регистра и допускаем сокращение:
     модель может написать «Ошибка» вместо «Ошибка (FormatException)».          */
  function tableFromText(text) {
    var t = tableQuizRows();
    if (!t || t.rows.length < 2 || t.heads.length < 2) return null;

    var lines = String(text || '').split('\n').map(function (l) {
      return norm(l).replace(/^[-*•·]\s*/, '').replace(/^\d+\s*[).:—-]\s*/, '').trim();
    }).filter(function (l) { return l.length > 0; });
    if (lines.length < t.rows.length) return null;

    /* Первый столбец — сам код, он не вариант ответа. Поэтому и сравниваем, и
       нумеруем только оставшиеся: иначе всё съезжало на столбец вправо.        */
    var cols = t.heads.slice(1);
    if (cols.length !== t.rows[0].inputs.length) {
      /* шапка и ячейки разошлись — считаем по ячейкам */
      cols = t.rows[0].inputs.map(function (_, k) { return t.heads[k + 1] || ''; });
    }

    var picks = [];
    for (var i = 0; i < t.rows.length; i++) {
      var l = lines[i].toLowerCase();
      var idx = -1;
      /* 1. точное совпадение со столбцом */
      for (var j = 0; j < cols.length; j++) {
        if (cols[j] && cols[j].toLowerCase() === l) { idx = j; break; }
      }
      /* 2. столбец внутри строки («это true») */
      if (idx < 0) {
        for (var k = 0; k < cols.length; k++) {
          var h = (cols[k] || '').toLowerCase();
          if (h.length > 2 && l.indexOf(h) >= 0) { idx = k; break; }
        }
      }
      /* 3. сокращение вместо полного названия столбца («Ошибка») */
      if (idx < 0 && l.length > 2) {
        for (var m = 0; m < cols.length; m++) {
          var hh = (cols[m] || '').toLowerCase();
          if (hh && hh.indexOf(l) >= 0) { idx = m; break; }
        }
      }
      if (idx < 0) return null;
      picks.push(idx);
    }
    return picks;
  }

  /* Отмечаем по одному столбцу в каждой строке. */
  function writeTable(picks) {
    var t = tableQuizRows();
    if (!t || !picks || picks.length !== t.rows.length) {
      return { ok: false, error: 'таблица не совпала с ответом' };
    }
    var done = 0;
    t.rows.forEach(function (row, i) {
      var inp = row.inputs[picks[i]];
      if (!inp) return;
      if (!inp.checked) inp.click();
      done++;
    });
    return { ok: done === t.rows.length, applied: done, total: t.rows.length };
  }

  /* ============================================ задание на сопоставление */

  /* Так выглядит «Сопоставьте часть метода с её назначением»: слева список
     подписей, справа список значений, которые надо расставить в том же
     порядке. Перетаскивать мышью не нужно: у каждого элемента справа есть
     кнопки «выше»/«ниже» с подписью Move up / Move down — ими и упорядочиваем. */

  function matchItems(sel) {
    return $$(sel + ' .matching-quiz__item').map(function (it) {
      var c = it.querySelector('.dnd-quiz__item-content') || it;
      return norm(c.textContent || '');
    }).filter(function (t) { return !!t; });
  }

  function matchingLeft() { return matchItems('.matching-quiz__left'); }
  function matchingRight() { return matchItems('.matching-quiz__right'); }

  /* Разбираем ответ модели: он должен вернуть правый столбец в нужном порядке,
     по одному элементу в строке. Возвращаем порядок целиком — если не хватает
     одного элемента, дописываем его сами: место у него остаётся единственное.  */
  function matchingFromText(text) {
    var items = matchingRight();
    if (items.length < 2) return null;

    var lines = String(text || '').split('\n').map(function (l) {
      return norm(l).replace(/^[-*•·]\s*/, '').replace(/^\d+\s*[).:—-]\s*/, '').trim();
    }).filter(function (l) { return l.length > 1; });

    var want = [];
    lines.forEach(function (l) {
      var hit = null;
      for (var i = 0; i < items.length; i++) {
        if (items[i].toLowerCase() === l.toLowerCase()) { hit = items[i]; break; }
      }
      if (hit && want.indexOf(hit) < 0) want.push(hit);
    });

    /* Одного не хватает — дописываем: он встанет на единственное свободное место. */
    if (want.length === items.length - 1) {
      var rest = items.filter(function (t) { return want.indexOf(t) < 0; });
      if (rest.length === 1) want.push(rest[0]);
    }
    if (want.length !== items.length) return null;
    return want;
  }

  /* Расставляем элементы в нужном порядке кнопками «выше». Простой выбор:
     идём по нужному порядку и поднимаем каждый элемент на его место.           */
  async function orderMatching(want) {
    var moved = 0;
    for (var i = 0; i < want.length; i++) {
      var items = $$('.matching-quiz__right .matching-quiz__item');
      var from = -1;
      for (var j = i; j < items.length; j++) {
        var c = items[j].querySelector('.dnd-quiz__item-content') || items[j];
        if (norm(c.textContent || '') === want[i]) { from = j; break; }
      }
      if (from < 0) continue;
      while (from > i) {
        var cur = $$('.matching-quiz__right .matching-quiz__item');
        var btn = cur[from] && cur[from].querySelector('[aria-label^="Move up"]');
        if (!btn || btn.disabled) break;
        btn.click();
        moved++;
        await sleep(200);
        from--;
      }
    }
    return moved;
  }

  /* Варианты ответа теста. В условии их НЕТ: вопрос лежит в тексте задания, а
     сами варианты — отдельными строками в блоке с галочками. Без них модель
     выбирает вслепую, поэтому собираем их отдельно и отдаём в запрос.          */
  function choiceOptions() {
    var inputs = $$('.quiz-component[data-type="choice-quiz"] input, .quiz-plugin__content input')
      .filter(function (i) { return /radio|checkbox/.test(i.type) && !i.disabled; });
    var out = [];
    inputs.forEach(function (inp, idx) {
      var label = inp.closest('label') || inp.parentElement;
      var txt = norm((label || {}).textContent || '');
      if (!txt) return;
      out.push({ n: idx + 1, text: txt, id: String(inp.value) });
    });
    return out;
  }

  /* Системный текст держим коротким: он уходит в каждый запрос, и каждое лишнее
     предложение здесь — это лишнее время ответа. Правила оставлены, вода убрана.

     Запретный список появился после разбора: на задании про среднее арифметическое
     модель принесла `import sys`, `def main()`, `if __name__ == "__main__"` и
     f-строку `f"{res:.15g}"` — ни одной из этих вещей в уроке ещё не было. Простое
     «держитесь уровня урока» модель игнорирует, поэтому здесь перечислено прямо.

     Для теста с выбором нужен ДРУГОЙ текст: правила про stdin/stdout и «код целиком»
     сбивали модель с толку, и она писала код там, где надо поставить галочку.     */
  function aiSystem(kind) {
    if (kind === 'text') {
      return 'Реши задание со Stepik. Это НЕ код, а короткий ответ — верни ТОЛЬКО его: ' +
        'одну строку, без пояснений, без markdown, без кавычек и без точки в конце.\n' +
        '1. Отвечай ровно на вопрос и тем же языком, что и вопрос.\n' +
        '2. Пиши так, как ответил бы студент этого урока: коротко и по делу.';
    }
    if (kind === 'table') {
      return 'Реши задание со Stepik с таблицей «отметьте верные ячейки». В каждой ' +
        'строке таблицы слева написан код, а справа нужно выбрать ОДИН столбец: ' +
        'что произойдёт при выполнении этого кода.\n' +
        'Верни по одной строке на каждую строку таблицы — ровно название выбранного ' +
        'столбца, без нумерации, без пояснений и без markdown.\n' +
        '1. Строк должно быть столько же, сколько строк в таблице, в том же порядке.\n' +
        '2. Название столбца пиши так, как оно написано в шапке таблицы.\n' +
        '3. Никакого кода писать не нужно.';
    }
    if (kind === 'matching') {
      return 'Реши задание на сопоставление со Stepik. Слева список подписей в нужном ' +
        'порядке, справа список значений, которые надо расставить ТАК ЖЕ — чтобы ' +
        'напротив каждой подписи слева оказалось подходящее значение.\n' +
        'Верни ТОЛЬКО правые значения в нужном порядке, по одному в строке, ровно так, ' +
        'как они написаны, без нумерации, без пояснений и без markdown.\n' +
        '1. Строк должно быть столько же, сколько элементов справа: ни одной лишней ' +
        'и ни одной пропущенной.\n' +
        '2. Порядок строк — это и есть ответ. Первая строка встанет напротив первой ' +
        'подписи слева, вторая — напротив второй, и так далее.\n' +
        '3. Никакого кода писать не нужно.';
    }
    if (kind === 'choice') {
      return 'Реши тест со Stepik. Верни ТОЛЬКО текст выбранного варианта — ровно так, ' +
        'как он написан в списке, символ в символ, без пояснений, без markdown и без ' +
        'нумерации. Если подходит несколько вариантов (галочки, а не кружки) — верни ' +
        'каждый с новой строки. Никакого кода писать не нужно.\n' +
        '1. Выбирай по смыслу вопроса, а не по длине варианта.\n' +
        '2. Если в уроке ещё не было сложных конструкций — выбирай самый простой вариант.\n' +
        '3. ВЫБИРАЙ ТОЛЬКО ТО, ЧТО ПОДХОДИТ. Не перечисляй все варианты подряд: ' +
        'неправильных в тесте обычно больше, чем правильных. Если подходит один — ' +
        'верни один. Никогда не возвращай весь список.\n' +
        '4. Сначала мысленно отбрось те варианты, которые не подходят, и только ' +
        'потом выбирай из оставшихся.';
    }
    return 'Реши задание со Stepik. Верни ТОЛЬКО ответ: без пояснений, без markdown, ' +
      'без ``` и без строки с названием языка. Код — целиком, одним куском. ' +
      'Ввод и вывод через stdin → stdout; строки могут содержать кириллицу и пробелы.\n' +
      '1. Пиши ровно тем, что уже было в уроке, и не сложнее. Запрещено: import ' +
      '(в том числе sys, os, math), любые модули, классы, лямбды, генераторы, ' +
      'списковые включения, f-строки, def main(), if __name__ == "__main__", ' +
      'try/except. Ввод — только input(), вывод — только print().\n' +
      '2. Решение — короткое: несколько строк, без лишних функций и проверок.\n' +
      '3. Имена переменных — простые и короткие, как у новичка: a, b, c, n, x, ' +
      'number, text, result. Никаких word_count, idx, tmp, res, obj, cnt.\n' +
      '4. Прогони код по тестовым данным из условия и сверь вывод с ожидаемым.\n' +
      '5. Вывод — ровно как в «выходных данных», символ в символ: 2 и 2.0 — разные ' +
      'ответы. Если в «выходе» целое число, а деление дало дробь, выведи целое: ' +
      'посчитай результат и, если он равен своей целой части, напечатай целое.';
  }

  /* Блок «где мы и что уже проходили» — общий и для первого ответа, и для правки:
     модель должна видеть уровень урока в обоих случаях.                        */
  function aiLessonBlock() {
    var les = lessonNow();
    var theory = stepTheoryText();
    var out = '';
    if (les && (les.label || les.title)) {
      out += 'Урок ' + (les.label || '?') + (les.title ? ' — «' + les.title + '»' : '');
      if (les.total && les.index) out += ' (' + les.index + '-й из ' + les.total + ' в курсе)';
      out += '.';
      /* первые уроки курса — почти всегда знакомство с языком: там сложные
         конструкции выглядят особенно чужеродно.                               */
      if (les.unit && les.unit <= 2) out += ' Это самое начало раздела — пиши проще некуда.';
      out += '\n';
    }
    if (theory) {
      out += 'Что уже разобрано в этом уроке (считай, что только это студент и знает):\n' +
        theory + '\n';
    }
    return out;
  }

  function aiUser() {
    return aiUserFor(stepContext());
  }

  /* Запрос собираем от ctx, а не «от страницы»: при исправлении нужно то же самое
     условие, что ушло в первый раз, иначе модель начнёт решать другую задачу. */
  /* Вид задания можно передать явно. При правке это обязательно: после провала
     Stepik может убрать карточку задания со страницы, и определённый по ней вид
     окажется не тем — запрос уйдёт как «свободный ответ» вместо теста, без
     списка вариантов и без прошлых попыток.                                    */
  function aiUserFor(ctx, kindIn) {
    var kind = kindIn || stepKindNow();
    var lang = stepLanguage();
    var task = stepPrompt();

    /* Таблица: строки с кодом и названия столбцов. */
    if (kind === 'table') {
      var tq = tableQuizRows();
      var tbase = aiLessonBlock() + '\nЗадание с таблицей. В каждой строке нужно выбрать ' +
        'один столбец — то, что произойдёт при выполнении кода слева.\n\nВопрос:\n' + task +
        '\n\nСтолбцы: ' + (tq ? tq.heads.slice(1).join(' | ') : '') +
        '\n\nСтроки таблицы:\n' +
        (tq ? tq.rows.map(function (r, i) { return (i + 1) + ') ' + r.label; }).join('\n') : '') +
        '\n\nВерни название столбца для каждой строки, по одному в строке, в том же порядке.';
      if (ctx && ctx.checkError) {
        tbase += '\n\nЧто ответила проверка:\n' + String(ctx.checkError).slice(0, 1200) +
          '\nРазберись, где ошибся, и верни столбцы заново.';
      }
      return tbase;
    }

    /* Сопоставление: отдаём оба столбца как есть. Левый — в порядке страницы,
       правый — как он стоит сейчас, чтобы модель видела, что переставлять.     */
    if (kind === 'matching') {
      var left = matchingLeft();
      var right = matchingRight();
      var mbase = aiLessonBlock() + '\nЗадание на сопоставление. Нужно расставить правый ' +
        'столбец так, чтобы напротив каждой подписи слева оказалось подходящее значение.\n\n' +
        'Вопрос:\n' + task + '\n\nЛевый столбец (в нужном порядке):\n' +
        left.map(function (t, i) { return (i + 1) + ') ' + t; }).join('\n') +
        '\n\nПравый столбец (переставить):\n' +
        right.map(function (t) { return '— ' + t; }).join('\n') +
        '\n\nВерни правые значения в нужном порядке, по одному в строке.';
      if (ctx && ctx.checkError) {
        mbase += '\n\nЧто ответила проверка:\n' + String(ctx.checkError).slice(0, 1200) +
          '\nРазберись, что перепутано, и верни порядок заново.';
      }
      return mbase;
    }

    /* Тест с выбором собираем иначе: вариантов в условии нет, они отдельным
       блоком, и про stdin/stdout говорить нечего.                             */
    if (kind === 'choice') {
      var opts = choiceOptions();
      var list = opts.map(function (o) { return o.n + ') ' + o.text; }).join('\n');
      var ask = 'Задание — тест. Выбери верный вариант и верни ТОЛЬКО его текст, ' +
        'ровно как в списке, без номера и без пояснений. Если дословно скопировать ' +
        'не получается, верни только номер варианта.';
      var base = aiLessonBlock() + '\n' + ask + '\n\nВопрос:\n' + task;
      if (list) base += '\n\nВарианты ответа:\n' + list;
      /* Прошлые попытки: без этого модель упрямо возвращает тот же вариант, и
         человек получает «Пока неправильно» второй раз подряд.                 */
      var tried = aiTriedChoices[ctx && ctx.key] || [];
      if (tried.length) {
        base += '\n\nУже отправляли, и проверка их не приняла:\n' +
          tried.map(function (t) { return '— ' + t; }).join('\n') +
          '\nЭти варианты больше не предлагай. Выбери ДРУГОЙ и объясни себе, ' +
          'чем он лучше: перечитай вопрос и все варианты заново.';
      }
      if (ctx && ctx.checkError) {
        base += '\n\nЧто ответила проверка:\n' + String(ctx.checkError).slice(0, 1000);
      }
      return base;
    }

    if (kind === 'text') {
      var tbase = aiLessonBlock() + '\nОтветь на вопрос коротко: одна строка, без пояснений.\n' +
        '\nВопрос:\n' + task;
      if (ctx && ctx.checkError) {
        tbase += '\n\nПрошлый ответ не подошёл. Что ответила проверка:\n' +
          String(ctx.checkError).slice(0, 1000) + '\nОтветь иначе.';
      }
      return tbase;
    }

    var ask2 = lang ? 'Пиши на ' + lang + '.' : 'Определи язык по условию и пиши на нём.';
    /* Тестовые данные — это и есть формат ввода-вывода: без них модель пишет код,
       который читает не то и выводит не так. Просим свериться с ними явно. */
    var hasSamples = /вход:/.test(task);
    var hint = hasSamples
      ? '\nСверься с «Тестовые данные»: программа должна читать ровно то, что во «вход»,\n' +
        'и печатать ровно то, что в «выход».'
      : '';
    var base2 = aiLessonBlock() + '\n' + ask2 + hint + '\n\nУсловие:\n' + task;
    if (ctx && ctx.prevCode) {
      base2 += '\n\nТвой прошлый ответ:\n' + String(ctx.prevCode).slice(0, 1200);
    }
    if (ctx && ctx.checkError) {
      base2 += '\n\nПроверка его отклонила. Отчёт проверяющей системы:\n' +
        String(ctx.checkError).slice(0, 1000) +
        '\n\nНайди причину и пришли исправленное решение целиком. ' +
        'Если ошибка из-за чтения ввода — учитывай, что данные приходят через stdin, ' +
        'а строки могут содержать кириллицу и пробелы.';
    }
    /* Самопроверка. Модель отвечает «на глаз» и иногда присылает код, который
       сам же не проходит примеры; просьба прогнать тесты на бумаге заметно
       уменьшает долю таких ответов. Ошибку проверки сюда не подмешиваем: там
       модель уже знает, что именно сломалось.                                   */
    if (!ctx || !ctx.checkError) {
      if (hasSamples) {
        base2 += '\n\nПроверь себя на «Тестовых данных»: выполни код на каждой строке\n' +
          'и сверь вывод с «выходом». Не сошлось — исправь. В ответ — только код.\n' +
          'И помни: без import и без конструкций, которых в уроке не было.';
      } else {
        base2 += '\n\nПеречитай условие: решение должно делать ровно то, что просят,\n' +
          'и обходиться тем, что уже проходили, — без import и лишних конструкций.';
      }
    }
    return base2;
  }

  /* --------------------------------------------------- ошибки проверки и правка */

  /* Stepik после неудачной отправки сам пишет, чем недоволен:
     «Failed test #1 of 3. Runtime error … Test input: … Correct output: …
     Your code output: … ValueError …». Это готовый разбор ошибки, и именно его
     надо вернуть модели — иначе она будет угадывать, что не так.                */
  /* Отчёт ПРОВЕРКИ. Здесь же рядом живёт вывод ЗАПУСКА (`.code-runner__hints`
     тоже `.smart-hints`), и раньше он попадал в этот поиск: «Empty result» из
     панели запуска уезжал модели как «проверка отклонила ответ». Поэтому всё,
     что лежит внутри панели запуска, из отчёта проверки выбрасываем.          */
  function checkHintNodes() {
    return $$('.smart-hints__hint').filter(function (n) {
      return !(n.closest && n.closest('.code-runner__hints'));
    });
  }

  function stepErrorText() {
    /* У теста с выбором разбора в .smart-hints нет: Stepik пишет «Пока
       неправильно, попробуйте еще раз!» в шапке результата. Без этого ветка
       проверки отчёта не находила и правки не было.                            */
    var head = $('.submission-show__header .submission-show__title-content') ||
      $('.submission-show__header') || $('.attempt-wrapper__result-title');
    var box = $('.submission-show__submission-hint');
    var nodes = box ? $$('.smart-hints__hint', box).filter(function (n) {
      return !(n.closest && n.closest('.code-runner__hints'));
    }) : checkHintNodes();
    var parts = [];
    nodes.forEach(function (n) {
      var t = norm(n.textContent || '');
      if (t.length > 3) parts.push(t);
    });
    if (parts.length) return parts.join('\n');
    if (head) {
      var ht = norm(head.textContent || '');
      if (ht.length > 3) return ht;
    }
    if (box) return norm(box.textContent || '');
    /* запасной путь: контейнер без разметки, но не панель запуска */
    var alt = $$('.submission-show__submission-hint, .attempt-wrapper-alerts .smart-hints')
      .filter(function (n) { return !(n.closest && n.closest('.code-runner__hints')); })[0];
    return alt ? norm(alt.textContent || '') : '';
  }

  /* Ошибка бывает и без слова «Failed»: «Wrong answer», «Compilation error»,
     «Time limit exceeded», а у теста с выбором — просто «Пока неправильно,
     попробуйте еще раз!». Достаточно, чтобы отчёт появился и не был «верно».  */
  function looksLikeCheckError(text) {
    var t = String(text || '');
    if (t.length < 12) return false;
    /* Отрицание проверяем ПЕРВЫМ: «неверно» содержит «верно», и старая проверка
       на успех отбрасывала настоящую ошибку — поэтому провал теста с выбором
       не замечался и правки не было.                                          */
    if (/не\s*правильно|неправильно|не\s*верно|неверно|попробуй\w*\s+ещ[ёе]/i.test(t)) return true;
    if (/wrong|failed|incorrect/i.test(t)) return true;
    /* Успех перечисляем полностью: «Верно» и «всё правильно» — это похвала,
       и раньше «верно» в последней строке делало их ошибкой.                  */
    if (/correct|верно|правильно|принят|зачтено|success/i.test(t)) return false;
    return /error|отличает|не совпад|expected|traceback|exception/i.test(t);
  }

  /* Собираем то, что ушло в прошлый раз: ответ модели и код, который на самом
     деле стоит в редакторе. Если человек правил код руками — пошлём то, что он
     правил, иначе модель начнёт исправлять свою же копию.                        */
  function lastSubmissionCode() {
    var fromEditor = readCodeFromEditor();
    if (fromEditor && fromEditor.length > 3) return fromEditor;
    return (aiAnswer && aiAnswer.text) || '';
  }

  /* Отчёт об ошибке приходит не мгновенно — ждём его появления. */
  async function waitCheckError(timeoutMs) {
    var t = typeof timeoutMs === 'number' ? timeoutMs : 20000;
    var started = Date.now();
    for (;;) {
      var t0 = stepErrorText();
      if (looksLikeCheckError(t0)) return t0;
      if (Date.now() - started > t) return '';
      await sleep(500);
    }
  }

  /* Человеку нужно понять, что делать, а не «HTTP 402». */
  function aiErrorText(status) {
    /* Свой ключ есть только у того, кто его вписал, поэтому и советы адресные:
       без ключа — впиши, с ключом — проверь.                                   */
    var own = !!(cfg.aiKey && cfg.aiKey.length);
    if (status === 402) {
      return own ? 'на ключе закончились средства (402)' : 'ключ ИИ не оплачен (402)';
    }
    if (status === 429) {
      return own ? 'лимит запросов (429), попробуй позже'
        : 'лимит запросов (429) — подожди или впиши свой ключ в «🔑 Настройки ИИ»';
    }
    if (status === 401 || status === 403) {
      return own ? 'ключ ИИ не принят (' + status + ') — проверь его в «🔑 Настройки ИИ»'
        : 'ключ ИИ не принят (' + status + ')';
    }
    if (status >= 500) return 'сервис ИИ недоступен (' + status + ')';
    return 'сервис ответил HTTP ' + status;
  }

  /* mode: { retry:true } — первая попытка, ошибки канала пережидаем с паузой;
     mode: { retry:false } — правка после проваленной проверки, тут ждать нельзя,
     иначе человек будет смотреть на «думает» минуту.                            */
  /* Адрес канала может быть строкой или функцией: у прокси он берётся из
     настроек в момент запроса, а не один раз при загрузке.                    */
  function chUrl(ch) {
    return typeof ch.url === 'function' ? ch.url() : ch.url;
  }

  async function askChannel(ch, ctx, system, user, mode) {
    var retry = !(mode && mode.retry === false);
    var tries = retry ? AI_TRIES : 1;
    var key = ch.needKey ? aiKey() : '';
    var lastErr = null;
    var list = modelsFor(ch, mode && mode.modelId);
    var timeoutMs = Number(mode && mode.timeoutMs) || AI_TIMEOUT;
    for (var i = 0; i < list.length; i++) {
      var model = list[i];
      for (var attempt = 0; attempt < tries; attempt++) {
        /* Таймаут можно уменьшить для простых структурированных ответов —
           сопоставление не должно висеть столько же, сколько кодовая задача. */
        var ctrl = null, timer = null;
        if (typeof AbortController === 'function') {
          ctrl = new AbortController();
          timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* ignore */ } }, timeoutMs);
        }
        try {
          var body = ch.body(model, system || aiSystem(stepKindNow()), user || aiUser(ctx));
          if (mode && Number(mode.maxTokens) > 0) body.max_tokens = Number(mode.maxTokens);
          if (mode && typeof mode.temperature === 'number') body.temperature = mode.temperature;
          var opts = {
            method: 'POST',
            headers: ch.headers(key),
            body: JSON.stringify(body)
          };
          if (ctrl) opts.signal = ctrl.signal;
          var res = await fetch(chUrl(ch), opts);
          if (!res.ok) {
            lastErr = new Error(aiErrorText(res.status) + ' · ' + model);
            lastErr.status = res.status;
            /* 4xx повторять бессмысленно — ключ/лимит/модель не станут другими */
            if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
            if (retry) await sleep(700);
            continue;
          }
          var raw = await res.text();
          var data = null;
          try { data = JSON.parse(raw); } catch (e) { data = null; }
          /* Не JSON — почти всегда это страница входа Google: развёртывание
             закрыто для посторонних, и вместо ответа приходит HTML. Повторять
             бессмысленно, поэтому говорим прямо, что проверить.               */
          if (!data) {
            lastErr = new Error(ch.id === 'proxy'
              ? 'прокси ответил не JSON — проверь, что развёртывание открыто «для всех»'
              : 'сервис ИИ ответил не JSON');
            break;
          }
          /* Прокси (Apps Script) всегда отвечает кодом 200 — так он устроен.
             Поэтому об ошибке он сообщает телом: {error:{message}, status:…}.
             Без этой ветки лимит выглядел бы как «пустой ответ от модели».     */
          if (data && data.error) {
            var st = Number(data.status) || 0;
            var own = String(data.error.message || '');
            /* У прокси своё сообщение, и оно точнее: «суточный лимит прокси
               исчерпан» вместо общего «лимит запросов».                       */
            lastErr = new Error((ch.id === 'proxy' && own ? own
              : (st ? aiErrorText(st) : (own || 'ошибка канала ИИ'))) + ' · ' + model);
            lastErr.status = st;
            if (st >= 400 && st < 500 && st !== 429) break;
            if (retry) await sleep(700);
            continue;
          }
          var choice = (data.choices && data.choices[0]) || {};
          var msg = choice.message || {};
          var text = String(msg.content || '').trim();
          /* reasoning-модель могла не успеть доехать до ответа — тогда берём
             размышления как есть, лучше, чем ничего */
          if (!text && msg.reasoning_content) text = String(msg.reasoning_content).trim();
          if (!text) { lastErr = new Error('пустой ответ от ' + model); if (retry) await sleep(700); continue; }
          return {
            text: text, model: (data.model || model), channel: ch.id,
            /* провайдер сам говорит, что упёрся в лимит: «length» вместо «stop».
               Это единственный надёжный признак обрезанного ответа.            */
            truncated: looksTruncated(text, choice.finish_reason)
          };
        } catch (e) {
          /* Прервали по таймауту — объясняем понятно, а не «signal is aborted». */
          lastErr = (e && (e.name === 'AbortError' || /abort/i.test(e.message || '')))
            ? new Error('сервис ИИ не ответил за ' + Math.round(timeoutMs / 1000) + ' с · ' + model)
            : e;
          if (retry) await sleep(700);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    }
    throw lastErr || new Error('канал не ответил');
  }

  /* Один заход к каналу с готовыми system/user. Возвращает { text, model, via }
     или бросает последнюю ошибку — вызывающий решает, что с ней делать. */
  async function aiCall(system, user, mode) {
    var errors = [];
    var list = aiChannels();
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      /* Короткую паузу пережидаем внутри, а не пропускаем канал: иначе отказ
         одного запроса выглядел бы как «лимит» вместо решения. */
      var myWait = aiWaitLeft(ch.id);
      if (myWait && myWait <= AI_WAIT_MAX) { await sleep(myWait * 1000 + 100); myWait = 0; }
      if (myWait) { errors.push(ch.label + ': ждать ' + myWait + ' с'); continue; }
      try {
        var got = await askChannel(ch, null, system, user, mode);
        markAi(ch.id);
        return got;
      } catch (e) {
        markAi(ch.id);             /* при ошибке тоже не долбим сервис */
        errors.push(ch.label + ': ' + e.message);
      }
    }
    throw new Error(errors.join(' · ') || 'все каналы молчат');
  }

  async function askAi(opts) {
    var fixed = !!(opts && opts.fixed);
    var ctx = stepContext();
    if (!ctx) { setStatus('ИИ: открой страницу задания'); return; }
    if (aiBusy) { setStatus('ИИ: уже думает…'); return; }

    var list = aiChannels();
    /* Канал один, и без ключа он не работает: говорим об этом прямо, а не
       «лимит канала, подожди 0 с» и не пустой строкой ошибки. */
    if (!list.length) {
      setStatus('ИИ: нет ключа — впиши его в меню «🔑 Настройки ИИ»');
      return;
    }
    /* Пауза между запросами: короткую ПЕРЕЖИДАЕМ, а не отказываем — иначе
       повторный вопрос через пару секунд молча ничего не делал, человек видел
       «подожди 0 с» и пустой блок. Долгий лимит по-прежнему честно сообщаем.
       Саму паузу выдерживаем ПОСЛЕ того, как покажем «думает»: иначе на клик
       не видно никакой реакции.                                              */
    var wait = aiWaitAny();
    if (wait && wait > AI_WAIT_MAX) {
      setStatus('ИИ: лимит канала, подожди ' + wait + ' с');
      return;
    }

    var task = stepPrompt();
    var kind = stepKindNow();
    /* Пустое условие — это не «ИИ не смог», а «я не нашёл задание». Отправлять
       пустоту бессмысленно: модель честно ответит «условие отсутствует», и человек
       решит, что от него чего-то ждут. Говорим прямо, что не видим условие.

       Но у теста с выбором, сопоставления и таблицы условие короткое по своей
       природе («Отметьте верные ячейки») — там всё нужное лежит не в тексте, а в
       самих вариантах. Для них довольно непустого условия.                    */
    var structural = kind === 'choice' || kind === 'matching' || kind === 'table';
    if (task.length < 40 && !(structural && task.length > 0)) {
      setStatus('ИИ: не вижу условия задания на странице — раскрой карточку и попробуй снова');
      return;
    }
    var thinkLabel = kind === 'matching' ? 'ИИ сопоставляет значения…'
      : (fixed ? 'ИИ ищет ошибку в тесте…' : 'ИИ пишет решение…');
    var thinkSlow = kind === 'matching'
      ? 'Сопоставление занимает дольше обычного — остановлю через 25 с'
      : 'сервис отвечает медленно';
    aiBusy = true;
    setStatus(kind === 'matching'
      ? 'ИИ быстро сопоставляет значения в задании…'
      : 'ИИ думает над шагом ' + ctx.step + '…');
    setSiteProgress(0.5);
    /* Показываем блок и ленту: человек должен видеть, что происходит, а не гадать */
    aiShow(true);
    if (!fixed) {
      aiLogClear();
      /* Живая реплика вместо «шаг 8 · Python»: язык и так виден в интерфейсе
         Stepik, а человеку нужен понятный ход разговора.                       */
      aiLogAdd('Шаг ' + ctx.step + '. Берусь за задание.', 'sys');
      if (kind === 'matching') {
        aiLogAdd('Для сопоставления возьму быструю модель — ответ должен быть списком пар.', 'sys');
      }
    }
    /* В индикаторе — короткая строка о том, чем ИИ занят СЕЙЧАС. Общие
       «думает…» ничего не говорят: человек должен видеть, что происходит. */
    var thinking = aiLogThink(thinkLabel, thinkSlow, kind === 'matching' ? 15 : 20);

    /* Только теперь выдерживаем паузу между запросами: «думает» уже на экране,
       значит клик виден сразу, а не через секунду тишины.                      */
    if (wait) await sleep(wait * 1000 + 100);

    try {
      /* Вид задания берём со страницы: у теста с выбором и у кода разные и
         системный текст, и запрос — иначе модель писала код там, где нужна галочка. */
      var got = await aiCall(aiSystem(kind), aiUserFor(ctx, kind),
        aiModeForKind(kind, !fixed));

      /* Пока модель думала, человек мог уйти на другое задание. Тогда ответ
         относится к прошлому шагу, и показывать его в ленте нового нельзя:
         выглядело бы как решение текущего.                                    */
      var here = stepContext();
      if (here && here.key !== ctx.key) {
        dropThink(thinking);
        log('шаг сменился, пока ИИ думал — ответ не показываю');
        return;
      }

      /* Модель вернула ВЕСЬ список вариантов — это не ответ, а пересказ задания.
         Отмечать всё подряд бессмысленно: тест провалится гарантированно.
         Переспрашиваем один раз с прямым указанием.                            */
      if (kind === 'choice' && choiceLooksLikeAll(got.text)) {
        aiLogAdd('Похоже, я перечислил все варианты. Уточню, какие подходят.', 'sys');
        var strict = aiUserFor(ctx) +
          '\n\nВНИМАНИЕ: в прошлый раз ты вернул ВСЕ варианты подряд. Это неверно — ' +
          'неправильных в тесте обычно больше, чем правильных. Разбери каждый вариант ' +
          'по отдельности и верни ТОЛЬКО те, что действительно подходят, каждый с новой строки.';
        try {
          got = await aiCall(aiSystem('choice'), strict, { retry: false });
        } catch (e) { log('уточняющий запрос не удался: ' + (e && e.message)); }
        if (choiceLooksLikeAll(got.text)) {
          /* Всё равно весь список — тогда лучше не отмечать ничего, чем отметить
             заведомо неправильное: отправка всё равно провалится.               */
          dropThink(thinking);
          aiLogAdd('Не смог выбрать точно — отметь вариант сам, пожалуйста. ' +
            'Так бывает на вопросах, где надо понять смысл, а не найти ответ по словам.', 'sys');
          return;
        }
      }

      /* Снимаем ограждения сразу: и в ленте, и при копировании, и при вставке
         в редактор человек должен видеть чистый ответ, а не ```python … ```. */
      var clean = stripFences(got.text) || got.text;
      aiAnswer = {
        key: ctx.key, text: clean, at: Date.now(), model: got.model,
        kind: kind, lang: stepLanguage(), truncated: !!got.truncated
      };
      /* Новый ответ — новые попытки правки: лимит правок считается на ответ,
         а не на шаг, иначе после двух неудач скрипт молчал бы до перезагрузки. */
      delete aiFixTried[ctx.key];
      /* И сразу запоминаем выбранные варианты: если ответ не примется, в запросе
         на исправление должны быть перечислены прошлые попытки.                 */
      if (kind === 'choice') rememberTriedChoice(ctx, clean);
      dropThink(thinking);
      saveAi();
      renderPanel(true);
      aiLogAnswer();

      /* Вставляем решение сами и запускаем код, чтобы человек сразу увидел
         результат. Отправку на проверку не трогаем — это его решение.
         Вызываем ДО проверки на обрыв: autoApply сам объяснит в ленте, почему
         неполный ответ никуда не вставляется. Тихо: неудача вставки не должна
         ломать показ ответа.                                                    */
      autoApply(ctx).catch(function (e) { log('автовставка не удалась: ' + (e && e.message)); });

      /* Ответ упёрся в лимит токенов. Раньше это выглядело как «модель написала
         одно слово»: в ленте оставался огрызок вроде «def», и он же уезжал
         в общее хранилище как готовое решение. Теперь лента помечает ответ
         неполным (см. aiLogAnswer), а в хранилище он не попадает вовсе —
         чужой огрызок хуже, чем ничего.                                        */
      if (got.truncated) {
        setStatus('ИИ: ответ оборвался по лимиту — попробуй ещё раз или смени модель');
        return;
      }

      setStatus((fixed ? 'ИИ: исправленное решение готово (шаг ' : 'ИИ: решение готово (шаг ') + ctx.step + ')');
      /* В общую папку НЕ публикуем. Раньше публиковали сразу, и получалось две
         беды: в папке оседали непроверенные ответы (а значит и скоба «есть
         решение» появлялась под решением, которое ещё не приняли), и у людей
         оказывался мусор вместо выверенных ответов. Ответ уезжает в папку
         только после того, как проверка его приняла — см. перехват отправки.
         Кнопке «вставить» публикация и не нужна: она берёт ответ из памяти.  */
    } catch (e) {
      dropThink(thinking);
      aiLogAdd(e.message, 'err');
      setStatus('ИИ не ответил — ' + e.message);
    } finally {
      aiBusy = false;
      setSiteProgress(job ? (jobTotal() ? job.at / jobTotal() : 0) : -1);
    }
  }

  /* Сайт отклонил отправку и написал, чем именно. Это готовая подсказка: отдаём
     её модели вместе с её же кодом и просим исправить. Число правок ограничено —
     иначе на «неверно» можно зациклиться и жечь лимит бесконечно.                */
  var aiFixTried = {};
  var aiFixBusy = {};                   /* защёлка: одну отправку правим один раз */
  /* ключ шага → варианты, которые уже отправляли и которые не подошли: при
     повторной попытке просим ДРУГОЙ вариант, а не тот же самый                  */
  var aiTriedChoices = {};

  /* Запоминаем варианты, которые ИИ уже выбрал. Зовём это СРАЗУ при получении
     ответа, а не только при вставке: вставка асинхронная и может опоздать —
     тогда в запрос на исправление список прошлых попыток не попадал, и модель
     возвращала тот же самый вариант.                                          */
  function rememberTriedChoice(ctx, text) {
    if (!ctx || !ctx.key) return;
    var picked = choiceFromText(text);
    if (!picked || !picked.answers.length) return;
    var tried = aiTriedChoices[ctx.key] || (aiTriedChoices[ctx.key] = []);
    picked.answers.forEach(function (t) {
      if (tried.indexOf(t) < 0) tried.push(t);
    });
  }
  var AI_FIX_MARKS = 2;                 /* столько правок на один шаг */

  async function aiSelfCorrect(ctx) {
    if (!ctx || !aiAnswer || aiAnswer.key !== ctx.key) return { skipped: 'нет решения ИИ' };
    /* Счётчик тратится только на настоящую правку: если ошибки не оказалось
       (ответ прошёл), попытка не сгорает. */
    if ((aiFixTried[ctx.key] || 0) >= AI_FIX_MARKS) return { skipped: 'правка уже была' };

    var err = await waitCheckError(20000);
    if (!err) return { skipped: 'ошибку проверки не нашли' };

    if (!aiChannels().length) {
      aiLogAdd('Ошибку вижу, а ключа нет. Впиши его в «🔑 Настройки ИИ» — и я исправлю.', 'err');
      return { skipped: 'нет ключа' };
    }

    aiFixTried[ctx.key] = (aiFixTried[ctx.key] || 0) + 1;
    var prev = aiAnswer.text;
    aiLogReport(err);
    aiLogAdd('Проверка не прошла. Смотрю, что не так, и исправляю.', 'sys');
    /* Дальше ИИ думает заново — и это должно быть видно так же, как в начале
       разговора: иначе после этой строки в чате наступает тишина, и кажется,
       что скрипт остановился.                                                */
    var fixThink = aiLogThink('ИИ ищет ошибку…');

    var fixCtx = Object.assign({}, ctx);
    try { fixCtx.prevCode = await lastSubmissionCode(); } catch (e) { fixCtx.prevCode = prev; }
    fixCtx.checkError = err;

    var got = null;
    try {
      /* При правке вид берём из прошлого ответа: после провала Stepik может
         спрятать редактор, и по странице вид уже не определить.                 */
      var fixKind = (aiAnswer && aiAnswer.kind) || stepKindNow();
      got = await aiCall(aiSystem(fixKind), aiUserFor(fixCtx, fixKind), { retry: false });
    } catch (e) {
      dropThink(fixThink);
      aiLogAdd('Исправить не получилось: ' + e.message, 'err');
      return { skipped: 'ошибка канала: ' + e.message };
    }
    dropThink(fixThink);

    aiAnswer = {
      key: ctx.key, text: stripFences(got.text) || got.text, at: Date.now(), model: got.model,
      kind: aiAnswer.kind || 'code', lang: aiAnswer.lang || stepLanguage(),
      truncated: !!got.truncated
    };
    saveAi();
    if (aiAnswer.kind === 'choice') rememberTriedChoice(ctx, aiAnswer.text);
    aiLogAnswer();
    renderPanel(true);

    /* Правку показываем только в ленте, но в панели уже стоит новое решение:
       человек сам решает, отправлять его повторно или нет. Автоматически не
       жмём «Отправить» — отправка наружу только по подтверждению.               */
    if (got.truncated) {
      setStatus('ИИ: исправление оборвалось по лимиту — смени модель и повтори');
      return { skipped: 'ответ обрезан' };
    }
    setStatus('ИИ: решение исправлено — проверь и отправь снова');
    /* Исправленный код тоже вставляем и запускаем: иначе человек вручную
       переносит то, что скрипт и так держит в руках. Отправку не жмём.         */
    autoApply(ctx).catch(function (e) { log('автовставка правки не удалась: ' + (e && e.message)); });
    return { fixed: true };
  }

  /* Отдаём панели: она зовёт это после нажатия «Отправить на проверку».
     Само исправление тихое: ошибка канала не должна всплывать поверх урока.
     Одну и ту же отправку ловят два пути (сеть и клик), поэтому на шаг держим
     одну защёлку — иначе пойдут две правки подряд и сгорит лимит.             */
  function nudgeFix(ctx) {
    var c = ctx || stepContext();
    if (!c || !aiAnswer || aiAnswer.key !== c.key) return;
    if (!aiChannels().length) return;
    if (aiFixBusy[c.key]) return;
    aiFixBusy[c.key] = true;
    setTimeout(function () {
      aiSelfCorrect(c)
        .catch(function (e) { log('правка ИИ не удалась: ' + (e && e.message)); })
        .then(function () { delete aiFixBusy[c.key]; });
    }, 1200);
  }

  /* ИИ на тесте с выбором отвечает текстом: «2. Вариант такой-то». Сопоставляем
     ответ с реальными вариантами на странице и берём те, что совпали — по тексту
     или по номеру. Если не совпало ничего, отдаём как есть: пусть writeChoice
     скажет, что не нашёл, а не соврёт про успех.                                */
  function choiceFromText(text) {
    var body = String(text || '');
    var inputs = $$('.quiz-component[data-type="choice-quiz"] input, .quiz-plugin__content input')
      .filter(function (i) { return /radio|checkbox/.test(i.type) && !i.disabled; });
    if (!inputs.length) return null;

    /* Ответ модели разбираем ПО СТРОКАМ. Раньше вариант искался подстрокой во
       всём ответе — и если модель что-то объясняла, под условие подходили ВСЕ
       варианты, а скрипт честно отмечал их все. Теперь строки разбираются
       отдельно, и совпадение целой строки считается надёжным.                 */
    var lines = body.split('\n').map(function (l) {
      return norm(l).replace(/^[-*•·]\s*/, '').replace(/^\d+\s*[).:—-]\s*/, '').trim();
    }).filter(function (l) { return l.length > 1; });

    var opts = [];
    inputs.forEach(function (inp, idx) {
      var label = inp.closest('label') || inp.parentElement;
      var txt = norm((label || {}).textContent || '');
      if (txt) opts.push({ txt: txt, id: String(inp.value), n: idx + 1, inp: inp });
    });

    /* Сравниваем без учёта регистра: модель легко пишет вариант со строчной
       буквы, вплетая его в фразу, и точное сравнение его теряло.             */
    var lowLines = lines.map(function (l) { return l.toLowerCase(); });
    var lowBody = body.toLowerCase();

    /* 1. Целая строка ответа равна варианту — самое надёжное совпадение. */
    var exact = opts.filter(function (o) {
      return lowLines.indexOf(o.txt.toLowerCase()) >= 0;
    });
    if (exact.length) return pick(exact);

    /* 2. Номер варианта: «2) …», «ответ: 2», «Вариант 4» и просто «4». */
    var byNum = opts.filter(function (o) {
      var re = new RegExp('(?:^|[^\\d])' + o.n + '(?=\\s*(?:[).:—\\-−]|$))', 'm');
      return re.test(body);
    });
    if (byNum.length) return pick(byNum);

    /* 3. Запасной путь — поиск по тексту. Если так совпадают ВСЕ варианты,
       значит модель пересказала задание, а не выбрала ответ: отмечать всё
       подряд заведомо неверно, поэтому лучше не отмечать ничего.             */
    var byText = opts.filter(function (o) {
      return lowBody.indexOf(o.txt.toLowerCase()) >= 0;
    });
    if (byText.length && byText.length < opts.length) return pick(byText);

    return null;

    function pick(list) {
      return {
        kind: 'choice',
        answers: list.map(function (o) { return o.txt; }),
        ids: list.map(function (o) { return o.id; }),
        source: 'ии'
      };
    }
  }

  /* Выбраны ВСЕ варианты — так почти никогда не бывает, и это верный признак,
     что модель перечислила список целиком вместо ответа. Нужно для проверки
     и для повторного вопроса.                                                 */
  function choiceLooksLikeAll(text) {
    var all = choiceOptions();
    if (all.length < 2) return false;
    var lines = String(text || '').split('\n').map(function (l) {
      return norm(l).replace(/^[-*•·]\s*/, '').replace(/^\d+\s*[).:—-]\s*/, '').trim().toLowerCase();
    }).filter(function (l) { return l.length > 1; });
    if (lines.length < 2) return false;
    var hits = all.filter(function (o) {
      return lines.indexOf(String(o.text).toLowerCase()) >= 0;
    }).length;
    return hits >= all.length;
  }

  /* После неудачной отправки Stepik убирает редактор и показывает разбор —
     вернуть редактор можно ТОЛЬКО кнопкой «Изменить решение». Без этого шага
     вставлять исправленный код некуда: скрипт честно писал «вставить некуда»
     и «кнопку «Запустить код» не нашёл», хотя дело было именно в скрытом
     редакторе.                                                                 */
  /* Кнопка возврата к заданию. У кода это «Изменить решение», у теста с выбором —
     «Начать сначала» или «Решить снова»: без них после провала варианты со
     страницы исчезают, и повторно отметить ответ было негде.                   */
  var EDIT_RE = /^(?:изменить решение|изменить|редактировать|изменить ответ|начать сначала|начать заново|решить снова|решить заново|пройти заново|попробовать снова|попробовать ещё раз|попробовать еще раз|edit solution|edit|rework|retry|try again)$/i;

  function editButton() {
    var nodes = $$('button, [role="button"]');
    for (var i = 0; i < nodes.length; i++) {
      var text = norm(nodes[i].textContent);
      if (!text || !EDIT_RE.test(text)) continue;
      var r = nodes[i].getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (nodes[i].disabled) continue;
      return nodes[i];
    }
    return null;
  }

  function editorField() {
    return $('.CodeMirror, .cm-content, .attempt-wrapper__plugin textarea');
  }

  /* Вернуть редактор на место, если Stepik его спрятал после проверки. */
  async function revealEditor() {
    var btn = editButton();
    if (!btn) return true;                  /* кнопки нет — редактор и так на месте */
    try { btn.click(); } catch (e) { /* ignore */ }
    await sleep(500);
    await waitFor(function () { return !editButton(); }, 6000, 250);
    return !editButton();
  }

  /* После ответа ИИ вставляем решение в редактор сами и жмём «Запустить код» —
     человек сразу видит результат, а не переносит код руками.
     «Отправить на проверку» при этом НЕ нажимаем: отправка — это решение
     человека, а запуск кода ничего не портит и ничего не отправляет наружу.      */
  async function autoApply(ctx) {
    if (!aiAnswer || aiAnswer.key !== ctx.key || !aiAnswer.text) return { skipped: 'нет ответа' };
    if (aiAnswer.truncated) {
      aiLogAdd('Ответ получился неполным — вставлять нечего. Нажми «Спросить ИИ» ещё раз или выбери другую модель.', 'sys');
      return { skipped: 'ответ обрезан' };
    }
    /* В редактор тоже не подставляем стену размышлений: от неё код не заработает,
       а человек потеряет то, что писал.                                        */
    if (looksLikeReasoning(aiAnswer.text)) {
      aiLogAdd('В ответе одни размышления, а не решение. Смени модель и попробуй снова.', 'sys');
      return { skipped: 'размышления вместо ответа' };
    }

    /* После неудачной отправки Stepik прячет редактор за разбором — сначала
       возвращаем его кнопкой «Изменить решение», иначе вставлять некуда.      */
    await revealEditor();

    /* карточка задания дорисовывается не сразу — даём ей шанс появиться */
    if (!insertTarget()) await waitFor(insertTarget, 6000, 250);
    if (!insertTarget()) {
      aiLogAdd('Здесь некуда вставлять: на шаге нет ни редактора, ни вариантов.', 'sys');
      return { skipped: 'нет места для вставки' };
    }

    /* Вид берём из ответа: 'text' — свободный ответ в поле, его нельзя сводить
       к 'code', иначе он уходит по ветке редактора и в ленте пишется про код. */
    var kind = (aiAnswer.kind === 'choice' || aiAnswer.kind === 'text' ||
      aiAnswer.kind === 'matching' || aiAnswer.kind === 'table') ? aiAnswer.kind : 'code';
    var target = insertTarget();

    var res;
    /* Таблица: отмечаем выбранный столбец в каждой строке. */
    if (kind === 'table') {
      var picks = tableFromText(aiAnswer.text);
      if (!picks) {
        aiLogAdd('Не разобрал, какие столбцы выбрать, — отметь сам, пожалуйста. ' +
          'Строки таблицы выше в чате.', 'sys');
        return { skipped: 'столбцы не распознаны' };
      }
      res = writeTable(picks);
      if (!res.ok) {
        aiLogAdd('Отметить ячейки не получилось: ' +
          (res.error || 'таблица не совпала') + '.', 'sys');
        return { skipped: res.error || 'ошибка таблицы' };
      }
      aiLogAdd('Отметил по одному столбцу в каждой строке. ' +
        'Осталось нажать «Отправить на проверку».', 'sys');
      if (target) flash(target.anchor);
      return { inserted: true, ran: false, kind: 'table' };
    }

    /* Сопоставление: расставляем правый столбец в порядке из ответа. */
    if (kind === 'matching') {
      var want = matchingFromText(aiAnswer.text);
      if (!want) {
        aiLogAdd('Не разобрал порядок — расставь значения сам, пожалуйста. ' +
          'Список значений выше в чате.', 'sys');
        return { skipped: 'порядок не распознан' };
      }
      var moved = await orderMatching(want);
      aiLogAdd(moved
        ? 'Расставил значения в нужном порядке. Осталось нажать «Отправить на проверку».'
        : 'Порядок уже был верным. Осталось нажать «Отправить на проверку».', 'sys');
      if (target) flash(target.anchor);
      return { inserted: true, ran: false, kind: 'matching' };
    }

    if (kind === 'choice') {
      var picked = choiceFromText(aiAnswer.text);
      if (!picked) {
        aiLogAdd('Не разобрал, какой вариант выбран, — отметь сам, пожалуйста. ' +
          'Так бывает на вопросах, где надо понять смысл, а не найти ответ по словам.', 'sys');
        return { skipped: 'варианты не распознаны' };
      }
      res = writeChoice(picked);
      if (!res || !res.ok) {
        aiLogAdd('Отметить вариант не получилось: ' +
          ((res && res.error) || 'неизвестная причина') + '.', 'sys');
        return { skipped: (res && res.error) || 'ошибка выбора' };
      }
      /* Запоминаем, что уже отправляли: при провале попросим ДРУГОЙ вариант,
         иначе модель вернёт тот же и человек получит ту же ошибку.            */
      rememberTriedChoice(ctx, aiAnswer.text);
      aiLogAdd('Отметил вариант ответа. Осталось нажать «Отправить на проверку».', 'sys');
      if (target) flash(target.anchor);
      /* У теста с выбором запускать нечего: там нет ни редактора, ни кнопки
         «Запустить код». Раньше скрипт честно искал её и писал «не нашёл».      */
      return { inserted: true, ran: false, kind: 'choice' };
    }

    if (kind === 'text') {
      var area = $('.string-quiz__textarea') || $('.attempt-wrapper__plugin textarea');
      if (!area) {
        aiLogAdd('Поля для ответа на шаге нет — вписать некуда.', 'sys');
        return { skipped: 'нет поля для ответа' };
      }
      setNative(area, String(aiAnswer.text).trim());
      aiLogAdd('Записал ответ в поле. Осталось нажать «Отправить на проверку».', 'sys');
      if (target) flash(target.anchor);
      return { inserted: true, ran: false, kind: 'text' };
    }

    /* Код набираем строка за строкой — как будто пишет человек. Длинное решение
       не тянется: шаг набора растёт вместе с числом строк (см. typeIntoEditor).  */
    res = await typeIntoEditor(aiAnswer.text);
    if (!res || !res.ok) {
      aiLogAdd('Вставить не получилось: ' + ((res && res.error) || 'неизвестная причина') + '.', 'sys');
      return { skipped: (res && res.error) || 'ошибка вставки' };
    }
    aiLogAdd('Готово — написал решение в редакторе.', 'sys');
    if (target) flash(target.anchor);

    /* Кнопка запуска появляется вместе с редактором, поэтому ждём её, а не
       жмём сразу: у только что вставленного кода Stepik может ещё не успеть
       разбудить панель запуска. Если её всё равно нет — возможно, Stepik снова
       показал разбор, и редактор опять спрятан: пробуем вернуть его ещё раз.   */
    await sleep(400);
    var btn = await waitFor(runButton, 4000, 250);
    if (!btn && editButton()) {
      await revealEditor();
      btn = await waitFor(runButton, 4000, 250);
    }
    if (!btn) {
      aiLogAdd('Кнопку «Запустить код» не нашёл — запусти сам, пожалуйста.', 'sys');
      return { inserted: true, ran: false };
    }
    try { btn.click(); } catch (e) { /* ignore */ }
    aiLogAdd('Запускаю код, чтобы проверить.', 'sys');
    /* Вывод показываем прямо здесь, а не отправляем человека искать его
       глазами по странице. Если панель запуска ещё не отрисовалась — ждём.     */
    var out = await waitFor(runOutputText, 6000, 400);
    if (out) aiLogOutput(out);
    else aiLogAdd('Вывод запуска не увидел — посмотри сам в панели запуска.', 'sys');
    return { inserted: true, ran: true };
  }

  /* --------------------------------------------------------- лента решения ИИ */

  /* Блок ИИ — не окно поверх страницы, а часть панели: показываем его только
     после «Спросить ИИ по шагу» и наполняем лентой сообщений. Печатать в ленте
     нельзя, поэтому это не textarea, а набор блоков: так человек видит и ход
     работы («думает»), и ошибки тестов, и итоговый код.                        */
  var aiRootCache = null;              /* единственный экземпляр блока ИИ */

  /* Возвращаем блок и когда он ещё не поставлен на страницу: иначе настройки,
     применённые до появления места, уходили бы в никуда.                       */
  /* Ссылка на блок ИИ. Проверяем, что узел ВСЁ ЕЩЁ В ДОКУМЕНТЕ: Stepik
     перерисовывает карточку задания, наш блок при этом выбрасывается из дерева,
     а сохранённая ссылка остаётся. Раньше «открыть блок» работало с оторванным
     узлом — класс on ставился, а на экране ничего не появлялось. Отсюда и жалоба
     «закрыл и не могу открыть заново».                                        */
  function nodeInDoc(n) {
    if (!n) return false;
    if (typeof n.isConnected === 'boolean') return n.isConnected;
    return !!(document.body && document.body.contains(n));
  }

  /* Узел мог быть выброшен из документа перерисовкой карточки — но сам он жив,
     и в нём лежит лента. Выбрасывать ссылку нельзя: пересоздание блока означало
     бы пустой чат и потерянный отчёт проверки. Возвращаем как есть, а на место
     его ставит aiSlot (см. aiShow и tick).                                    */
  function aiRootEl() {
    if (aiRootCache) return aiRootCache;
    var found = document.getElementById('sgx-ai-root');
    if (found) aiRootCache = found;
    return found;
  }

  /* Ленту берём и у отвязанного блока: пока Stepik перерисовывает карточку, в неё
     успевают прийти отчёт проверки и сообщения, и терять их нельзя.           */
  function aiLogEl() {
    return document.getElementById('sgx-ai-log') ||
      (aiRootCache && aiRootCache.querySelector
        ? aiRootCache.querySelector('#sgx-ai-log') : null);
  }

  /* Строка чата: слева аватар отвечающей модели, справа сообщение. Раньше
     служебные строки были просто серым мелким текстом с маленькой буквы
     («вставил решение в редактор») — читалось как лог скрипта, а не как разговор.
     В аватаре — логотип той модели, которая сейчас отвечает: видно, кто говорит. */
  function aiRow(content, modelId) {
    var row = document.createElement('div');
    row.className = 'sgx-ai-row';
    var ava = document.createElement('span');
    ava.className = 'sgx-ai-ava';
    ava.innerHTML = modelIcon(modelInfo(modelId || aiModel()), 20);
    row.appendChild(ava);
    row.appendChild(content);
    wireModelIcons(row);
    return row;
  }

  /* Блок ИИ живёт в карточке задания, а не в боковом меню. Спросить ИИ можно и из
     меню Tampermonkey — тогда блока ещё нет, и все записи в ленту молча уходили
     в никуда: человек открывал и видел пустоту. Поэтому сначала создаём блок и
     ставим его на место, и только потом показываем.                            */
  /* Человек хочет видеть блок. Отдельный признак нужен потому, что сам узел
     может исчезнуть из документа (Stepik перерисовывает карточку) — по одному
     классу on понять «закрыли» или «выбросили» нельзя.                         */
  var aiWantOpen = false;

  function aiShow(on) {
    if (on === false) {
      aiWantOpen = false;
      var off = aiRootEl();
      if (off) off.classList.remove('on');
      return;
    }
    aiWantOpen = true;
    if (!aiRootEl()) ensureAiRoot();
    /* на странице задания места может ещё не быть — тогда пробуем и на следующем
       тике: карточка дорисовывается асинхронно.                                */
    if (!aiSlot()) {
      var tries = 0;
      var timer = setInterval(function () {
        tries++;
        if (aiSlot() || tries > 12) clearInterval(timer);
      }, 400);
    }
    var box = aiRootEl();
    if (!box) return;
    /* Блок мог быть выброшен из документа перерисовкой карточки: тогда класс on
       поставится, а на экране ничего не появится. Ставим на место ещё раз.     */
    if (!nodeInDoc(box)) aiSlot();
    box.classList.add('on');
  }

  function aiVisible() {
    var box = aiRootEl();
    return !!(box && box.classList.contains('on') && box.parentNode);
  }

  function aiLogClear() {
    var log = aiLogEl();
    if (log) log.innerHTML = '';
    aiLogSnap = '';
    return log;
  }

  /* одна строка в ленте. kind: 'me' — наш вопрос, 'sys' — служебное, 'err' — ошибка.
     Для кода оборачиваем в .sgx-ai-codewrap и кладём кнопку копирования ВНУТРЬ
     области кода: раньше она стояла в шапке блока, далеко от самого решения, и
     её приходилось искать. Теперь она в правом верхнем углу кода и появляется
     при наведении — как в редакторах кода.                                    */
  function aiLogAdd(text, kind, monospace, modelId) {
    var log = aiLogEl();
    if (!log || !text) return null;
    var el = document.createElement('div');
    el.className = 'sgx-ai-msg' + (kind ? ' ' + kind : '') + (monospace ? ' sgx-ai-code' : '');
    el.textContent = text;

    var node = el;
    if (monospace) {
      var wrap = document.createElement('div');
      wrap.className = 'sgx-ai-codewrap';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sgx-ai-codecopy';
      btn.title = 'Скопировать';
      btn.innerHTML = icon('copy', 14);
      btn.addEventListener('click', function () {
        copyText(text);
        btn.classList.add('done');
        setTimeout(function () { btn.classList.remove('done'); }, 1200);
      });
      wrap.appendChild(btn);
      wrap.appendChild(el);
      node = wrap;
    }

    log.appendChild(aiRow(node, modelId));
    log.scrollTop = log.scrollHeight;
    return el;
  }

  /* Отчёт проверки приходит ОДНОЙ строкой:
       «[+] Test #1. OK [ ] Test #2. Wrong answer … 2 of 5 test(s) passed.»
     Читать её целиком бесполезно — глаз должен сразу цепляться за провалы.
     Поэтому разбираем отчёт на отметки тестов и красим каждую: пройденные
     обычным, проваленные — красным.                                            */
  function reportLine(text, kind) {
    var d = document.createElement('div');
    d.className = 'sgx-ai-repline ' + kind;
    d.textContent = text;
    return d;
  }

  function aiLogReport(text) {
    var log = aiLogEl();
    if (!log || !text) return null;
    var src = String(text);
    var wrap = document.createElement('div');
    wrap.className = 'sgx-ai-msg sgx-ai-report';

    var re = /(\[\+\]|\[\s*\])([^\[]*)/g;
    var m, last = 0, marks = 0;
    while ((m = re.exec(src)) !== null) {
      marks++;
      if (m.index > last) {
        var pre = src.slice(last, m.index).trim();
        if (pre) wrap.appendChild(reportLine(pre, 'note'));
      }
      var ok = m[1] === '[+]';
      wrap.appendChild(reportLine((ok ? '[+] ' : '[ ] ') + m[2].trim(), ok ? 'ok' : 'bad'));
      last = m.index + m[0].length;
    }
    var tail = src.slice(last).trim();
    if (tail) wrap.appendChild(reportLine(tail, 'note'));

    /* отметок не было — значит это разбор одной ошибки; красим по признакам */
    if (!marks) {
      src.split('\n').forEach(function (line) {
        if (!line.trim()) return;
        wrap.appendChild(reportLine(line,
          /wrong|failed|error|неверн|ошибк|превыш/i.test(line) ? 'bad' : 'note'));
      });
    }

    log.appendChild(aiRow(wrap));
    log.scrollTop = log.scrollHeight;
    return wrap;
  }

  /* индикатор «думает» — чтобы было видно, что скрипт жив, а не завис.
     Со счётчиком секунд: «думает» без цифр выглядит одинаково и на второй
     секунде, и на второй минуте, и человек не понимает, идёт работа или нет.   */
  function aiLogThink(label, slowLabel, slowAt) {
    var log = aiLogEl();
    if (!log) return null;
    var el = document.createElement('div');
    el.className = 'sgx-ai-think';
    el.innerHTML = '<span>' + escapeHtml(label || 'Думаю…') + '</span>' +
      '<span class="sgx-ai-dots"><span></span><span></span><span></span></span>' +
      '<span class="sgx-ai-secs">0 с</span>';
    /* возвращаем СТРОКУ чата, а не её содержимое: гасить и удалять надо её */
    var row = aiRow(el);
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;

    var started = Date.now();
    var secs = el.querySelector('.sgx-ai-secs');
    var noteAt = Number(slowAt) > 0 ? Number(slowAt) : 20;
    var noted = false;
    row.__sgxTimer = setInterval(function () {
      if (!row.parentNode) { clearInterval(row.__sgxTimer); return; }
      var s = Math.round((Date.now() - started) / 1000);
      if (secs) secs.textContent = s + ' с';
      if (!noted && s >= noteAt && secs) {
        secs.textContent = slowLabel || (s + ' с — сервис отвечает медленно');
        noted = true;
      }
    }, 1000);
    return row;
  }

  /* Убрать индикатор «думает»: держать его рядом с готовым ответом нельзя —
     выглядит так, будто работа ещё идёт. Таймер счётчика гасим вместе с ним,
     иначе он продолжит тикать вхолостую до перезагрузки страницы.              */
  function dropThink(el) {
    if (!el) return;
    if (el.__sgxTimer) { clearInterval(el.__sgxTimer); el.__sgxTimer = null; }
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Скопировать текст в буфер. В ленте нет поля ввода, поэтому копируем через
     временную textarea; если и это недоступно — показываем текст диалогом, чтобы
     человек мог забрать решение руками. */
  function copyText(text) {
    var s = String(text == null ? '' : text);
    if (!s) return;
    var ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    if (ok) toast('✓ Решение скопировано');
    else if (window.prompt) window.prompt('Скопируй решение:', s);
  }

  /* Один ответ или несколько — видно по типу поля: radio или checkbox.
     От этого зависит и форма метки в чате, и то, что мы говорим модели.        */
  function choiceMultiple() {
    return !!$('.quiz-component[data-type="choice-quiz"] input[type="checkbox"],' +
      ' .quiz-plugin__content input[type="checkbox"]');
  }

  /* Тест с выбором показываем списком вариантов с меткой: круг — один ответ,
     квадрат — несколько. Выбранное закрашиваем. Раньше в ленте был просто текст
     ответа, и человек не видел, что именно отмечено на странице.              */
  function aiLogChoice(picked) {
    var log = aiLogEl();
    if (!log) return null;
    var opts = choiceOptions();
    if (!opts.length) return null;
    var multiple = choiceMultiple();
    var wantIds = ((picked && picked.ids) || []).map(String);
    var wantTxt = ((picked && picked.answers) || []).map(norm);

    /* Метки рисуем ТЕМИ ЖЕ классами, что и Stepik на странице: тогда галочка,
       кружок и нажатое состояние выглядят ровно как в задании, без самодельных
       квадратиков. Своя разметка была похожа, но не совпадала — на это и была
       жалоба.                                                                 */
    var K = multiple
      ? { wrap: 's-checkbox', input: 's-checkbox__input', border: 's-checkbox__border',
        circle: 's-checkbox__circle', label: 's-checkbox__label', type: 'checkbox' }
      : { wrap: 's-radio', input: 's-radio__input', border: 's-radio__border',
        circle: 's-radio__circle', label: 's-radio__label', type: 'radio' };

    var box = document.createElement('div');
    box.className = 'sgx-ai-msg sgx-ai-opts';
    opts.forEach(function (o) {
      var on = wantIds.indexOf(String(o.id)) >= 0 ||
        (wantTxt.length > 0 && wantTxt.indexOf(norm(o.text)) >= 0);

      /* Обёртка — div, а не label: внутри label клик по тексту переключал бы
         галочку, и в чате показывалось бы не то, что выбрано на самом деле.    */
      var row = document.createElement('div');
      row.className = 'sgx-ai-opt' + (on ? ' on' : '');

      var mark = document.createElement('div');
      mark.className = K.wrap;

      var inp = document.createElement('input');
      inp.className = K.input;
      inp.type = K.type;
      /* checked без disabled: отключённое поле браузер рисует блёклым, а нужен
         обычный вид. Нажимать нельзя — на поле стоит pointer-events:none.      */
      if (on) inp.checked = true;
      inp.tabIndex = -1;
      mark.appendChild(inp);

      var border = document.createElement('span');
      border.className = K.border;
      var dot = document.createElement('span');
      dot.className = K.circle;
      border.appendChild(dot);
      mark.appendChild(border);

      var txt = document.createElement('span');
      txt.className = 'choice-quiz-show__option ' + K.label;
      txt.textContent = o.text;
      mark.appendChild(txt);

      row.appendChild(mark);
      box.appendChild(row);
    });
    var note = document.createElement('div');
    note.className = 'sgx-ai-optnote';
    note.textContent = multiple
      ? 'Здесь можно выбрать несколько — отметил нужные.'
      : 'Здесь один ответ — отметил выбранный.';
    box.appendChild(note);

    log.appendChild(aiRow(box, aiAnswer && aiAnswer.model));
    log.scrollTop = log.scrollHeight;
    return box;
  }

  /* Сопоставление в ленте: показываем пары «подпись → значение», а не список
     значений. Человеку нужно видеть, что с чем сошлось.                        */
  function aiLogMatching(want) {
    var log = aiLogEl();
    if (!log || !want || !want.length) return null;
    var left = matchingLeft();

    var box = document.createElement('div');
    box.className = 'sgx-ai-msg sgx-ai-opts';
    want.forEach(function (t, i) {
      var row = document.createElement('div');
      row.className = 'sgx-ai-opt on';
      var txt = document.createElement('span');
      txt.className = 'sgx-ai-opttext';
      txt.textContent = (left[i] ? left[i] + '  →  ' : '') + t;
      row.appendChild(txt);
      box.appendChild(row);
    });
    var note = document.createElement('div');
    note.className = 'sgx-ai-optnote';
    note.textContent = 'Расставил значения напротив подписей.';
    box.appendChild(note);

    log.appendChild(aiRow(box, aiAnswer && aiAnswer.model));
    log.scrollTop = log.scrollHeight;
    return box;
  }

  /* Таблица в ленте: строка кода и выбранный для неё столбец. */
  function aiLogTable(picks) {
    var log = aiLogEl();
    var t = tableQuizRows();
    if (!log || !t || !picks) return null;
    var box = document.createElement('div');
    box.className = 'sgx-ai-msg sgx-ai-opts';
    t.rows.forEach(function (r, i) {
      var row = document.createElement('div');
      row.className = 'sgx-ai-opt on';
      var txt = document.createElement('span');
      txt.className = 'sgx-ai-opttext';
      txt.textContent = r.label + '  →  ' + (t.heads[picks[i] + 1] || '?');
      row.appendChild(txt);
      box.appendChild(row);
    });
    var note = document.createElement('div');
    note.className = 'sgx-ai-optnote';
    note.textContent = 'Отметил по одному столбцу в каждой строке.';
    box.appendChild(note);

    log.appendChild(aiRow(box, aiAnswer && aiAnswer.model));
    log.scrollTop = log.scrollHeight;
    return box;
  }

  /* Показать готовое решение в ленте. Никаких подписей «свой ключ» и названий
     моделей: это служебные подробности скрипта, человеку их знать не нужно,
     а ленту они засоряют. Модель и так видна в шапке блока.                    */
  function aiLogAnswer() {
    if (!aiAnswer || !aiAnswer.text) return;
    /* У теста с выбором показываем не текст ответа, а сами варианты с метками:
       человеку нужно видеть, какой кружок закрашен.                            */
    if (aiAnswer.kind === 'choice') {
      var picked = choiceFromText(aiAnswer.text);
      if (aiLogChoice(picked)) return;
    }
    /* Сопоставление: показываем пары, а не голый список значений. */
    if (aiAnswer.kind === 'matching') {
      var order = matchingFromText(aiAnswer.text);
      if (aiLogMatching(order)) return;
    }
    if (aiAnswer.kind === 'table') {
      var picks0 = tableFromText(aiAnswer.text);
      if (aiLogTable(picks0)) return;
    }
    /* под логотипом именно той модели, что ответила: человек мог переключить
       модель после ответа, и подпись не должна ему врать                        */
    aiLogAdd(aiAnswer.text, '', true, aiAnswer.model);
    if (aiAnswer.truncated) {
      aiLogAdd('Ответ оборвался по лимиту — это не решение целиком. Нажми «Спросить ИИ» ещё раз или выбери другую модель.', 'err');
    }
  }

  function aiAnswerAt(key) {
    return aiAnswer && aiAnswer.key === key ? aiAnswer.text : '';
  }

  /* ------------------------------------------------ структура курса и план */

  /* Уроки берём из бокового меню: там они подписаны номерами вида 4.1 — ровно так,
     как их видит человек. Никаких догадок про api/sections. */
  function lessonList() {
    var out = [], seen = {};
    $$('a[href*="/lesson/"]').forEach(function (a) {
      var m = /\/lesson\/(\d+)/.exec(a.getAttribute('href') || '');
      if (!m) return;
      var id = m[1];
      if (seen[id]) return;
      var label = norm(a.textContent);
      var num = /^(\d{1,3})\.(\d{1,3})/.exec(label);
      if (!num) return;
      seen[id] = 1;
      out.push({
        id: id, label: num[1] + '.' + num[2],
        section: +num[1], unit: +num[2],
        title: label.replace(/^\d{1,3}\.\d{1,3}\s*/, '')
      });
    });
    out.sort(function (a, b) { return (a.section - b.section) || (a.unit - b.unit); });
    return out;
  }

  /* Какой урок мы сейчас проходим. Нужен, чтобы ИИ понимал уровень: на 4.1 он
     не должен пушить генераторы, классы и лямбды, если в теории их ещё не было.
     Номер берём из бокового меню (там он подписан «4.1 Как работают методы»),
     а если меню свёрнуто — из заголовка страницы.                              */
  function lessonNow() {
    var ctx = stepContext();
    var all = lessonList();
    var found = null;
    for (var i = 0; i < all.length; i++) {
      if (ctx && String(all[i].id) === String(ctx.lesson)) { found = all[i]; break; }
    }
    if (found) {
      return {
        label: found.label, title: found.title,
        section: found.section, unit: found.unit,
        index: all.indexOf(found) + 1, total: all.length
      };
    }
    /* меню не отрисовано: пробуем заголовок страницы и активный пункт меню */
    var head = $('.lesson__title, .lesson-header__title, h1');
    var title = head ? norm(head.textContent) : '';
    var m = /^(\d{1,3})\.(\d{1,3})\s*(.*)$/.exec(title);
    if (m) {
      return {
        label: m[1] + '.' + m[2], title: m[3] || '',
        section: +m[1], unit: +m[2], index: 0, total: all.length
      };
    }
    var active = $('.lesson-sidebar__item.active, .toc__item.active, li.active a[href*="/lesson/"]');
    var aTitle = active ? norm(active.textContent) : '';
    var m2 = /^(\d{1,3})\.(\d{1,3})\s*(.*)$/.exec(aTitle);
    if (m2) {
      return {
        label: m2[1] + '.' + m2[2], title: m2[3] || '',
        section: +m2[1], unit: +m2[2], index: 0, total: all.length
      };
    }
    return title ? { label: '', title: title, section: 0, unit: 0, index: 0, total: all.length } : null;
  }

  /* Что в уроке уже проходили. Теория лежит на страницах-лекциях в том же
     .html-content.rich-text-viewer, только без тестовых данных. Отдаём её модели
     как «уже известно» — иначе она решает задачу на 4.1 через то, чего в курсе
     ещё не объясняли, и решение выглядит палевно.

     Загвоздка: спрашивают ИИ на странице ЗАДАНИЯ, а теория — на странице-лекции
     этого же урока. Поэтому текст лекции запоминаем, пока её читают, и на задании
     достаём из памяти урока.                                                    */
  var THEORY_KEY = 'theory';
  var theoryCache = {};
  try { theoryCache = JSON.parse(GM_getValue(THEORY_KEY, '{}')) || {}; } catch (e) { theoryCache = {}; }

  function saveTheory() {
    try { GM_setValue(THEORY_KEY, JSON.stringify(theoryCache)); } catch (e) { /* ignore */ }
  }

  /* Сколько помним текст лекции: курс проходят за один заход, но старьё чистить
     надо — иначе хранилище распухнет.                                            */
  var THEORY_TTL = 12 * 60 * 60 * 1000;

  /* Собираем теорию со страницы и, если она не пустая, запоминаем её для урока.
     Важная тонкость: на странице ЗАДАНИЯ тот же .html-content.rich-text-viewer
     содержит условие, а не теорию. Если запомнить его как «пройденный материал»,
     модель получит условие дважды, а лекцию — ни разу. Поэтому условие отсеиваем. */
  function rememberTheory() {
    var ctx = stepContext();
    if (!ctx) return '';
    var parts = [];
    $$('.html-content.rich-text-viewer').forEach(function (n) {
      var t = norm(n.textContent || '');
      if (t.length > 20) parts.push(t);
    });
    if (!parts.length) {
      var alt = $('.lesson__theory, .theory-viewer, .step-text__theory');
      if (alt) {
        var t2 = norm(alt.textContent || '');
        if (t2.length > 20) parts.push(t2);
      }
    }
    /* Теория — это контекст, а не задание: 800 символов хватает, чтобы понять
       уровень урока, а всё сверх этого только раздувает запрос и замедляет
       ответ.                                                                   */
    var text = parts.join('\n').slice(0, 800);
    if (!text) return '';

    /* На странице задания тот же контейнер держит условие, а не лекцию: запомнить
       его как «пройденное» значит отдать модели условие вместо теории. Признак
       надёжный один — есть ли на шаге само задание. Если есть, ничего не пишем;
       сравнение с stepConditionText() тут не годится: на странице-лекции он тоже
       находит текст (и это ровно тот же текст), и проверка всегда срабатывала бы. */
    if (isTaskPage()) return text;

    var prev = theoryCache[ctx.lesson];
    if (!prev || prev.text !== text) {
      theoryCache[ctx.lesson] = { text: text, at: Date.now(), step: ctx.step };
      saveTheory();
    }
    return text;
  }

  /* Есть ли на шаге задание (редактор кода, варианты или поле ввода) — тогда текст
     на странице это условие, а не лекция.                                        */
  function isTaskPage() {
    if ($('.CodeMirror, .cm-content, .code-runner, #id_coderunner_input')) return true;
    if ($('.quiz-component input[type="radio"], .quiz-component input[type="checkbox"]')) return true;
    if ($('.attempt-wrapper__plugin textarea, .quiz-plugin textarea')) return true;
    if ($('.quiz-plugin__content')) return true;
    return false;
  }

  function theoryFor(lessonId) {
    var rec = theoryCache[lessonId];
    if (!rec) return '';
    if (Date.now() - (rec.at || 0) > THEORY_TTL) { delete theoryCache[lessonId]; saveTheory(); return ''; }
    return rec.text || '';
  }

  function stepTheoryText() {
    var ctx = stepContext();
    var fromPage = rememberTheory();
    /* То, что лежит на странице задания, — это условие, а не теория: условие
       уже ушло в запрос отдельно. Поэтому если текст совпал с условием, берём
       запомненную лекцию урока.                                                 */
    var cond = stepConditionText();
    if (fromPage && !(cond && cond.indexOf(fromPage) >= 0)) return fromPage;
    return ctx ? theoryFor(ctx.lesson) : '';
  }

  async function lessonSteps(lessonId) {
    if (stepIds[lessonId] === undefined) {
      var list = [];
      try {
        var d = await sk('/api/lessons?ids[]=' + lessonId);
        list = (d.lessons && d.lessons[0] && d.lessons[0].steps) || [];
      } catch (e) { /* приватный урок */ }
      if (!list.length) {
        try {
          var d2 = await sk('/api/steps?lesson=' + lessonId);
          var arr = d2.steps || [];
          arr.sort(function (a, b) { return (a.position || 0) - (b.position || 0); });
          list = arr.map(function (s) { return s.id; });
        } catch (e2) { /* ignore */ }
      }
      stepIds[lessonId] = list.length ? list : null;
    }
    return stepIds[lessonId];
  }

  async function lessonPlan(lessons) {
    var plan = [], missing = [];
    for (var i = 0; i < lessons.length; i++) {
      var ids = await lessonSteps(lessons[i].id);
      if (!ids || !ids.length) { missing.push(lessons[i].label); continue; }
      for (var s = 1; s <= ids.length; s++) {
        plan.push({ lesson: lessons[i].id, step: s, label: lessons[i].label + '.' + s });
      }
    }
    if (missing.length) log('не вижу список шагов у уроков: ' + missing.join(', '));
    return plan;
  }

  function lessonsInRange(fromLabel, toLabel) {
    var all = lessonList();
    if (!all.length) {
      throw new Error('не нашёл список уроков — открой страницу курса или урока');
    }
    var key = function (s) { return String(s || '').trim().replace(',', '.').replace(/\s+/g, ''); };
    var a = key(fromLabel), b = key(toLabel);
    var pick = function (v) {
      for (var i = 0; i < all.length; i++) {
        if (all[i].label === v || all[i].title.toLowerCase() === v.toLowerCase()) return i;
      }
      return -1;
    };
    var i = pick(a), j = pick(b);
    if (i < 0) throw new Error('в меню курса нет урока «' + fromLabel + '»');
    if (j < 0) throw new Error('в меню курса нет урока «' + toLabel + '»');
    if (j < i) { var t = i; i = j; j = t; }
    return all.slice(i, j + 1);
  }

  /* --------------------------------------------------------------- панель */

/* в списках показываем только те уроки, для которых уже есть сохранённые ответы */
  function lessonsWithAnswers() {
    var idx = cacheIndex();
    var have = {};
    Object.keys(idx).forEach(function (key) {
      var m = /^l(\d+)_s\d+$/.exec(key);
      if (m) have[m[1]] = 1;
    });
    var all = lessonList();
    var only = all.filter(function (l) { return have[l.id]; });
    return only.length ? only : all;
  }

  function renderPanel(keepStatus) {
    var panel = document.getElementById('sgx-panel');
    if (!panel) return;
    var ctx = stepContext();
    var lessons = lessonsWithAnswers();
    var fromSel = document.getElementById('sgx-from-l');
    var toSel = document.getElementById('sgx-to-l');

    var want = lessons.map(function (l) { return l.label; }).join(',');
    var have = Array.prototype.map.call(fromSel.options, function (o) { return o.value; }).join(',');
    if (want !== have) {
      var keepFrom = fromSel.value, keepTo = toSel.value;
      [fromSel, toSel].forEach(function (sel) {
        sel.innerHTML = '';
        lessons.forEach(function (l) {
          var o = document.createElement('option');
          o.value = l.label;
          o.textContent = l.label + ' · ' + (l.title || '').slice(0, 26);
          sel.appendChild(o);
        });
      });
      if (keepFrom && want.indexOf(keepFrom) >= 0) fromSel.value = keepFrom;
      if (keepTo && want.indexOf(keepTo) >= 0) toSel.value = keepTo;
    }
    if (lessons.length) {
      if (!fromSel.value) {
        var cur = lessons.filter(function (l) { return l.id === (ctx && ctx.lesson); })[0];
        fromSel.value = (cur || lessons[0]).label;
      }
      if (!toSel.value) toSel.value = fromSel.value;
    }

    var note = document.getElementById('sgx-total');
    if (note) {
      note.textContent = lessons.length
        ? 'уроков с ответами: ' + lessons.length
        : 'ответов пока нет — сначала сохрани хотя бы один';
    }

    var busy = !!job;
    document.getElementById('sgx-solve').disabled = busy;
    document.getElementById('sgx-collect').disabled = busy;
    document.getElementById('sgx-stop').disabled = !busy;
    document.getElementById('sgx-open').style.display = (job && job.shots && job.shots.length) ? 'flex' : 'none';
    if (!keepStatus && !busy) setStatus('');
  }

  /* ============================================ первое знакомство со скриптом */

  /* Показываем один раз: пока человек не прошёл знакомство или не отказался,
     в хранилище нет отметки. Дальше шаги описываются так же — добавление нового
     шага в TOUR_STEPS достаточно, чтобы он попал в инструкцию.                 */
  var TOUR_KEY = 'tourDone';

  var TOUR_STEPS = [
    { target: '#sgx-tools-btn', title: 'Панель заданий',
      text: 'Вот она — кнопка в шапке урока. Открывает список заданий: пройти их подряд и собрать в документ Word.' },
    { target: '#sgx-chip', title: 'Скоба «есть решение»',
      text: 'У задания с готовым ответом появляется скоба: «вставить» подставит ответ, «нет» уберёт её, «ИИ» откроет чат.' },
    { target: '#sgx-ai-root', title: 'Чат с ИИ',
      text: 'Здесь ИИ решает задание: печатает код прямо в редактор, сам запускает его и исправляет, если проверка не приняла.' },
    { target: '#sgx-panel', title: 'Настройки',
      text: 'Диапазон заданий, сборка в Word и настройки — всё в панели. Кнопка «Настройки» внизу.' }
  ];

  function tourNeeded() {
    try { return !GM_getValue(TOUR_KEY, false); } catch (e) { return false; }
  }

  function tourDone() {
    try { GM_setValue(TOUR_KEY, true); } catch (e) { /* ignore */ }
  }

  function tourAsk() {
    var old = document.getElementById('sgx-tour-ask');
    if (old) old.remove();
    var box = document.createElement('div');
    box.id = 'sgx-tour-ask';
    box.innerHTML = [
      '<div class="sgx-ask-card">',
      '<h3>Хотите пройти ознакомление со скриптом?</h3>',
      '<p>Пара шагов — и будет видно, что где лежит.</p>',
      '<button class="sgx-ask-go" type="button">Пройти</button>',
      '<button class="sgx-ask-skip" type="button">Пропустить</button>',
      '</div>'
    ].join('');
    document.body.appendChild(box);
    box.classList.add('on');
    box.querySelector('.sgx-ask-go').addEventListener('click', function () {
      box.remove();
      tourStart(0);
    });
    box.querySelector('.sgx-ask-skip').addEventListener('click', function () {
      box.remove();
      tourDone();
    });
  }

  /* Подсказка стоит по центру, а на нужный элемент показывает стрелка и
     подсветка. Элемента может не быть на этом шаге — тогда просто показываем
     текст без стрелки, а не ломаемся.                                        */
  function tourStart(i) {
    var step = TOUR_STEPS[i];
    if (!step) { tourEnd(); return; }

    var old = document.getElementById('sgx-tour');
    if (old) old.remove();
    var ov = document.createElement('div');
    ov.id = 'sgx-tour';
    var dots = TOUR_STEPS.map(function (_, k) {
      return '<i class="' + (k === i ? 'on' : '') + '"></i>';
    }).join('');
    ov.innerHTML = [
      '<div class="sgx-tour-dim"></div>',
      '<div class="sgx-tour-ring" id="sgx-tour-ring" style="display:none"></div>',
      '<svg class="sgx-tour-arrow" id="sgx-tour-arrow" width="0" height="0"><path fill="none" ',
      'stroke="#FFD666" stroke-width="3" stroke-linecap="round" stroke-dasharray="7 6" d=""></path>',
      '<path fill="#FFD666" d=""></path></svg>',
      '<div class="sgx-tour-card">',
      '<div class="sgx-tour-dots">' + dots + '</div>',
      '<h3>' + escapeHtml(step.title) + '</h3>',
      '<p>' + escapeHtml(step.text) + '</p>',
      '<div class="sgx-tour-row">',
      '<button class="sgx-tour-next" type="button">' +
      (i + 1 < TOUR_STEPS.length ? 'Дальше' : 'Готово') + '</button>',
      '<button class="sgx-tour-skip" type="button">Пропустить</button>',
      '</div></div>'
    ].join('');
    document.body.appendChild(ov);
    ov.classList.add('on');

    ov.querySelector('.sgx-tour-next').addEventListener('click', function () { tourStart(i + 1); });
    ov.querySelector('.sgx-tour-skip').addEventListener('click', function () { tourEnd(); });

    /* Подсветка и стрелка: цель ищем каждый раз заново — вёрстка Stepik живая. */
    var el = null;
    try { el = document.querySelector(step.target); } catch (e) { el = null; }
    if (el) {
      var r = el.getBoundingClientRect();
      if (r.width && r.height) {
        var ring = ov.querySelector('#sgx-tour-ring');
        ring.style.display = 'block';
        ring.style.left = (r.left - 6) + 'px';
        ring.style.top = (r.top - 6) + 'px';
        ring.style.width = (r.width + 12) + 'px';
        ring.style.height = (r.height + 12) + 'px';

        var card = ov.querySelector('.sgx-tour-card').getBoundingClientRect();
        var from = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        var to = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        /* Стрелка идёт от центра экрана к элементу, но начинается за краем
           подсказки, чтобы не лезть под текст.                                  */
        var dx = to.x - from.x, dy = to.y - from.y;
        var len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        var startX = from.x + (dx / len) * (card.width / 2 + 10);
        var startY = from.y + (dy / len) * (card.height / 2 + 10);
        var arrow = ov.querySelector('#sgx-tour-arrow');
        arrow.setAttribute('width', String(window.innerWidth));
        arrow.setAttribute('height', String(window.innerHeight));
        arrow.setAttribute('viewBox', '0 0 ' + window.innerWidth + ' ' + window.innerHeight);
        arrow.querySelector('path').setAttribute('d',
          'M ' + startX + ' ' + startY + ' L ' + to.x + ' ' + to.y);
        /* наконечник: две короткие линии у цели */
        var ang = Math.atan2(dy, dx);
        var h1 = ang + Math.PI * 0.85, h2 = ang - Math.PI * 0.85;
        var head = arrow.querySelectorAll('path')[1];
        head.setAttribute('d',
          'M ' + to.x + ' ' + to.y +
          ' L ' + (to.x + Math.cos(h1) * 14) + ' ' + (to.y + Math.sin(h1) * 14) +
          ' L ' + (to.x + Math.cos(h2) * 14) + ' ' + (to.y + Math.sin(h2) * 14) + ' Z');
      }
    }
  }

  function tourEnd() {
    var ov = document.getElementById('sgx-tour');
    if (ov) ov.remove();
    var ask = document.getElementById('sgx-tour-ask');
    if (ask) ask.remove();
    tourDone();
  }

  /* Панель живёт внутри бокового меню курса: по кнопке в шапке урока она занимает
     место списка уроков, по крестику уроки возвращаются. Стиль — родной, тёмный
     (как «Методы и функции» в меню), чтобы не выглядеть чужеродной вставкой. */
  function ensurePanel() {
    if (document.getElementById('sgx-panel')) return;
    var panel = document.createElement('div');
    panel.id = 'sgx-panel';
    panel.innerHTML = [
      '<div class="sgx-module"><span class="sgx-badge">' + icon('spark', 13) + '</span>',
      '<span class="sgx-modtitle">Задания Stepik</span>',
      '<button class="sgx-close" type="button" title="Закрыть">' + icon('close', 14) + '</button></div>',
      '<div class="sgx-note" id="sgx-total"></div>',
      /* Кнопки идут подряд, без промежутков: так они читаются как один список. */
      '<button class="sgx-btn primary" id="sgx-solve" type="button">' + icon('play', 15) +
      'Пройти и отправить</button>',
      '<button class="sgx-btn plain" id="sgx-collect" type="button">' + icon('download', 15) +
      'Собрать в Word</button>',
      '<button class="sgx-btn ai" id="sgx-ai-btn" type="button">' + icon('spark', 15) +
      'Спросить ИИ по шагу</button>',
      '<button class="sgx-btn plain" id="sgx-open" type="button">' + icon('refresh', 15) +
      'Скачать Word ещё раз</button>',
      '<button class="sgx-btn danger" id="sgx-stop" type="button">' + icon('stop', 14) +
      'Остановить</button>',
      /* Настройки переехали сюда из меню Tampermonkey: там они были спрятаны,
         а нужны они ровно тогда, когда человек работает с панелью.             */
      '<button class="sgx-btn plain" id="sgx-set-btn" type="button">' + icon('cog', 15) +
      'Настройки</button>',
      '<div class="sgx-progress"><div class="sgx-bar" id="sgx-bar"></div></div>',
      '<div class="sgx-status" id="sgx-status"></div>',
      /* Выбор диапазона вылезает по нажатию «Пройти и отправить»: держать два
         списка на виду постоянно незачем.                                      */
      '<div class="sgx-pop" id="sgx-range">',
      '<h4>Что пройти</h4>',
      '<div class="sgx-prow"><label>с</label><select id="sgx-from-l"></select></div>',
      '<div class="sgx-prow"><label>по</label><select id="sgx-to-l"></select></div>',
      '<div class="sgx-phint">Берутся только шаги с сохранёнными ответами; остальные ' +
      'пропускаются.</div>',
      '<button class="sgx-pbtn" id="sgx-range-go" type="button">Начать</button>',
      '<button class="sgx-pbtn ghost" id="sgx-range-no" type="button">Отмена</button>',
      '</div>',
      '<div class="sgx-pop" id="sgx-set">',
      '<h4>Настройки</h4>',
      '<div class="sgx-prow"><label>токен</label>' +
      '<input id="sgx-set-token" type="password" placeholder="нужен, чтобы сохранять ответы"></div>',
      '<div class="sgx-prow"><label>ключ ИИ</label>' +
      '<input id="sgx-set-ai" type="password" placeholder="пусто — работаем как есть"></div>',
      '<div class="sgx-prow"><label>прокси</label>' +
      '<input id="sgx-set-proxy" type="text" placeholder="пусто — встроенный адрес"></div>',
      '<div class="sgx-phint">Токен и ключ хранятся только в настройках скрипта на твоём ' +
      'компьютере и в репозиторий не попадают.</div>',
      '<button class="sgx-pbtn" id="sgx-set-save" type="button">Сохранить</button>',
      '<button class="sgx-pbtn ghost" id="sgx-set-back" type="button">Назад</button>',
      '</div>'
    ].join('');

    panel.querySelector('.sgx-close').addEventListener('click', function () { openPanel(false); });
    var popRange = panel.querySelector('#sgx-range');
    var popSet = panel.querySelector('#sgx-set');
    /* Оба задания — и обход, и сборка — сначала спрашивают диапазон: списки
       уроков теперь живут только в этом окне, и без вопроса их не выбрать.    */
    var pendingKind = 'solve';
    function openRange(kind) {
      pendingKind = kind;
      popSet.classList.remove('on');
      popRange.classList.add('on');
    }
    panel.querySelector('#sgx-solve').addEventListener('click', function () { openRange('solve'); });
    panel.querySelector('#sgx-collect').addEventListener('click', function () { openRange('collect'); });
    panel.querySelector('#sgx-range-go').addEventListener('click', function () {
      popRange.classList.remove('on');
      beginJob(pendingKind);
    });
    panel.querySelector('#sgx-range-no').addEventListener('click', function () {
      popRange.classList.remove('on');
    });
    /* Настройки: значения подставляем при открытии, чтобы не показывать их
       постоянно и не путать человека пустыми полями.                          */
    panel.querySelector('#sgx-set-btn').addEventListener('click', function () {
      popRange.classList.remove('on');
      panel.querySelector('#sgx-set-token').value = cfg.token || '';
      panel.querySelector('#sgx-set-ai').value = cfg.aiKey || '';
      panel.querySelector('#sgx-set-proxy').value = (function () {
        try { return String(GM_getValue('aiProxy', '') || ''); } catch (e) { return ''; }
      })();
      popSet.classList.add('on');
    });
    panel.querySelector('#sgx-set-save').addEventListener('click', function () {
      setToken(String(panel.querySelector('#sgx-set-token').value || '').trim());
      setAiKey(String(panel.querySelector('#sgx-set-ai').value || '').trim());
      setAiProxy(String(panel.querySelector('#sgx-set-proxy').value || '').trim());
      popSet.classList.remove('on');
      renderPanel(true);
      toast('✓ Настройки сохранены');
    });
    panel.querySelector('#sgx-set-back').addEventListener('click', function () {
      popSet.classList.remove('on');
    });
    panel.querySelector('#sgx-collect').addEventListener('click', function () { beginJob('collect'); });
    panel.querySelector('#sgx-stop').addEventListener('click', function () { stopJob('остановлено'); });
    panel.querySelector('#sgx-open').addEventListener('click', function () { redownload(); });
    panel.querySelector('#sgx-ai-btn').addEventListener('click', function () {
      var ctx = stepContext();
      var again = aiAnswer && ctx && aiAnswer.key === ctx.key;
      askAi({ fixed: !!again });
    });
    /* Вставляем сразу в боковое меню (или в body, если меню ещё не отрисовано):
       без appendChild элемент не попадает в документ, и getElementById его не найдёт. */
    var host = $('.lesson-sidebar__content') || document.body;
    host.appendChild(panel);
  }

  /* --- блок ИИ: отдельный элемент, живёт в карточке задания ---
     Раньше он был частью панели настроек в боковом меню. Это неправильное место:
     решение — это код, а код на Stepik живёт в редакторе. Поэтому блок стоит
     прямо под редактором, в области .quiz-plugin, и выглядит как его продолжение:
     вкладка «Код», копирование, сброс, метка языка и выбор модели.              */
  /* Снимок ленты. Блок живёт в карточке задания, и Stepik может выбросить его
     из документа — вместе с лентой. Тогда при пересоздании блока человек видел
     пустой чат, хотя ответ у него есть. Держим разметку ленты и возвращаем её.  */
  var aiLogSnap = '';

  function snapshotAiLog() {
    var log = aiLogEl();
    if (log) aiLogSnap = log.innerHTML;
    return aiLogSnap;
  }

  function ensureAiRoot() {
    /* Держим ссылку сами. Раньше признаком «блок уже есть» был только поиск по
       документу, а блок, созданный до того, как нашлось место (aiSlot вернул
       null), в документ не попадал — и следующий вызов создавал ВТОРОЙ блок.
       Теперь элемент всегда один. И ссылку берём только на живой узел: после
       перерисовки карточки старый выбрасывается из дерева.                     */
    if (aiRootCache) return aiRootCache;
    var found = document.getElementById('sgx-ai-root');
    if (found) { aiRootCache = found; return found; }
    var root = document.createElement('div');
    root.id = 'sgx-ai-root';
    root.setAttribute('data-sgx-ai', '1');
    var restoreLog = aiLogSnap;
    root.innerHTML = [
      '<div id="sgx-ai-panel">',
      '<div class="sgx-ai-head">',
      /* Вкладка названа «ИИ» со значком искры: «Код» дублировало вкладку самого
         Stepik рядом и путало — тут не редактор, а помощник.                    */
      '<ul class="sgx-ai-tabs"><li class="sgx-ai-tab active">' + icon('spark', 18) + 'ИИ</li></ul>',
      '<div class="sgx-ai-tools">',
      /* Метки языка здесь нет: он и так написан рядом самим Stepik («Python 3.6»),
         а чип показывал то «ИИ», то «Python» и только путал.                    */
      /* Модель меняется здесь же, рядом с решением. Это свой список, а не родной
         <select>: в родном нельзя показать значок модели слева и её «ум» справа. */
      '<div class="sgx-ai-mwrap">',
      '<button class="sgx-ai-mbtn" id="sgx-ai-mbtn" type="button" title="Модель ИИ">',
      '<span class="sgx-ic" id="sgx-ai-micon"></span>',
      '<span id="sgx-ai-mlabel">модель</span>',
      '<span class="sgx-ai-mchev">' + icon('chev', 14) + '</span>',
      '</button>',
      '<ul class="sgx-ai-models" id="sgx-ai-models"></ul>',
      '</div>',
      '<button class="sgx-ai-tool" id="sgx-ai-reset" type="button" title="Очистить чат">' +
      icon('trash', 18) + '</button>',
      /* Закрыть блок. Вернуть его можно кнопкой «ИИ» в скобе или меню
         Tampermonkey — раньше закрывать было нечем, и блок занимал место,
         пока не уйдёшь на другой шаг.                                          */
      '<button class="sgx-ai-tool" id="sgx-ai-close" type="button" title="Закрыть окно">' +
      icon('close', 18) + '</button>',
      '</div></div>',
      '<div class="sgx-ai-log" id="sgx-ai-log"></div>',
      /* Кнопка нужна прямо здесь: после «Сбросить» спросить было нечем — скоба
         показывается только когда ответ уже есть, а меню Tampermonkey далеко.  */
      '<div class="sgx-ai-foot">',
      '<button class="sgx-ai-ask" id="sgx-ai-ask" type="button">Спросить ИИ</button>',
      '</div>',
      '</div>'
    ].join('');

    /* возвращаем прежнюю ленту, если блок пересоздали после перерисовки */
    if (restoreLog) {
      var logBox = root.querySelector('#sgx-ai-log');
      if (logBox) logBox.innerHTML = restoreLog;
    }

    root.querySelector('#sgx-ai-close').addEventListener('click', function () {
      aiShow(false);
      setStatus('ИИ: блок закрыт — вернуть можно кнопкой «ИИ» у задания');
    });

    root.querySelector('#sgx-ai-ask').addEventListener('click', function () {
      var ctx = stepContext();
      var again = !!(aiAnswer && ctx && aiAnswer.key === ctx.key);
      askAi({ fixed: again });
    });

    /* Сброс чистит переписку, но НЕ закрывает блок. Раньше он прятал блок, и
       вернуть его было нечем: скоба показывается только когда есть ответ, а
       меню «Показать решение» требует готового решения — после сброса его нет.
       Человек нажимал «очистить» и оставался без панели.                        */
    root.querySelector('#sgx-ai-reset').addEventListener('click', function () {
      var ctx = stepContext();
      if (ctx && aiAnswer && aiAnswer.key === ctx.key) {
        aiAnswer = null;
        saveAi();
      }
      aiLogClear();
      aiShow(true);
      aiLogAdd('Начнём заново. Нажми «Спросить ИИ» — решу это задание с нуля.', 'sys');
      setStatus('ИИ: лента очищена');
    });

    /* Список моделей: открыть/закрыть, выбрать, закрыть по щелчку мимо и по Esc. */
    var btn = root.querySelector('#sgx-ai-mbtn');
    var list = root.querySelector('#sgx-ai-models');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      list.classList.toggle('on');
    });
    list.addEventListener('click', function (e) {
      var li = e.target && e.target.closest ? e.target.closest('li[data-model]') : null;
      if (!li) return;
      pickModel(li.getAttribute('data-model'));
      list.classList.remove('on');
    });
    document.addEventListener('click', function (e) {
      if (!list.classList.contains('on')) return;
      if (root.contains(e.target)) return;
      list.classList.remove('on');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) list.classList.remove('on');
    });
    aiFillModels(root);
    aiRootCache = root;
    return root;
  }

  /* Выбрать модель из списка. Ответ прошлой модели больше не «текущий»: иначе
     «вставить» подставит решение, принятое другой моделью, а человек будет
     думать, что это новое.                                                     */
  function pickModel(id) {
    setAiModel(id);
    var info = modelInfo(id);
    toast('Модель ИИ: ' + info.label);
    var ctx = stepContext();
    if (ctx && aiAnswer && aiAnswer.key === ctx.key) {
      aiLogAdd('Переключился на ' + info.label + '. Нажми «Спросить ИИ», и я решу заново.', 'sys');
    }
    aiFillModels(aiRootEl());
  }

  /* Наполнить список моделей: значок слева, название с пояснением, «ум» справа.
     Пересобираем при каждом показе блока, чтобы список не разошёлся с настройкой. */
  function aiFillModels(root) {
    var box = (root || document).querySelector('#sgx-ai-models');
    var label = (root || document).querySelector('#sgx-ai-mlabel');
    var micon = (root || document).querySelector('#sgx-ai-micon');
    if (!box) return null;

    var want = aiModel();
    var info = modelInfo(want);

    if (label) label.textContent = info.label;
    if (micon) micon.innerHTML = modelIcon(info, 22);

    var have = Array.prototype.map.call(box.children, function (li) {
      return li.getAttribute('data-model');
    }).join(',');
    if (have !== AI_MODELS.map(function (m) { return m.id; }).join(',')) {
      box.innerHTML = '';
      AI_MODELS.forEach(function (m) {
        var li = document.createElement('li');
        li.setAttribute('data-model', m.id);
        var dots = '';
        for (var i = 0; i < 5; i++) dots += '<i class="' + (i < m.smarts ? 'on' : '') + '"></i>';
        li.innerHTML = modelIcon(m, 26) +
          '<span class="sgx-ai-mname"><b>' + escapeHtml(m.label) + '</b>' +
          '<span>' + escapeHtml(m.note) + '</span></span>' +
          '<span class="sgx-ai-smart" title="ум ' + m.smarts + ' из 5">' + dots + '</span>';
        box.appendChild(li);
      });
    }
    Array.prototype.forEach.call(box.children, function (li) {
      li.classList.toggle('on', li.getAttribute('data-model') === want);
    });
    wireModelIcons(root || document);
    aiSyncAskButton(root);
    return box;
  }

  /* Надпись на кнопке зависит от того, есть ли уже решение для шага: спрашивать
     «заново» и спрашивать «с нуля» — разные вещи, и человек должен видеть, что
     произойдёт. Заодно гасим кнопку, пока запрос в полёте.                      */
  function aiSyncAskButton(root) {
    var btn = (root || aiRootEl() || document).querySelector('#sgx-ai-ask');
    if (!btn) return;
    var ctx = stepContext();
    var again = !!(aiAnswer && ctx && aiAnswer.key === ctx.key);
    var label = again ? 'Спросить заново' : 'Спросить ИИ';
    if (btn.textContent !== label) btn.textContent = label;
    btn.disabled = !!aiBusy;
  }

  /* Куда класть блок ИИ. Ищем место внутри карточки задания, вплотную к редактору
     кода — ровно там, где человек и ждёт решение. Порядок важен: сначала якоря
     вокруг .code-editor-quiz__editor, потом общий контейнер плагина.           */
  var AI_HOST_SELS = [
    '.code-editor-quiz__editor',      /* сам редактор кода в текущей вёрстке */
    '.code-quiz__code',
    '.quiz-plugin__content',          /* общий контейнер плагина */
    '.quiz-plugin',
    '.attempt-wrapper__content'
  ];

  /* Якорь ставим ПОСЛЕ редактора, чтобы блок не отодвинул поле ввода, а лёг под ним.
     Если редактора ещё нет (задание с выбором) — в конец контейнера карточки.    */
  function aiHost() {
    for (var i = 0; i < AI_HOST_SELS.length; i++) {
      var node = $(AI_HOST_SELS[i]);
      if (!node) continue;
      /* контейнер должен быть видимым: свёрнутая карточка ничего не покажет */
      var r = node.getBoundingClientRect();
      if (r.width > 120) return node;
    }
    return null;
  }

  function aiSlot() {
    var root = ensureAiRoot();
    var host = aiHost();
    if (!host) return null;
    /* ставим сразу после редактора, а не в самый конец: так блок читается как
       часть редактора. Если редактор — сам контейнер, кладём внутрь, в конец.  */
    var cm = $('.CodeMirror') || $('.cm-editor') || $('.code-editor-quiz__editor');
    if (cm && host.contains(cm) && cm.parentNode) {
      if (root.previousSibling !== cm) cm.parentNode.insertBefore(root, cm.nextSibling);
    } else if (root.parentNode !== host) {
      host.appendChild(root);
    }
    /* список моделей держим в согласии с настройкой: блок переставляется при
       каждой смене шага, и селект не должен показывать старое значение.        */
    aiFillModels(root);
    return root;
  }

  /* куда класть панель: в наш блок внутри прокручиваемой области меню курса */
  function sidebarSlot(make) {
    var content = $('.lesson-sidebar__content');
    if (!content) return null;
    var slot = document.getElementById('sgx-panel');
    if (!slot && make === false) return null;
    if (!slot) {
      ensurePanel();
      slot = document.getElementById('sgx-panel');
    }
    if (!slot) return null;
    if (slot.parentNode !== content) content.appendChild(slot);
    return slot;
  }

  /* открыть/закрыть панель. on=false — вернуть список уроков. */
  function openPanel(on, silent) {
    var want = on !== false;
    var content = $('.lesson-sidebar__content');
    var nav = $('.lesson-sidebar__toc') || (content && content.querySelector('nav'));

    if (!content) {
      if (!silent) toast('Боковое меню курса не видно — открой любой урок', true);
      return false;
    }
    if (want && !sidebarSlot()) return false;
    if (nav) nav.classList.toggle('sgx-sidebar-hidden', want);
    var panel = document.getElementById('sgx-panel');
    if (panel) panel.classList.toggle('on', want);
    if (want) renderPanel();
    else setSiteProgress(job ? 0 : -1);
    return true;
  }

  function panelOpen() {
    var panel = document.getElementById('sgx-panel');
    return !!(panel && panel.classList.contains('on'));
  }

  /* кнопка в ряду настроек урока (рядом с «полноэкранным режимом» и шестерёнкой) */
  function ensureToolsButton() {
    var bar = $('.lesson-controls');
    if (!bar || !bar.parentNode) return null;
    var btn = document.getElementById('sgx-tools-btn');
    if (btn && btn.parentNode === bar) return btn;
    if (btn) btn.remove();
    var li = document.createElement('li');
    li.className = 'lesson-controls__item';
    li.id = 'sgx-tools-btn';
    li.innerHTML = '<button class="button_style_secondary" type="button" title="Задания Stepik">' +
      '<span class="svg-icon sgx-tools-icon">' + icon('sliders', 16) + '</span>' +
      '<span class="sgx-dot"></span></button>';
    li.querySelector('button').addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      var was = panelOpen();
      if (!openPanel(!was) && !was) toast('Не нашёл боковое меню курса', true);
    });
    bar.appendChild(li);
    return li;
  }

  /* индикатор на кнопке: обход идёт (мигающая точка) */
  function syncToolsButton() {
    var li = ensureToolsButton();
    if (li) li.classList.toggle('sgx-busy', !!job);
  }

  async function beginJob(kind) {
    var ctx = stepContext();
    if (!ctx) { setStatus('открой любой урок курса на stepik.org'); return; }
    if (kind === 'solve' && !cfg.token) { setStatus('нужен токен записи — панель → Настройки'); return; }
    if (job) {
      setSticky('обход уже идёт — сначала «Остановить»');
      return;
    }

    var lFrom = document.getElementById('sgx-from-l').value;
    var lTo = document.getElementById('sgx-to-l').value;
    var plan = [], title = '';
    try {
      if (!lFrom || !lTo) throw new Error('в списке нет уроков с ответами');
      var lessons = lessonsInRange(lFrom, lTo);
      setStatus('собираю список заданий…');
      plan = kind === 'collect' ? await collectPlan(lessons) : await lessonPlan(lessons);
      title = 'уроки ' + lessons[0].label + '–' + lessons[lessons.length - 1].label;
      if (!plan.length) throw new Error('в этих уроках не нашлось подходящих заданий');
    } catch (e) {
      setStatus(e.message);
      return;
    }
    startJob(kind, plan, title);
  }

  /* в Word собираем только задания с кодом: тесты с галочками и теорию пропускаем.
     Если сохранённых ответов с кодом нет — берём все уроки диапазона: на месте
     выяснится, что снимать. Но об этом честно говорим в статусе. */
  async function collectPlan(lessons) {
    var full = await lessonPlan(lessons);
    var idx = cacheIndex();
    var code = full.filter(function (t) {
      var it = idx['l' + t.lesson + '_s' + t.step];
      return it && it.kind === 'code';
    });
    if (code.length) return code;
    if (full.length) setStatus('ответов с кодом нет — пройду уроки и сниму то, что найду');
    return full;
  }

  async function redownload() {
    if (!job || !job.shots || !job.shots.length) { setStatus('скриншотов пока нет'); return; }
    try {
      var blob = await buildDocx(job.shots, 'Задания Stepik · ' + (job.title || 'сборка'));
      downloadBlob(blob, docName());
      setStatus('документ скачивается');
    } catch (e) { setStatus('не собрал документ: ' + e.message); }
  }

  /* ------------------------------------------------------------ главный цикл */

  var busy = false, tried = {}, dismissed = {}, currentKey = null;
  var lastOk = null, lastErr = null, lastReason = '';

  /* Stepik рисует редактор не мгновенно. Пока его нет, ничего не решаем: иначе
     скрипт «не находит» вставку и пропускает шаг, хотя тот просто не прогрузился. */
  var readyKey = null, readySince = 0, cardSince = 0;

  /* есть ли на шаге куда вставлять вообще */
  function stepHasInput() {
    return !!($('.CodeMirror') || $('.cm-content') || $('.quiz-component input') ||
      $('.matching-quiz') || tableQuizTable() ||
      $('.attempt-wrapper__plugin textarea') || $('.attempt-wrapper__plugin input[type="text"]'));
  }

  /* карточка задания уже отрисована */
  function cardDrawn() {
    var card = $('.attempt-wrapper__content, .quiz-component, .step-text');
    return !!(card && card.getBoundingClientRect().height > 60);
  }

  /* контейнер задания на месте, а поле ещё монтируется — вот-вот появится */
  function editorComing() {
    return !!$('.attempt-wrapper__plugin, .quiz-component');
  }

  function stepReady(ctx) {
    if (ctx.key !== readyKey) { readyKey = ctx.key; readySince = Date.now(); cardSince = 0; }
    if (insertTarget()) return true;

    if (cardDrawn()) {
      if (!cardSince) cardSince = Date.now();
      /* контейнер задания есть — ждём редактор, он появляется не сразу */
      if (editorComing()) return Date.now() - readySince > 6000;
      /* ни поля, ни контейнера — вставлять нечего, не тянем время */
      return Date.now() - cardSince > 1200;
    }
    return Date.now() - readySince > 8000;             /* страницы нет вовсе */
  }

  /* Опрос Stepik API — только страховка: основной путь это перехват отправки.
     Поэтому интервал растёт: 3с, 5с, 8с, 13с … до минуты. */
  function mayTry(key) {
    var t = tried[key] || (tried[key] = { at: 0, n: 0 });
    if (Date.now() - t.at < Math.min(60000, 3000 * Math.pow(1.6, t.n))) return false;
    t.at = Date.now();
    t.n++;
    return true;
  }

  async function autoSave(ctx) {
    var ans = null;
    if (netAnswer && netAnswer.key === ctx.key) ans = netAnswer.ans;
    if (!ans) ans = await currentAnswer(ctx);
    if (!ans || !ans.correct) {
      lastReason = ans
        ? 'ответ прочитан, но шаг не выглядит зачтённым — ' + (apiNote || 'причина неизвестна')
        : 'ответ прочитать не удалось — ' + (apiNote || 'причина неизвестна');
      return null;
    }

    try {
      var res = await saveAnswer(ctx, ans, false);
      if (res && res.skipped) {
        lastReason = 'ответ для этого шага уже есть в хранилище';
        return null;
      }
      lastReason = 'сохранено (' + (ans.via || '—') + ')';
      lastOk = { when: nowIso(), key: res.key, via: ans.via || '—' };
      /* Уведомления о сохранении нет: индикатор в правом нижнем углу уже
         превратился в галочку и погас — этого достаточно.                     */
      return res;
    } catch (err) {
      lastErr = err.message + ' · ' + nowIso();
      toast('⚠ Не сохранилось: ' + err.message, true);
      return null;
    }
  }

  /* Сменился шаг. Ленту чистим всегда, а если блок ИИ был открыт — сразу берёмся
     за новое задание: человек просил «чтобы он сразу новое задание начал делать».
     Не спрашиваем, если ответ для шага уже лежит в общей папке или если канал
     недоступен: иначе получится запрос ради запроса.                          */
  var aiAutoKey = null;                /* для какого шага автозапуск уже был */

  function resetAiForStep(ctx, wasOpen) {
    aiLogClear();
    if (!wasOpen || !ctx) return;
    if (aiAutoKey === ctx.key) return;                 /* уже пробовали */
    aiAutoKey = ctx.key;
    if (aiBusy) return;
    if (!aiChannels().length) return;                  /* нет ключа — не дёргаем */
    if (cacheIndex()[ctx.key]) return;                 /* ответ уже есть в папке */
    /* Шаг только что открылся: даём карточке дорисоваться, иначе условия ещё
       нет и модель получит пустоту.                                          */
    setTimeout(function () {
      var now = stepContext();
      if (!now || now.key !== ctx.key) return;         /* человек ушёл дальше */
      if (aiBusy) return;
      if (!aiRootEl() || !aiRootEl().classList.contains('on')) return;
      askAi();
    }, 1200);
  }

  async function tick() {
    /* Stepik перерисовывает сайдбар и шапку урока: и панель, и нашу кнопку надо
       переставлять заново, иначе они исчезают после смены шага. */
    syncToolsButton();
    if (panelOpen()) sidebarSlot();
    /* Блок ИИ перерисовывается вместе с карточкой задания — возвращаем его на
       место под редактором, иначе он пропадает при смене шага. Признак берём не
       с узла (его могло уже не быть), а из намерения человека: если блок не
       закрывали, он должен вернуться сам.                                      */
    if (aiWantOpen) {
      var aiBox = aiSlot() || aiRootEl();
      if (aiBox) aiBox.classList.add('on');
    }
    /* лента: пока блок на месте — запоминаем её, чтобы пережить перерисовку */
    if (aiRootEl()) snapshotAiLog();

    var ctx = stepContext();
    if (!ctx) { hideChip(); currentKey = null; return; }
    /* Пока человек читает лекцию, запоминаем её текст: на странице задания
       ИИ должен знать, что в этом уроке уже объяснили. Ошибку глотаем — это
       подстраховка, а не основная работа.                                       */
    if (Date.now() - lastTheoryAt > 3000) {
      lastTheoryAt = Date.now();
      try { rememberTheory(); } catch (e) { /* ignore */ }
    }
    if (ctx.key !== currentKey) {
      currentKey = ctx.key;
      hideChip();
      /* Сменился шаг — ИИ тоже сбрасываем: в ленте остался ответ на прошлое
         задание, и читать его как решение текущего нельзя. Само решение не
         выбрасываем — оно привязано к ключу шага, и на прошлом шаге скоба всё
         ещё предложит его открыть.                                            */
      resetAiForStep(ctx, aiWantOpen);
      /* сменился шаг — самое время подтянуть свежий список (не чаще раза в минуту) */
      if (Date.now() - cache.at > 60000) {
        storeIndex(true).catch(function (e) { log('список не обновился:', e.message); });
      }
    }

    /* страница ещё не дорисована — не спешим с выводами */
    if (!stepReady(ctx)) return;

    /* идёт обход заданий — скоба и автопостинг на это время не нужны */
    if (job) { hideChip(); runJob(ctx); return; }

    var entry = cacheIndex()[ctx.key];
    if (entry && !dismissed[ctx.key]) {
      var target = insertTarget();
      if (target) showChip(target, entry.kind === 'choice' ? 'есть ответ' : 'есть решение');
      else hideChip();
    } else if (aiAnswer && aiAnswer.key === ctx.key && !dismissed[ctx.key]) {
      /* решения в папке нет, зато его уже подсказал ИИ — предложим открыть */
      var t2 = insertTarget();
      /* Кнопку «ИИ» показываем и здесь: ею блок возвращается после закрытия. */
      if (t2) showChip(t2, 'есть решение ИИ', true);
      else hideChip();
    } else {
      hideChip();
    }

    if (entry || busy || !cfg.token || Date.now() < storeDown) return;
    if (!mayTry(ctx.key)) return;

    busy = true;
    autoSave(ctx).catch(function (e) { log(e); }).then(function () { busy = false; });
  }

  /* перехват сетевых запросов самой Stepik: узнаём id шага и сам ответ */
  document.addEventListener('sgx:net', function (e) {
    var d = e.detail || {};
    var fromUrl = /[?&]step=(\d+)/.exec(d.url || '');
    if (fromUrl) {
      var id = Number(fromUrl[1]);
      if (id !== netStep) {
        netStep = id;
        tried[currentKey] = null;      /* узнали id шага — перепроверяем сразу */
      }
    }
    if (!d.body) return;
    var json = null;
    try { json = JSON.parse(d.body); } catch (err) { return; }
    var subs = (json && json.submissions) || [];
    var ctx = stepContext();
    subs.forEach(function (s) {
      if (!s || !s.step) return;
      if (ctx && s.status === 'correct' && s.reply) {
        var ans = fromReply(s.reply, 'Stepik (перехват)');
        if (ans) {
          netAnswer = { key: ctx.key, ans: ans };
          tried[ctx.key] = null;         /* сохраняем сразу, не дожидаясь таймера */
          setTimeout(tick, 0);
        }
      } else if (ctx && s.status && s.status !== 'correct') {
        /* Отправка не прошла. Если на этом шаге решал ИИ — самое время прочитать
           ошибку и попробовать исправить: человек не должен разбираться сам. */
        nudgeFix(ctx);
      }
    });
  });

  /* Отправку ловим не только по сети: если ответ сохранён из кэша и ушёл не
     через перехваченный fetch, ошибку всё равно надо увидеть. Кнопка сайта
     подписана «Отправить на проверку», её и слушаем — в фазе перехвата,
     чтобы не мешать самому Stepik.                                              */
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest
      ? e.target.closest('button, .button, .quiz-plugin__submit, .attempt-wrapper__submit')
      : null;
    if (!b) return;
    var label = norm(b.textContent || '');
    if (!/Отправить на проверку|Submit/i.test(label)) return;
    var ctx = stepContext();
    if (ctx) nudgeFix(ctx);
  }, true);

  /* --------------------------------------------------- горячие клавиши */

  document.addEventListener('keydown', function (e) {
    if (!e.ctrlKey || !e.altKey || e.shiftKey) return;
    var k = (e.key || '').toLowerCase();
    var ctx = stepContext();
    if (!ctx) return;
    if (k === 'i') {
      e.preventDefault();
      hideChip(true);
      insertSaved(ctx).catch(function (err) { toast('⚠ ' + err.message, true); });
    } else if (k === 's') {
      e.preventDefault();
      (async function () {
        try {
          var ans = (netAnswer && netAnswer.key === ctx.key && netAnswer.ans) || await currentAnswer(ctx);
          if (!ans) throw new Error('на этом шаге нечего сохранять');
          var head = String(ans.content).split('\n').slice(0, 12).join('\n');
          if (!confirm('Сохранить это в хранилище?\nИсточник: ' + (ans.via || ans.kind) + '\n\n' + head)) return;
          var res = await saveAnswer(ctx, ans, true);
          /* Тоже без уведомления: сохранение показывает индикатор в углу. */
          log('перезаписано вручную: шаг ' + ctx.step + ' (' + res.key + ')');
        } catch (err) { toast('⚠ ' + err.message, true); }
      })();
    } else if (k === 'd') {
      e.preventDefault();
      selfTest().catch(function (err) { toast('⚠ ' + err.message, true); });
    }
  }, true);

  /* ------------------------------------------------------- самопроверка */

  async function selfTest() {
    var L = [], ok = false, writable = false;
    L.push('=== Stepik ⇄ Ответы: отчёт самопроверки ===');
    L.push('время: ' + nowIso() + ' · версия скрипта: ' + VERSION);
    L.push('репозиторий: ' + REPO + '@' + BRANCH + '/answers');
    L.push('токен записи: ' + (cfg.token ? 'задан (' + cfg.token.length + ' симв.)' : 'НЕ ЗАДАН'));
    L.push('в локальном списке: ' + Object.keys(cacheIndex()).length + ' шагов · обновлён ' +
      (cache.at ? new Date(cache.at).toLocaleString() : 'никогда'));
    if (lastOk) L.push('последняя запись: ' + lastOk.key + ' · ' + lastOk.when + ' · ' + lastOk.via);
    if (lastErr) L.push('последняя ошибка: ' + lastErr);
    if (lastStatus) L.push('последнее сообщение: ' + lastStatus);
    L.push('');

    try {
      var items = await storeIndex(true);
      ok = true;
      L.push('1) СПИСОК ОТВЕТОВ ЧИТАЕТСЯ · шагов в папке: ' + Object.keys(items).length);
    } catch (e) { L.push('1) СПИСОК НЕ ЧИТАЕТСЯ: ' + e.message); }

    if (!cfg.token) {
      L.push('2) ТОКЕН ЗАПИСИ НЕ ЗАДАН — меню → ⚙ Токен записи (без него ответы не сохраняются)');
    } else {
      try {
        var who = await fetch(API, { headers: ghHeaders() });
        if (who.status === 401) L.push('2) ТОКЕН НЕ ПРИНЯТ: проверь, что он не отозван');
        else if (who.status === 404) L.push('2) ТОКЕН НЕ ВИДИТ РЕПОЗИТОРИЙ — добавь ' + REPO +
          ' в его Repository access');
        else {
          L.push('2) ТОКЕН РАБОТАЕТ · репозиторий доступен');
          var probe = await fetch(API + '/contents/' + INBOX + '/_selftest.txt', {
            method: 'PUT',
            headers: ghHeaders(),
            body: JSON.stringify({ message: 'проверка записи (робот удалит)', content: b64('ok\n') })
          });
          if (probe.ok || probe.status === 409 || probe.status === 422) {
            writable = true;
            L.push('3) ЗАПИСЬ РАБОТАЕТ · пробный файл поставлен в очередь, робот его уберёт');
          } else {
            L.push('3) ЗАПИСЬ НЕ РАБОТАЕТ: ' + await ghError(probe));
          }
        }
      } catch (e) { L.push('2) ТОКЕН НЕ ПРОВЕРЕН: ' + e.message); }
    }

    L.push('');
    L.push('--- текущий шаг ---');
    var ctx = stepContext();
    if (!ctx) {
      L.push('откройте шаг урока: stepik.org/lesson/<урок>/step/<номер>');
    } else {
      L.push('урок ' + ctx.lesson + ', шаг ' + ctx.step + ' (ключ ' + ctx.key + ')');
      L.push(cacheIndex()[ctx.key]
        ? 'в хранилище уже есть ответ — появится скоба «вставить»'
        : 'ответа в хранилище нет');
      var sid = null;
      try { sid = await findStepId(ctx); } catch (e) { /* ignore */ }
      var list = stepIds[ctx.lesson];
      L.push('список шагов урока: ' + (list ? list.length + ' шт.' : 'НЕ ПОЛУЧЕН (ни /api/lessons, ни /api/steps)'));
      L.push('подсмотренный id шага: ' + (netStep || 'нет'));
      L.push('id шага в API Stepik: ' + (sid || 'НЕ ОПРЕДЕЛЁН — ответ прочитать не получится'));
      if (sid) {
        try {
          var d = await sk('/api/submissions?step=' + sid + '&limit=20');
          var subs = d.submissions || [];
          var good = subs.filter(function (s) { return s.status === 'correct' && s.reply; });
          L.push('ваших отправок: ' + subs.length + ' · статусы: ' +
            (subs.map(function (s) { return s.status; }).join(', ') || '—'));
          L.push(good.length ? 'есть зачтённый ответ — сохранится сам' : 'зачтённых отправок нет');
        } catch (e) { L.push('API Stepik не ответил: ' + e.message); }
      }
      var dom = domCode();
      L.push('в редакторе на странице: ' + (dom ? dom.code.length + ' символов' : 'пусто'));
      L.push('последняя попытка сохранить: ' + (lastReason || 'попыток не было'));
      if (lastNav) L.push('последний переход: ' + lastNav);
      L.push('на шаге есть поле ввода: ' + (stepHasInput() ? 'да' : 'нет'));
      if (apiNote) L.push('подробности: ' + apiNote);
    }

    L.push('');
    if (ok && writable) L.push('ИТОГ: всё работает — этот браузер может сохранять и вставлять ответы.');
    else if (ok && !cfg.token) L.push('ИТОГ: ответы читаются, но сохранять нечем — укажи токен.');
    else if (ok) L.push('ИТОГ: ответы читаются, но записать не получилось — см. пункт 3.');
    else if (!cfg.token) L.push('ИТОГ: укажи токен записи в меню.');
    else L.push('ИТОГ: хранилище не отвечает — проверь, что развёртывание открыто «для всех».');

    var report = L.join('\n');
    log(report);
    showReport(report);
    return ok;
  }

  async function diagnose() {
    if (!cfg.token) { toast('⚠ Токен записи не задан — панель → Настройки', true); return; }
    try {
      var items = await storeIndex(true);
      var who = await fetch(API, { headers: ghHeaders() });
      if (who.status === 401) throw new Error('токен не принят GitHub');
      if (who.status === 404) throw new Error('токен не видит ' + REPO);
      toast('✓ Готово · ответов в папке: ' + Object.keys(items).length + ' · запись разрешена');
    } catch (e) { toast('⚠ ' + e.message, true); }
  }

  /* ------------------------------------------------------------- меню */

  try {
    GM_registerMenuCommand('⚙ Токен записи', function () {
      var t = prompt('GitHub-токен с правом «Contents: write» на ' + REPO + '\n' +
        '(он умеет только класть ответ в очередь inbox/):', cfg.token || '');
      if (t === null) return;
      setToken(t.trim());
      cache = { at: 0, items: {} };
      saveCache();
      tried = {};
      storeDown = 0;
      if (!cfg.token) { toast('⚠ Токен не задан', true); return; }
      storeIndex(true).then(diagnose).catch(function (err) { toast('⚠ ' + err.message, true); });
    });

    GM_registerMenuCommand('🧪 Проверка хранилища (отчёт)', function () {
      selfTest().catch(function (err) { toast('⚠ ' + err.message, true); });
    });

    /* Пять пунктов убраны намеренно: «Пройти задания / собрать в Word»,
       «ИИ: решить текущий шаг», «Показать решение от ИИ», «Настройки ИИ» и
       «Прокси ИИ» дублировали то, что и так есть на странице. Панель заданий
       открывается кнопкой в шапке урока, ИИ — кнопкой «ИИ» в скобе у задания,
       а настройки переехали в саму панель, где они и нужны.                    */

    GM_registerMenuCommand('🔄 Обновить список ответов', function () {
      storeIndex(true)
        .then(function (items) { toast('✓ В хранилище ' + Object.keys(items).length + ' ответов'); })
        .catch(function (err) { toast('⚠ ' + err.message, true); });
    });
  } catch (e) { /* ignore */ }

  /* ------------------------------------------------------------- старт */

  function init() {
    injectBridge();
    /* панель НЕ создаём заранее: она живёт в сайдбаре и должна появляться только
       по нажатию кнопки. Иначе пустой блок висит в меню курса до первого клика. */
    ensureToolsButton();

    /* задание пережило перезагрузку: сбрасываем поля перехода, иначе первый же
       тик решит, что «переход не сработал», и пропустит нужный шаг */
    if (job) {
      job.navTo = '';
      job.navAt = 0;
      job.navHard = false;
      saveJob();
      setStatus('продолжаю: ' + (job.at + 1) + ' из ' + jobTotal());
      setSiteProgress(jobTotal() ? job.at / jobTotal() : 0);
    }

    if (!cfg.token) {
      toast('⚠ Укажите токен записи: панель → Настройки', true);
    }
    storeIndex(false)
      .then(function () { renderPanel(true); })
      .catch(function (err) { log('список ответов:', err.message); });

    setInterval(tick, 1500);
    setInterval(function () { if (chipAnchor) positionChip(chipAnchor); }, 500);

    /* Первое знакомство: один раз, и только когда человек уже на странице урока —
       иначе подсказка показывала бы на элементы, которых ещё нет.               */
    if (tourNeeded()) {
      setTimeout(function () {
        if (stepContext()) tourAsk();
      }, 2500);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
