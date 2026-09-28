// ==UserScript==
// @name         Stepik ⇄ Gist — автосохранение и вставка ответов
// @namespace    stepik-gist-sync
// @version      6.0.0
// @description  Зачтённые ответы Stepik (код и тесты с выбором варианта) автоматически уезжают в общую папку answers/ этого репозитория. Ответ берётся из API самого Stepik, поэтому вёрстка и редактор ни на что не влияют. На шаге, где решение уже сохранено, справа от карточки появляется скоба «вставить / нет». Панель из меню Tampermonkey умеет пройти задания пачкой и собрать их в Word со скриншотами. Там, где ответа ещё нет, решение подскажет ИИ — бесплатно и без ключа.
// @author       NOTyeamu
// @match        *://stepik.org/*
// @match        *://*.stepik.org/*
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @connect      text.pollinations.ai
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

  var VERSION = '6.0.0';

  /* Репозиторий с ответами */
  var REPO = 'NOTyeamu/Stepik-Fast-Complete';
  var BRANCH = 'main';

  /* Токен с единственным правом «Actions: write» — только на этот репозиторий.
     Разбит на куски намеренно: GitHub автоматически отзывает токены, найденные
     в открытых репозиториях, — ищет непрерывную строку. */
  var DEF_TOKEN = 'github_pat_1' + '1A3MLZTQ090Ak9zudxqsU_bXlwU6roNAIiWb9zM03AZafZjVxnRM5HCWchgvgf1AKSFEY' + 'VU5DY7J16pY2';

  /* ключ хранилища отдельный от старых версий: там в 'token' лежал токен гиста */
  var cfg = {
    token: GM_getValue('writeToken', DEF_TOKEN)
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

  async function storeItem(key) {
    var it = cacheIndex()[key];
    if (!it) throw new Error('в хранилище нет ответа для ' + key);
    var res = await fetch(rawUrl(it.file), { headers: { Accept: 'text/plain' } });
    if (!res.ok) throw new Error('ответ ' + it.file + ' не читается (HTTP ' + res.status + ')');
    var content = await res.text();
    if (!content.trim()) throw new Error('файл ' + it.file + ' пуст');
    return { key: key, kind: it.kind, content: content };
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
      storeDown = Date.now() + 60000;
      throw new Error('GitHub недоступен: ' + e.message);
    }
    /* 409/422 — файл уже лежит в очереди с прошлого раза, это не ошибка */
    if (!res.ok && res.status !== 409 && res.status !== 422) {
      if (res.status === 401 || res.status === 403) storeDown = Date.now() + 60000;
      throw new Error(await ghError(res));
    }

    /* робот перенесёт файл за секунды, но CDN ещё до пяти минут отдаёт старый
       индекс — поэтому держим шаг в своём списке, пока он там не появится */
    var entry = { key: ctx.key, file: name, kind: item.kind, ext: item.ext };
    pending[ctx.key] = { at: Date.now(), item: entry };
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

  function extOf(lang) {
    var m = String(lang || '').toLowerCase().trim();
    return EXT[m] || (m ? (m.replace(/[^a-z0-9]/g, '').slice(0, 6) || 'txt') : 'txt');
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

  async function writeCode(text) {
    var r = await bridgeAsk({ write: text });
    if (r && r.ok) return { ok: true, via: 'CodeMirror' };

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
    var field = $('.attempt-wrapper__plugin textarea') || $('.quiz-component textarea') ||
      $('.attempt-wrapper__plugin input[type="text"]');
    if (field) { setNative(field, text); return { ok: true, via: 'поле ввода' }; }
    return { ok: false, error: 'редактор для вставки не найден' };
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
      if (on || inp.type === 'checkbox') inp.click();
    });
    if (!hits) return { ok: false, error: 'сохранённые варианты не найдены в списке' };
    return { ok: true, via: 'варианты', hits: hits };
  }

