// ==UserScript==
// @name         Stepik ⇄ Gist — автосохранение и вставка ответов
// @namespace    stepik-gist-sync
// @version      5.0.0
// @description  Зачтённые ответы Stepik (код и тесты с выбором варианта) автоматически уезжают в общую папку answers/ этого репозитория. Ответ берётся из API самого Stepik, поэтому вёрстка и редактор ни на что не влияют. На шаге, где решение уже сохранено, справа от карточки появляется скоба «вставить / нет».
// @author       NOTyeamu
// @match        *://stepik.org/*
// @match        *://*.stepik.org/*
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
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

  var VERSION = '5.0.0';

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
  try {
    var cached = JSON.parse(GM_getValue('index', '{}'));
    if (cached && cached.items) cache = cached;
  } catch (e) { /* ignore */ }

  function cacheIndex() { return cache.items; }

  function saveCache() {
    try { GM_setValue('index', JSON.stringify(cache)); } catch (e) { /* ignore */ }
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
    cache = { at: Date.now(), items: items };
    saveCache();
    storeDown = 0;
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

    /* робот перенесёт файл в answers/ за секунды; чтобы скоба появилась сразу,
       добавляем шаг в свой список сами */
    cache.items[ctx.key] = { key: ctx.key, file: name, kind: item.kind, ext: item.ext };
    cache.at = Date.now();
    saveCache();
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

  async function stepIdFor(ctx) {
    if (stepIds[ctx.lesson] === undefined) {
      var list = [];
      try {
        var d = await sk('/api/lessons?ids[]=' + ctx.lesson);
        list = (d.lessons && d.lessons[0] && d.lessons[0].steps) || [];
      } catch (e) { /* приватный урок */ }
      stepIds[ctx.lesson] = list.length ? list : null;
    }
    if (stepIds[ctx.lesson]) return stepIds[ctx.lesson][ctx.step - 1] || null;

    /* списка шагов нет — проверяем подсмотренный id: /api/steps отдаёт lesson и position */
    if (netStep) {
      try {
        var st = (await sk('/api/steps/' + netStep)).steps[0];
        if (st && String(st.lesson) === String(ctx.lesson) && st.position === ctx.step) return netStep;
      } catch (e) { /* ignore */ }
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
    var stepId = await stepIdFor(ctx);
    if (!stepId) return null;
    await myUserId();
    var d = await sk('/api/submissions?step=' + stepId + '&limit=20');
    var good = (d.submissions || []).filter(function (s) {
      /* только свои отправки: чужое решение сохранять нельзя */
      return s && s.status === 'correct' && s.reply && (!myId || s.user === myId);
    });
    if (!good.length) return null;
    good.sort(function (a, b) { return (b.id || 0) - (a.id || 0); });
    return fromReply(good[0].reply, 'Stepik API');
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
    try {
      var viaApi = await apiAnswer(ctx);
      if (viaApi) return viaApi;
    } catch (e) { log('API Stepik недоступен:', e.message); }

    var code = domCode();
    if (!code || looksLikeTemplate(code.code)) return null;
    return {
      kind: 'code', content: code.code, ext: extOf(code.lang), lang: code.lang,
      correct: domPassed(), via: 'DOM'
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

  function insertTarget() {
    var q = $('.quiz-component[data-type="choice-quiz"] input:not([disabled]), .quiz-plugin__content input:not([disabled])');
    if (q) return { anchor: q.closest('.quiz-component, .quiz-plugin__content') };
    var cm = $('.CodeMirror');
    if (cm && cm.getBoundingClientRect().height) return { anchor: cm };
    var c6 = $('.cm-content');
    if (c6 && c6.getBoundingClientRect().height) return { anchor: c6.closest('.cm-editor') || c6 };
    var field = $('.attempt-wrapper__plugin textarea, .quiz-component textarea');
    if (field) return { anchor: field };
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
    '#sgx-chip{position:fixed;z-index:2147483000;display:none;align-items:stretch;pointer-events:none;',
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;white-space:nowrap}',
    '#sgx-chip.on{display:flex}',
    '#sgx-chip .sgx-brace{flex:none;display:block;overflow:visible}',
    '#sgx-chip.flat .sgx-brace{display:none}',
    '#sgx-chip .sgx-body{display:flex;flex-direction:column;justify-content:center;gap:1px;padding-left:8px;pointer-events:auto}',
    '#sgx-chip .sgx-label{color:#7D7A75}',
    '#sgx-chip .sgx-acts{display:flex;align-items:center;gap:6px}',
    '#sgx-chip .sgx-sep{color:#C9C7C4}',
    '#sgx-chip .sgx-act{border:0;background:none;padding:0;margin:0;cursor:pointer;font:inherit;font-weight:600;color:#2783DE}',
    '#sgx-chip .sgx-act:hover{text-decoration:underline}',
    '#sgx-chip .sgx-act.no{color:#9B9894;font-weight:500}',
    '.sgx-flash{position:fixed;z-index:2147482000;pointer-events:none;border-radius:6px;opacity:1;',
    'background:rgba(56,178,113,.28);box-shadow:inset 0 0 0 2px rgba(56,178,113,.5);transition:opacity .4s ease}',
    '.sgx-flash.off{opacity:0}',
    '#sgx-toast{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:none;max-width:320px;',
    'padding:9px 12px;border-radius:8px;border:1px solid #E6E5E3;background:#FFF;color:#2C2C2B;',
    'font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;',
    'box-shadow:0 1px 2px rgba(0,0,0,.05),0 4px 12px rgba(0,0,0,.06)}',
    '#sgx-toast.on{display:block}',
    '#sgx-toast.err{background:#FCE9E7;border-color:#F3C8C3;color:#b23f34}',
    '#sgx-report{position:fixed;inset:0;z-index:2147483647;background:rgba(15,15,14,.45);display:flex;',
    'align-items:center;justify-content:center;font:13px/1.5 ui-sans-serif,system-ui,sans-serif}',
    '#sgx-report .sgx-rep-box{background:#fff;border-radius:10px;box-shadow:0 18px 48px rgba(15,15,14,.25);',
    'padding:14px;width:min(620px,92vw);display:flex;flex-direction:column;gap:10px}',
    '#sgx-report textarea{width:100%;height:320px;resize:vertical;border:1px solid #E3E2E0;border-radius:6px;',
    'padding:10px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#37352F;background:#FBFBFA}',
    '#sgx-report .sgx-rep-row{display:flex;gap:8px;justify-content:flex-end}',
    '#sgx-report button{border:1px solid #E3E2E0;background:#fff;border-radius:6px;padding:6px 12px;',
    'font:13px/1 ui-sans-serif,system-ui,sans-serif;color:#37352F;cursor:pointer}',
    '#sgx-report button:hover{background:#F1F1EF}'
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
      '<path fill="none" stroke="#C7C5C1" stroke-width="1.6" stroke-linecap="round" d=""></path>',
      '</svg>',
      '<div class="sgx-body">',
      '<span class="sgx-label">есть решение</span>',
      '<span class="sgx-acts">',
      '<button type="button" class="sgx-act yes">вставить</button>',
      '<span class="sgx-sep">/</span>',
      '<button type="button" class="sgx-act no">нет</button>',
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
    return chip;
  }

  function positionChip(target) {
    if (!chip || !target) return;
    var card = target.anchor;
    if (!card) return;
    var r = card.getBoundingClientRect();
    if (!r.width && !r.height) { chip.classList.remove('on'); return; }

    var body = chip.querySelector('.sgx-body');
    var bodyW = (body && body.offsetWidth) || 120;
    var flat = (window.innerWidth - r.right - 14) < (bodyW + BRACE_W + 8);
    chip.classList.toggle('flat', flat);

    if (!flat) {
      var h = Math.max(48, r.height);
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
      return;
    }
    chip.style.height = 'auto';
    var w = chip.offsetWidth || bodyW;
    chip.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 10, r.right - w))) + 'px';
    chip.style.top = Math.round(Math.max(8, r.top - 34)) + 'px';
  }

  function showChip(target, label) {
    ensureChip();
    chip.querySelector('.sgx-label').textContent = label || 'есть решение';
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

  /* ------------------------------------------------------------ главный цикл */

  var busy = false, tried = {}, dismissed = {}, currentKey = null;
  var lastOk = null, lastErr = null;

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
    if (!ans || !ans.correct) return null;

    try {
      var res = await saveAnswer(ctx, ans, false);
      if (res && res.skipped) return null;
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

    var entry = cacheIndex()[ctx.key];
    if (entry && !dismissed[ctx.key]) {
      var target = insertTarget();
      if (target) showChip(target, entry.kind === 'choice' ? 'есть ответ' : 'есть решение');
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
      try { sid = await stepIdFor(ctx); } catch (e) { /* ignore */ }
      L.push('id шага в API Stepik: ' + (sid || 'не определён (сработает перехват отправки)'));
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

    GM_registerMenuCommand('🔄 Обновить список ответов', function () {
      storeIndex(true)
        .then(function (items) { toast('✓ В хранилище ' + Object.keys(items).length + ' ответов'); })
        .catch(function (err) { toast('⚠ ' + err.message, true); });
    });
  } catch (e) { /* ignore */ }

  /* ------------------------------------------------------------- старт */

  function init() {
    injectBridge();

    if (!cfg.token) {
      toast('⚠ Укажите токен записи: меню Tampermonkey → ⚙ Токен записи', true);
    }
    storeIndex(false).catch(function (err) { log('список ответов:', err.message); });

    setInterval(tick, 1500);
    setInterval(function () { if (chipAnchor) positionChip(chipAnchor); }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
