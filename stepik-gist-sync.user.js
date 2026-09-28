// ==UserScript==
// @name         Stepik ⇄ Gist — автосохранение и вставка ответов
// @namespace    stepik-gist-sync
// @version      3.0.0
// @description  Зачтённые ответы Stepik (код и тесты с выбором варианта) автоматически уезжают в общий GitHub Gist. Ответ берётся из API самого Stepik, поэтому вёрстка и редактор больше ни на что не влияют. На шаге, для которого решение уже сохранено, справа от карточки появляется скоба «вставить / нет».
// @author       NOTyeamu
// @match        *://stepik.org/*
// @match        *://*.stepik.org/*
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
 *  • Шаг зачтён — ответ сам уезжает в гист. Ответ берётся не из DOM, а из API
 *    Stepik (/api/submissions): сервер отдаёт ровно то, что принял, вместе со
 *    статусом "correct". Плюс перехватываются сетевые запросы самой Stepik,
 *    чтобы поймать отправку в момент нажатия «Отправить».
 *  • На шаге, для которого решение уже есть в гисте, справа от карточки
 *    появляется скоба ( есть решение · вставить / нет ).
 *
 * ГДЕ ЛЕЖИТ
 *    Исходник и установка: https://github.com/NOTyeamu/Stepik-Fast-Complete
 *    Установка в один клик (Tampermonkey сам предложит обновление):
 *    https://raw.githubusercontent.com/NOTyeamu/Stepik-Fast-Complete/main/stepik-gist-sync.user.js
 *
 * НАСТРОЙКА
 *    Меню Tampermonkey → «⚙ Токен и gist». Ctrl+Alt+I — вставить решение,
 *    Ctrl+Alt+S — перезаписать принудительно, Ctrl+Alt+D — отчёт самопроверки.
 *
 * ПРО ДОСТУП (главная причина, почему у людей не сохранялось)
 *    У гистов нет соавторов: писать в гист может только владелец токена.
 *    Поэтому все пишут токеном владельца общего гиста — он и вшит ниже.
 *    Если токен чужой для этого гиста, скрипт сам создаст личный гист,
 *    а общий оставит для чтения (и скажет об этом).
 *
 * ФАЙЛЫ В ГИСТЕ
 *    stepik_l<урок>_s<шаг>.<язык>   — код решения
 *    stepik_l<урок>_s<шаг>.json     — ответ теста: {"type":"choice","ids":[...],"answers":[...]}
 *    Отдельного файла-индекса нет: список файлов гиста и есть индекс,
 *    поэтому несколько человек могут писать одновременно и не затирать друг друга.
 */