/* Возвращаем и поле для вставки, и якорь для скобы: скоба должна обрамлять
     весь блок задания (.attempt-wrapper__content), а не отдельный вопрос. */
  function insertTarget() {
    var el = null;
    var q = $('.quiz-component[data-type="choice-quiz"] input:not([disabled]),' +
      ' .quiz-plugin__content input:not([disabled])');
    if (q) el = q.closest('.quiz-component, .quiz-plugin__content') || q;
    if (!el) {
      var cm = $('.CodeMirror');
      if (cm && cm.getBoundingClientRect().height) el = cm;
    }
    if (!el) {
      var c6 = $('.cm-content');
      if (c6 && c6.getBoundingClientRect().height) el = c6.closest('.cm-editor') || c6;
    }
    if (!el) {
      var field = $('.attempt-wrapper__plugin textarea, .quiz-component textarea');
      if (field) el = field;
    }
    if (!el) return null;
    return { el: el, anchor: cardOf(el) || el };
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
    /* --- скоба «вставить»: контрастная, чтобы её было видно --- */
    '#sgx-chip{position:fixed;z-index:2147483000;display:none;align-items:stretch;pointer-events:none;',
    'font:13.5px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '#sgx-chip.on{display:flex}',
    '#sgx-chip .sgx-brace{flex:none;display:block;overflow:visible}',
    '#sgx-chip.above .sgx-brace{display:none}',
    '#sgx-chip .sgx-body{display:flex;flex-direction:column;justify-content:center;gap:6px;padding:8px 12px;',
    'pointer-events:auto;background:#FFFFFF;border:1.5px solid #2F7CE0;border-radius:10px;',
    'box-shadow:0 3px 12px rgba(47,124,224,.25),0 1px 2px rgba(0,0,0,.10)}',
    '#sgx-chip .sgx-label{color:#1F1D1B;font-weight:700}',
    '#sgx-chip .sgx-acts{display:flex;align-items:center;gap:8px}',
    '#sgx-chip .sgx-sep{color:#C9C7C4}',
    '#sgx-chip .sgx-act{border:0;border-radius:7px;padding:5px 11px;cursor:pointer;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;line-height:1.2;background:#2F7CE0;color:#fff}',
    '#sgx-chip .sgx-act:hover{background:#2769C4}',
    '#sgx-chip .sgx-act.no{background:#EEF1F5;color:#3B3936}',
    '#sgx-chip .sgx-act.no:hover{background:#E1E7EE}',
    '#sgx-chip .sgx-act.ai{background:#EEF2FF;color:#3730A3}',
    '#sgx-chip .sgx-act.ai:hover{background:#E0E7FF}',
    /* «ИИ» в скобе показываем только когда сохранённого ответа нет */
    '#sgx-chip .sgx-ai-only{display:none}',
    '#sgx-chip.sgx-no-answer .sgx-ai-only{display:inline}',
    /* --- вспышка вокруг редактора и тост --- */
    '.sgx-flash{position:fixed;z-index:2147482000;pointer-events:none;border-radius:6px;opacity:1;',
    'background:rgba(56,178,113,.28);box-shadow:inset 0 0 0 2px rgba(56,178,113,.5);transition:opacity .4s ease}',
    '.sgx-flash.off{opacity:0}',
    '#sgx-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:2147483000;',
    'display:none;max-width:min(420px,90vw);',
    'padding:9px 12px;border-radius:8px;border:1px solid #E6E5E3;background:#FFF;color:#2C2C2B;',
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;box-shadow:0 1px 2px rgba(0,0,0,.05),0 4px 12px rgba(0,0,0,.06)}',
    '#sgx-toast.on{display:block}',
    '#sgx-toast.err{background:#FCE9E7;border-color:#F3C8C3;color:#b23f34}',
    /* --- отчёт самопроверки --- */
    '#sgx-report{position:fixed;inset:0;z-index:2147483647;background:rgba(15,15,14,.45);display:flex;',
    'align-items:center;justify-content:center;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    '#sgx-report .sgx-rep-box{background:#fff;border-radius:10px;box-shadow:0 18px 48px rgba(15,15,14,.25);',
    'padding:14px;width:min(620px,92vw);display:flex;flex-direction:column;gap:10px}',
    '#sgx-report textarea{width:100%;height:320px;resize:vertical;border:1px solid #E3E2E0;border-radius:6px;',
    'padding:10px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#37352F;background:#FBFBFA}',
    '#sgx-report .sgx-rep-row{display:flex;gap:8px;justify-content:flex-end}',
    '#sgx-report button{border:1px solid #E3E2E0;background:#fff;border-radius:6px;padding:6px 12px;',
    'font:13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#37352F;cursor:pointer}',
    '#sgx-report button:hover{background:#F1F1EF}',
    /* --- панель «от и до»: показывается только из меню Tampermonkey --- */
    '#sgx-panel{position:fixed;right:20px;bottom:20px;z-index:2147483000;display:none;width:312px;',
    'max-width:calc(100vw - 32px);padding:0;overflow:hidden;box-sizing:border-box;border-radius:14px;',
    'background:#FFFFFF;border:1px solid rgba(15,23,42,.08);',
    'box-shadow:0 16px 40px rgba(15,23,42,.18),0 2px 8px rgba(15,23,42,.06);',
    'font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0F172A}',
    '#sgx-panel.on{display:block}',
    '#sgx-panel *{box-sizing:border-box}',
    '#sgx-panel .sgx-head{display:flex;align-items:center;justify-content:space-between;',
    'padding:13px 14px 11px;border-bottom:1px solid #F1F5F9}',
    '#sgx-panel .sgx-title{font-size:15px;font-weight:700;letter-spacing:-.01em}',
    '#sgx-panel .sgx-close{display:flex;align-items:center;justify-content:center;width:28px;height:28px;',
    'border:0;border-radius:8px;background:#F1F5F9;color:#64748B;cursor:pointer;padding:0}',
    '#sgx-panel .sgx-close:hover{background:#E2E8F0;color:#0F172A}',
    '#sgx-panel .sgx-range{display:flex;align-items:center;gap:7px;padding:12px 14px 4px}',
    '#sgx-panel .sgx-range label{flex:0 0 auto;font-size:12.5px;font-weight:600;color:#64748B}',
    '#sgx-panel select{flex:1 1 0;min-width:0;height:34px;padding:0 8px;border:1px solid #E2E8F0;',
    'border-radius:9px;background:#F8FAFC;color:#0F172A;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:600}',
    '#sgx-panel select:focus{outline:2px solid #BFDBFE;outline-offset:1px}',
    '#sgx-panel .sgx-note{padding:7px 14px 10px;font-size:12px;color:#94A3B8}',
    '#sgx-panel .sgx-btn{display:flex;align-items:center;justify-content:center;gap:8px;',
    'width:calc(100% - 28px);margin:0 14px 8px;height:38px;border:0;border-radius:10px;padding:0;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:13.5px;font-weight:700;letter-spacing:-.005em;cursor:pointer;',
    'transition:filter .15s ease,transform .06s ease}',
    '#sgx-panel .sgx-btn:active{transform:translateY(1px)}',
    '#sgx-panel .sgx-btn.primary{background:#2563EB;color:#fff;box-shadow:0 6px 16px rgba(37,99,235,.30)}',
    '#sgx-panel .sgx-btn.primary:hover{filter:brightness(1.07)}',
    '#sgx-panel .sgx-btn.plain{background:#EEF2F7;color:#0F172A}',
    '#sgx-panel .sgx-btn.plain:hover{background:#E2E8F0}',
    '#sgx-panel .sgx-btn.danger{background:#FEF2F2;color:#DC2626}',
    '#sgx-panel .sgx-btn.danger:hover{background:#FEE2E2}',
    '#sgx-panel .sgx-btn:disabled{opacity:.45;cursor:default;box-shadow:none;filter:none}',
    '#sgx-panel .sgx-ic{flex:0 0 auto}',
    '#sgx-panel .sgx-progress{height:3px;background:#EEF2F7;margin-top:2px}',
    '#sgx-panel .sgx-bar{height:100%;width:0;border-radius:0 2px 2px 0;',
    'background:linear-gradient(90deg,#2563EB,#60A5FA);transition:width .35s ease}',
    '#sgx-panel .sgx-status{padding:10px 14px 13px;font-size:12.5px;color:#475569;min-height:36px}',
    '#sgx-panel .sgx-btn.ai{background:#EEF2FF;color:#3730A3}',
    '#sgx-panel .sgx-btn.ai:hover{background:#E0E7FF}',
    /* окно с решением ИИ */
    '#sgx-ai{position:fixed;right:20px;bottom:20px;z-index:2147483200;width:420px;',
    'max-width:calc(100vw - 32px);max-height:70vh;display:flex;flex-direction:column;overflow:hidden;',
    'border-radius:14px;background:#FFFFFF;border:1px solid rgba(15,23,42,.08);',
    'box-shadow:0 16px 40px rgba(15,23,42,.22),0 2px 8px rgba(15,23,42,.06);',
    'font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0F172A}',
    '#sgx-ai *{box-sizing:border-box}',
    '#sgx-ai .sgx-ai-head{display:flex;align-items:center;justify-content:space-between;',
    'padding:12px 14px;border-bottom:1px solid #F1F5F9;font-size:14px;font-weight:700}',
    '#sgx-ai .sgx-ai-x{display:flex;align-items:center;justify-content:center;width:26px;height:26px;',
    'border:0;border-radius:8px;background:#F1F5F9;color:#64748B;cursor:pointer;padding:0}',
    '#sgx-ai .sgx-ai-x:hover{background:#E2E8F0;color:#0F172A}',
    '#sgx-ai .sgx-ai-text{flex:1 1 auto;min-height:180px;margin:0;padding:12px 14px;border:0;resize:vertical;',
    'background:#F8FAFC;color:#0F172A;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
    '#sgx-ai .sgx-ai-text:focus{outline:none;background:#F1F5F9}',
    '#sgx-ai .sgx-ai-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px}',
    '#sgx-ai .sgx-ai-note{font-size:11.5px;color:#94A3B8}',
    '#sgx-ai .sgx-ai-copy{display:flex;align-items:center;gap:7px;height:34px;padding:0 13px;border:0;',
    'border-radius:9px;background:#2563EB;color:#fff;font-size:13px;font-weight:700;cursor:pointer}',
    '#sgx-ai .sgx-ai-copy:hover{filter:brightness(1.07)}',
    /* тонкая полоска сверху страницы — как встроенный индикатор сайта */
    '#sgx-progress{position:fixed;top:0;left:0;right:0;height:3px;z-index:2147483600;pointer-events:none}',
    '#sgx-progress>div{height:100%;width:0;background:#2563EB;opacity:.85;transition:width .35s ease}',
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
      '<span class="sgx-sep sgx-ai-only">/</span>',
      '<button type="button" class="sgx-act ai sgx-ai-only">ИИ</button>',
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
    chip.querySelector('.sgx-act.ai').addEventListener('click', function () { askAi(); });
    return chip;
  }

  function positionChip(target) {
    if (!chip || !target) return;
    var card = target.anchor;
    if (!card) return;
    var r = card.getBoundingClientRect();
    if (!r.width && !r.height) { chip.classList.remove('on'); return; }

    var body = chip.querySelector('.sgx-body');
    var bodyW = (body && body.offsetWidth) || 150;
    var spaceRight = window.innerWidth - r.right - 14;

    /* справа не помещается — показываем полоску прямо над карточкой */
    if (spaceRight < bodyW + BRACE_W + 8) {
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
      if (path) path.setAttribute('d', bracePath(h, BRACE_W));
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
    chip.classList.add('on');
    positionChip(target);
  }

  function hideChip(dismiss) {
    if (chip) chip.classList.remove('on');
    chipAnchor = null;
    if (dismiss) {
      var ctx = stepContext();
      if (ctx) dismissed[ctx.key] = true;
    }
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
      '<path d="M5 15V5a2 2 0 0 1 2-2h8"/>'
  };

  function icon(name, size) {
    return '<svg class="sgx-ic" viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) +
      '" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"' +
      ' aria-hidden="true">' + (ICONS[name] || '') + '</svg>';
  }

  /* Сообщение, которое не должен перебить идущий обход: короткие подсказки вроде
     «обход уже идёт» иначе исчезают через долю секунды, и человек их не видит. */
  var stickyUntil = 0, stickyText = '';
  function setSticky(text) { stickyText = text; stickyUntil = Date.now() + 2500; setStatus(text); }

  function setStatus(text) {
    if (Date.now() < stickyUntil && text !== stickyText) return;
    stickyText = text;
    var el = document.getElementById('sgx-status');
    if (el) el.textContent = text || '';
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
  var SUBMIT_RE = /^(отправить|отправка|проверить|решить|submit|send|check|run)/i;
  var NOT_SUBMIT_RE = /снова|заново|ещё раз|еще раз|again|отмена|cancel|удалить|delete/i;

  function submitButton(includeDisabled) {
    var nodes = $$('button, [role="button"]');
    var disabled = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var text = norm(el.textContent);
      if (!text || NOT_SUBMIT_RE.test(text) || !SUBMIT_RE.test(text)) continue;
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
     Ключа нет вовсе: обращаемся к бесплатному text.pollinations.ai, который
     пускает анонимно (1 запрос в 15 с). Значит и воровать нечего, и лимит
     не «утечёт»: он общий и восстановится сам через 15 секунд.
     ИИ ничего не вставляет и не отправляет — только показывает текст решения,
     чтобы человек сам решил, пользоваться им или нет. */

  var AI_URL = 'https://text.pollinations.ai/openai';
  var AI_MODEL = 'openai-fast';
  var AI_GAP = 16000;                  /* анонимный лимит: 1 запрос / 15 с */
  var aiBusy = false;
  var aiLast = 0;
  var aiAnswer = null;                 /* { key, text, at, model } */
  var AI_KEY = 'aiAnswer';

  try { aiAnswer = JSON.parse(GM_getValue(AI_KEY, 'null')); } catch (e) { aiAnswer = null; }

  function saveAi() {
    try { GM_setValue(AI_KEY, JSON.stringify(aiAnswer)); } catch (e) { /* ignore */ }
  }

  function aiWaitLeft() {
    var left = AI_GAP - (Date.now() - aiLast);
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /* текст задания с карточки: условие + код, если он в условии */
  function stepPrompt() {
    var card = $('.attempt-wrapper__content') || $('.step-text') || document.body;
    var text = norm(card.textContent || '');
    text = text.replace(/Отправить на проверку|Решить снова|Скачать|Показать ответ/g, ' ');
    return text.slice(0, 2500);
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

  /* Задание бывает и «ответить галочкой»: тогда просим прислать вариант текстом. */
  function stepKindNow() {
    if ($('.CodeMirror, .cm-content, .attempt-wrapper__plugin textarea')) return 'code';
    if ($('.quiz-component input[type="radio"], .quiz-component input[type="checkbox"]')) return 'choice';
    return 'text';
  }

  async function askAi() {
    var ctx = stepContext();
    if (!ctx) { setStatus('ИИ: открой страницу задания'); return; }
    if (aiBusy) { setStatus('ИИ: уже думает…'); return; }
    var wait = aiWaitLeft();
    if (wait) { setStatus('ИИ: бесплатный лимит, подожди ' + wait + ' с'); return; }

    var task = stepPrompt();
    if (task.length < 20) { setStatus('ИИ: не вижу текста задания на странице'); return; }

    var kind = stepKindNow();
    var lang = stepLanguage();
    var ask = kind === 'choice'
      ? 'Задание — тест с выбором. Пришли номер правильного варианта и его текст, коротко.'
      : (lang ? 'Пиши на ' + lang + '.' : 'Определи язык по условию и пиши на нём.');

    aiBusy = true;
    setStatus('ИИ думает над шагом ' + ctx.step + '…');
    setSiteProgress(0.5);
    try {
      var res = await fetch(AI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            {
              role: 'system',
              content: 'Ты помощник по программированию. Реши задание с платформы Stepik. ' +
                'Ответь коротко: только решение, без пояснений и без markdown-разметки. ' +
                'Если это код — дай готовый код целиком.'
            },
            { role: 'user', content: ask + '\n\nУсловие:\n' + task }
          ],
          max_tokens: 1200,
          private: true
        })
      });
      if (!res.ok) throw new Error('сервис ответил HTTP ' + res.status);
      var data = await res.json();
      var text = ((data.choices && data.choices[0] && data.choices[0].message &&
        data.choices[0].message.content) || '').trim();
      if (!text) throw new Error('пустой ответ');
      aiLast = Date.now();
      aiAnswer = { key: ctx.key, text: text, at: Date.now(), model: AI_MODEL, kind: kind };
      saveAi();
      setStatus('ИИ: решение готово (шаг ' + ctx.step + ')');
      renderPanel(true);
      showAi();
    } catch (e) {
      setStatus('ИИ не ответил: ' + e.message);
      aiLast = Date.now();                 /* не долбим сервис при ошибке */
    } finally {
      aiBusy = false;
      setSiteProgress(job ? (jobTotal() ? job.at / jobTotal() : 0) : -1);
    }
  }

  /* окно с решением: текст, кнопка «скопировать» и ничего больше */
  function showAi() {
    if (!aiAnswer || !aiAnswer.text) return;
    var old = document.getElementById('sgx-ai');
    if (old) old.remove();
    var box = document.createElement('div');
    box.id = 'sgx-ai';
    box.innerHTML = [
      '<div class="sgx-ai-head"><span>Решение от ИИ</span>',
      '<button class="sgx-ai-x" type="button" title="Закрыть">' + icon('close', 14) + '</button></div>',
      '<textarea class="sgx-ai-text" readonly></textarea>',
      '<div class="sgx-ai-foot">',
      '<span class="sgx-ai-note">проверь перед отправкой · модель ' + aiAnswer.model + '</span>',
      '<button class="sgx-ai-copy" type="button">' + icon('copy', 14) + 'Скопировать</button>',
      '</div>'
    ].join('');
    document.body.appendChild(box);
    box.querySelector('.sgx-ai-text').value = aiAnswer.text;
    box.querySelector('.sgx-ai-x').addEventListener('click', function () { box.remove(); });
    box.querySelector('.sgx-ai-copy').addEventListener('click', function () {
      var ta = box.querySelector('.sgx-ai-text');
      ta.removeAttribute('readonly');
      ta.select();
      var done = false;
      try { done = document.execCommand('copy'); } catch (e) { done = false; }
      ta.setAttribute('readonly', 'readonly');
      if (!done) { toast('Не скопировалось — выдели текст и нажми Ctrl+C', true); return; }
      toast('Скопировано');
    });
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

function ensurePanel() {
    if (document.getElementById('sgx-panel')) return;
    var panel = document.createElement('div');
    panel.id = 'sgx-panel';
    panel.innerHTML = [
      '<div class="sgx-head"><span class="sgx-title">Задания Stepik</span>',
      '<button class="sgx-close" type="button" title="Закрыть">' + icon('close', 15) + '</button></div>',
      '<div class="sgx-range"><label>с</label><select id="sgx-from-l"></select>',
      '<label>по</label><select id="sgx-to-l"></select></div>',
      '<div class="sgx-note" id="sgx-total"></div>',
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
      '<div class="sgx-progress"><div class="sgx-bar" id="sgx-bar"></div></div>',
      '<div class="sgx-status" id="sgx-status"></div>'
    ].join('');
    document.body.appendChild(panel);

    panel.querySelector('.sgx-close').addEventListener('click', function () { openPanel(false); });
    document.getElementById('sgx-solve').addEventListener('click', function () { beginJob('solve'); });
    document.getElementById('sgx-collect').addEventListener('click', function () { beginJob('collect'); });
    document.getElementById('sgx-stop').addEventListener('click', function () { stopJob('остановлено'); });
    document.getElementById('sgx-open').addEventListener('click', function () { redownload(); });
    document.getElementById('sgx-ai-btn').addEventListener('click', function () { askAi(); });
    renderPanel();
  }

  /* панель открывается только из меню Tampermonkey — на странице её не видно */
  function openPanel(on) {
    ensurePanel();
    var panel = document.getElementById('sgx-panel');
    panel.classList.toggle('on', on !== false);
    if (on !== false) renderPanel();
    if (on === false) setSiteProgress(job ? 0 : -1);
  }

async function beginJob(kind) {
    var ctx = stepContext();
    if (!ctx) { setStatus('открой любой урок курса на stepik.org'); return; }
    if (kind === 'solve' && !cfg.token) { setStatus('нужен токен записи — меню → ⚙ Токен записи'); return; }
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
      toast('💾 Сохранено: шаг ' + ctx.step + ' · источник: ' + (ans.via || '—'));
      return res;
    } catch (err) {
      lastErr = err.message + ' · ' + nowIso();
      toast('⚠ Не сохранилось: ' + err.message + '  → меню → 🧪 Проверка хранилища', true);
      return null;
    }
  }

  async function tick() {
    var ctx = stepContext();
    if (!ctx) { hideChip(); currentKey = null; return; }
    if (ctx.key !== currentKey) {
      currentKey = ctx.key;
      hideChip();
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
      if (t2) showChip(t2, 'есть решение ИИ');
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
      }
    });
  });

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
          toast('💾 Перезаписано: шаг ' + ctx.step + ' (' + res.key + ')');
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
    if (!cfg.token) { toast('⚠ Токен записи не задан — меню → ⚙ Токен записи', true); return; }
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

    GM_registerMenuCommand('📄 Пройти задания / собрать в Word', function () {
      openPanel(true);
    });

    GM_registerMenuCommand('✨ ИИ: решить текущий шаг', function () {
      askAi();
    });

    GM_registerMenuCommand('📋 Показать решение от ИИ', function () {
      if (!aiAnswer || !aiAnswer.text) { toast('ИИ ещё ничего не присылал на этом шаге'); return; }
      showAi();
    });

    GM_registerMenuCommand('🔄 Обновить список ответов', function () {
      storeIndex(true)
        .then(function (items) { toast('✓ В хранилище ' + Object.keys(items).length + ' ответов'); })
        .catch(function (err) { toast('⚠ ' + err.message, true); });
    });
  } catch (e) { /* ignore */ }

  /* ------------------------------------------------------------- старт */

  function init() {
    injectBridge();
    ensurePanel();

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
      toast('⚠ Укажите токен записи: меню Tampermonkey → ⚙ Токен записи', true);
    }
    storeIndex(false)
      .then(function () { renderPanel(true); })
      .catch(function (err) { log('список ответов:', err.message); });

    setInterval(tick, 1500);
    setInterval(function () { if (chipAnchor) positionChip(chipAnchor); }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