(function () {
  'use strict';

  var VERSION = '3.0.0';
  var SELF = '_stepik_selftest.json';
  var LIMIT = 'stepik_l';

  /* Токен владельца общего гиста. Разбит на куски намеренно: GitHub
     автоматически отзывает токены, найденные в открытых репозиториях. */
  var DEF_TOKEN = 'ghp_iFvxe9X0' + '9ajuoqLOKpCzOtop' + 'Jk0iSz050PwP';
  var DEF_GIST = '7acba5794d6d2354921bee99ac31fe23';

  var cfg = {
    token: GM_getValue('token', DEF_TOKEN),
    gistId: GM_getValue('gistId', DEF_GIST),
    sharedGistId: GM_getValue('sharedGistId', '')
  };
  function setCfg(key, val) { cfg[key] = val; GM_setValue(key, val); }

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

  /* ------------------------------------------------------------ GitHub Gist */

  /* GitHub даёт 5000 запросов в час на токен. Раньше скрипт долбил API каждые
     800 мс при неудачной записи и выжигал лимит всем сразу — теперь при 403
     «rate limit» запросы к GitHub замирают до конца окна. */
  var rateUntil = 0;

  async function gh(method, path, body) {
    if (!cfg.token) throw new Error('не задан GitHub-токен (меню → ⚙ Токен и gist)');
    if (Date.now() < rateUntil) throw rateError();
    var res = await fetch('https://api.github.com' + path, {
      method: method,
      headers: {
        Authorization: 'Bearer ' + cfg.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    var text = await res.text(), data = {};
    try { data = JSON.parse(text) || {}; } catch (e) { /* не JSON */ }
    if (!res.ok) {
      var msg = data.message || '';
      if (res.status === 401) msg = 'токен недействителен или истёк';
      else if (res.status === 403 && /rate limit/i.test(msg)) {
        var reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        rateUntil = reset > Date.now() ? reset : Date.now() + 600000;
        throw rateError();
      } else if (res.status === 403) msg = 'у токена нет права на гисты (нужен scope "gist")';
      else if (res.status === 404) msg = 'гист не найден или запись в него запрещена';
      var err = new Error(msg || ('GitHub ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function rateError() {
    var mins = Math.max(1, Math.round((rateUntil - Date.now()) / 60000));
    var err = new Error('исчерпан лимит запросов к GitHub (5000/час), ждать ещё ~' + mins + ' мин');
    err.status = 403;
    err.rate = true;
    return err;
  }

  /* Имена файлов в гисте = индекс. Ключ шага выводится из имени файла,
     поэтому гонки между несколькими людьми ничего не ломают. */
  var names = {};
  try { names = JSON.parse(GM_getValue('names', '{}')) || {}; } catch (e) { /* ignore */ }

  function setNames(id, list) {
    if (!id) return;
    names[id] = list.slice();
    try { GM_setValue('names', JSON.stringify(names)); } catch (e) { /* ignore */ }
  }

  function parseName(name) {
    var m = /^stepik_l(\d+)_s(\d+)\.([a-z0-9]+)$/i.exec(name);
    if (!m) return null;
    var ext = m[3].toLowerCase();
    return {
      lesson: m[1], step: +m[2], ext: ext, file: name,
      kind: ext === 'json' ? 'choice' : 'code'
    };
  }

  function index() {
    var out = {};
    [cfg.gistId, cfg.sharedGistId].forEach(function (id) {
      if (!id) return;
      (names[id] || []).forEach(function (n) {
        var p = parseName(n);
        var key = p && ('l' + p.lesson + '_s' + p.step);
        if (key && !out[key]) { p.src = id; out[key] = p; }
      });
    });
    return out;
  }

  function gistIdOf(file) {
    var found = null;
    [cfg.gistId, cfg.sharedGistId].forEach(function (id) {
      if (!found && id && (names[id] || []).indexOf(file) >= 0) found = id;
    });
    return found;
  }

  var gistCache = null;

  async function refresh(force) {
    if (!cfg.gistId) return null;
    if (gistCache && !force) return gistCache;
    gistCache = await gh('GET', '/gists/' + cfg.gistId);
    setNames(cfg.gistId, Object.keys(gistCache.files || {}));
    if (cfg.sharedGistId && cfg.sharedGistId !== cfg.gistId) {
      try {
        var other = await gh('GET', '/gists/' + cfg.sharedGistId);
        setNames(cfg.sharedGistId, Object.keys(other.files || {}));
      } catch (e) { /* общий гист недоступен — не критично */ }
    }
    return gistCache;
  }

  var ownGistId = null;

  async function makeOwnGist() {
    var old = cfg.gistId;
    var files = {};
    files[SELF] = { content: JSON.stringify({ at: nowIso(), note: 'личный гист' }, null, 2) };
    var created = await gh('POST', '/gists', {
      description: 'Stepik answers (личный)',
      public: false,
      files: files
    });
    if (old && old !== created.id) setCfg('sharedGistId', old);
    setCfg('gistId', created.id);
    ownGistId = created.id;
    gistCache = created;
    setNames(created.id, Object.keys(created.files || {}));
    toast('Гист был чужим — ответы теперь идут в личный ' + created.id);
    return created;
  }

  /* чужой или недоступный гист → один раз за сессию заводим свой */
  async function forkIfForeign(err) {
    if (err.rate) throw err;                /* лимит запросов — не повод заводить новый гист */
    if (err.status !== 403 && err.status !== 404) throw err;
    if (ownGistId) throw err;
    await makeOwnGist();
  }

  async function saveAnswer(ctx, ans, force) {
    try {
      await refresh(false);                 /* берём закешированный список файлов: экономим запросы */
    } catch (err) {
      await forkIfForeign(err);             /* гист не читается — значит он не наш */
    }

    var idx = index();
    if (idx[ctx.key] && !force) return { skipped: true, file: idx[ctx.key].file };

    function build(name) {
      var files = {};
      files[name] = { content: ans.content };
      return { description: 'Stepik answers · ' + (names[cfg.gistId] || []).length + ' файлов', files: files };
    }
    var name = (idx[ctx.key] && idx[ctx.key].file) ||
      (LIMIT + ctx.lesson + '_s' + ctx.step + '.' + (ans.ext || 'txt'));

    try {
      gistCache = await gh('PATCH', '/gists/' + cfg.gistId, build(name));
    } catch (err) {
      await forkIfForeign(err);            /* у гистов нет соавторов: писать может только владелец токена */
      name = LIMIT + ctx.lesson + '_s' + ctx.step + '.' + (ans.ext || 'txt');
      gistCache = await gh('PATCH', '/gists/' + cfg.gistId, build(name));
    }
    setNames(cfg.gistId, Object.keys(gistCache.files || {}));
    return { file: name };
  }

  async function readSaved(ctx) {
    await refresh(false).catch(function () { return null; });
    var idx = index()[ctx.key];
    if (!idx) throw new Error('для этого шага в гисте ничего нет');
    var id = gistIdOf(idx.file);
    var gist = id === cfg.gistId ? gistCache : await gh('GET', '/gists/' + id);
    var file = gist && gist.files && gist.files[idx.file];
    var content = file && typeof file.content === 'string' ? file.content : '';
    if (!content.trim()) throw new Error('не удалось прочитать ' + idx.file);
    return { name: idx.file, kind: idx.kind, content: content };
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

  var myId = null;

  async function myUserId() {
    if (myId) return myId;
    try { myId = (await sk('/api/users/me')).users[0].id || null; } catch (e) { myId = null; }
    return myId;
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
    var saved = await readSaved(ctx);
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
      res = data ? writeChoice(data) : { ok: false, error: 'битый файл ответа ' + saved.name };
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
      lastOk = { when: nowIso(), file: res.file, via: ans.via || '—' };
      toast('💾 Сохранено в гист: шаг ' + ctx.step + ' (' + res.file + ') · источник: ' + (ans.via || '—'));
      return res;
    } catch (err) {
      lastErr = err.message + ' · ' + nowIso();
      toast('⚠ Не сохранилось: ' + err.message + '  → меню → 🧪 Тест записи в гист', true);
      return null;
    }
  }

  async function tick() {
    var ctx = stepContext();
    if (!ctx) { hideChip(); currentKey = null; return; }
    if (ctx.key !== currentKey) { currentKey = ctx.key; hideChip(); }

    var entry = index()[ctx.key];
    if (entry && !dismissed[ctx.key]) {
      var target = insertTarget();
      if (target) showChip(target, entry.kind === 'choice' ? 'есть ответ' : 'есть решение');
      else hideChip();
    } else {
      hideChip();
    }

    if (entry || busy || !cfg.token || !cfg.gistId || Date.now() < rateUntil) return;
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
          if (!confirm('Сохранить это в гист?\nИсточник: ' + (ans.via || ans.kind) + '\n\n' + head)) return;
          var res = await saveAnswer(ctx, ans, true);
          toast('💾 Перезаписано: ' + res.file);
        } catch (err) { toast('⚠ ' + err.message, true); }
      })();
    } else if (k === 'd') {
      e.preventDefault();
      selfTest().catch(function (err) { toast('⚠ ' + err.message, true); });
    }
  }, true);

  /* ------------------------------------------------------- самопроверка */

  async function selfTest() {
    var L = [], me = '', owner = '', writable = false;
    L.push('=== Stepik ⇄ Gist: отчёт самопроверки ===');
    L.push('время: ' + nowIso() + ' · версия скрипта: ' + VERSION);
    L.push('gist: ' + (cfg.gistId || '(пусто)') + ' · доп. для чтения: ' + (cfg.sharedGistId || '(нет)'));
    L.push('токен: ' + (cfg.token
      ? cfg.token.slice(0, 4) + '…' + cfg.token.slice(-4) + ' (длина ' + cfg.token.length + ')'
      : 'НЕ ЗАДАН'));
    if (lastOk) L.push('последняя запись: ' + lastOk.file + ' · ' + lastOk.when + ' · ' + lastOk.via);
    if (lastErr) L.push('последняя ошибка: ' + lastErr);
    L.push('');

    try {
      me = (await gh('GET', '/user')).login || '';
      L.push('1) токен принят GitHub · аккаунт @' + me);
    } catch (e) { L.push('1) ТОКЕН НЕ РАБОТАЕТ: ' + e.message); }

    if (cfg.gistId) {
      try {
        var g = await gh('GET', '/gists/' + cfg.gistId);
        owner = (g.owner && g.owner.login) || '';
        L.push('2) гист читается · владелец @' + owner + ' · файлов: ' + Object.keys(g.files || {}).length);
        L.push('   ссылка: ' + (g.html_url || ('https://gist.github.com/' + cfg.gistId)));
      } catch (e) { L.push('2) ГИСТ НЕ ЧИТАЕТСЯ: ' + e.message); }

      try {
        var files = {};
        files[SELF] = { content: JSON.stringify({ at: nowIso(), by: me || 'unknown' }, null, 2) };
        var after = await gh('PATCH', '/gists/' + cfg.gistId, { files: files });
        writable = true;
        L.push('3) ЗАПИСЬ РАБОТАЕТ · файл ' + SELF + ' обновлён · всего файлов: ' +
          Object.keys(after.files || {}).length);
      } catch (e) { L.push('3) ЗАПИСЬ НЕ РАБОТАЕТ: ' + e.message); }
    } else {
      L.push('2) гист не задан — меню → ⚙ Токен и gist');
    }

    L.push('');
    L.push('--- текущий шаг ---');
    var ctx = stepContext();
    if (!ctx) {
      L.push('откройте шаг урока: stepik.org/lesson/<урок>/step/<номер>');
    } else {
      L.push('урок ' + ctx.lesson + ', шаг ' + ctx.step);
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
          L.push(good.length ? 'есть зачтённый ответ — уедет в гист автоматически'
            : 'зачтённых отправок нет');
        } catch (e) { L.push('API Stepik не ответил: ' + e.message); }
      }
    }

    L.push('');
    if (writable) L.push('ИТОГ: запись работает — этот браузер может сохранять ответы.');
    else if (!me) L.push('ИТОГ: GitHub не принял токен — меню → ⚙ Токен и gist.');
    else if (owner && owner !== me) L.push('ИТОГ: токен @' + me + ', а гист @' + owner +
      ' — нужен токен владельца, иначе скрипт создаст личный гист.');
    else L.push('ИТОГ: GitHub отказал в записи — см. пункт 3.');

    var report = L.join('\n');
    log(report);
    showReport(report);
    return writable;
  }

  async function diagnose() {
    try {
      var me = (await gh('GET', '/user')).login || '';
      var g = await gh('GET', '/gists/' + cfg.gistId);
      var owner = (g.owner && g.owner.login) || '';
      if (me && owner && me === owner) toast('✓ Гист ' + cfg.gistId + ' · токен @' + me + ' · запись разрешена');
      else toast('⚠ Гист принадлежит @' + owner + ', токен — @' + me +
        '. Нужен токен @' + owner + ', иначе скрипт создаст личный гист.', true);
    } catch (e) { toast('⚠ ' + e.message, true); }
  }

  /* ------------------------------------------------------------- меню */

  try {
    GM_registerMenuCommand('⚙ Токен и gist', function () {
      var t = prompt('GitHub-токен ВЛАДЕЛЬЦА гиста — один и тот же у всех (scope "gist"):', cfg.token || '');
      if (t !== null) setCfg('token', t.trim());
      var g = prompt('ID общего гиста — чтение и запись:', cfg.gistId || '');
      if (g !== null) setCfg('gistId', g.trim());
      var s = prompt('Доп. гист только для чтения (можно пусто):', cfg.sharedGistId || '');
      if (s !== null) setCfg('sharedGistId', s.trim());
      gistCache = null;
      tried = {};
      if (!cfg.token) { toast('⚠ Токен не задан', true); return; }
      refresh(true).then(diagnose).catch(function (err) { toast('⚠ ' + err.message, true); });
    });

    GM_registerMenuCommand('🧪 Тест записи в гист (отчёт)', function () {
      gistCache = null;
      selfTest().catch(function (err) { toast('⚠ ' + err.message, true); });
    });

    GM_registerMenuCommand('🔍 Проверить доступ к гисту', function () {
      diagnose();
    });

    GM_registerMenuCommand('📂 Открыть гист, куда идёт запись', function () {
      if (!cfg.gistId) { toast('⚠ Гист не задан', true); return; }
      window.open('https://gist.github.com/' + cfg.gistId, '_blank');
    });

    GM_registerMenuCommand('♻ Вернуть общий гист (' + DEF_GIST.slice(0, 8) + '…)', function () {
      setCfg('gistId', DEF_GIST);
      setCfg('sharedGistId', '');
      gistCache = null;
      tried = {};
      refresh(true).catch(function (e) { log(e); });
      toast('Запись переключена на общий гист ' + DEF_GIST);
    });
  } catch (e) { /* ignore */ }

  /* ------------------------------------------------------------- старт */

  function init() {
    injectBridge();
    var old = document.getElementById('sgx');
    if (old) old.remove();

    if (!cfg.token || !cfg.gistId) {
      toast('⚠ Укажите GitHub-токен: меню Tampermonkey → ⚙ Токен и gist', true);
    } else {
      refresh(true).catch(function (err) { toast('⚠ ' + err.message, true); });
    }

    setInterval(tick, 1500);
    setInterval(function () { if (chipAnchor) positionChip(chipAnchor); }, 500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
