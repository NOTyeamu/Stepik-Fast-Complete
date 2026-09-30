/**
 * Stepik ⇄ Ответы — облачное хранилище на Google Apps Script.
 *
 * Куда это вставлять и как задеплоить — в README рядом (server/README.md).
 * Коротко: Google-таблица → Расширения → Apps Script → вставить этот код →
 * Развернуть как веб-приложение (Запуск от имени: я, Доступ: все) → скопировать URL.
 *
 * Что делает:
 *   GET  ?index=1        → список ключей без содержимого (лёгкий, для скобки «вставить»)
 *   GET  ?key=l123_s4    → один ответ целиком (нужен в момент вставки)
 *   GET  ?all=1          → всё содержимое (для бэкапа)
 *   POST {items:[...]}   → сохранить/обновить ответы (пачкой, по ключу)
 *   POST {ai:{...}}      → НЕОБЯЗАТЕЛЬНО: прокси для ИИ, ключ лежит в свойствах
 *                          скрипта и в браузер не попадает (см. ниже)
 *   GET  ?ai=1           → проверка прокси: задан ли ключ, сколько запросов
 *                          ушло за сутки, какой суточный предел
 *
 * Формат записи: {key:"l1793281_s8", lesson:"1793281", step:8, kind:"code",
 *                 ext:"cs", content:"...", author:"Имя на Stepik"}
 *
 * Секретов нет: доступ определяется только самим URL веб-приложения.
 * Если URL утечёт — переразверни приложение, ссылка сменится.
 */

var SHEET_NAME = 'answers';
var MAX_CONTENT = 200 * 1024; // один ответ больше 200 КБ не принимаем
var KEY_RE = /^l\d{1,12}_s\d{1,6}$/;

/* Таблица считает строку формулой, если она начинается с = или +. Ответ, который
   начинается так же, экранируем апострофом и снимаем его при чтении — иначе
   Google молча превратит решение в пустую ячейку. */
function escapeCell(s) {
  return /^[=+]/.test(s) ? "'" + s : s;
}
function unescapeCell(s) {
  return /^'[=+]/.test(s) ? s.slice(1) : s;
}

function sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(['key', 'lesson', 'step', 'kind', 'ext', 'content', 'author', 'updated']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function rows() {
  var values = sheet().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[0]) continue;
    out.push({
      key: String(r[0]),
      lesson: String(r[1]),
      step: Number(r[2]) || 0,
      kind: String(r[3] || 'code'),
      ext: String(r[4] || 'txt'),
      content: unescapeCell(String(r[5] == null ? '' : r[5])),
      author: String(r[6] || ''),
      updated: r[7] instanceof Date ? r[7].toISOString() : String(r[7] || '')
    });
  }
  return out;
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    /* Открой адрес веб-приложения с ?ai=1 в браузере — сразу видно, всё ли
       настроено: задан ли ключ, сколько запросов ушло за сутки, какой предел.
       Сам ключ не показываем никогда. */
    if (p.ai === '1') {
      var props = PropertiesService.getScriptProperties();
      var q = aiQuota(false);
      return json({
        ok: true,
        ai: !!props.getProperty('AI_KEY'),
        endpointSet: !!props.getProperty('AI_ENDPOINT'),
        usedToday: q.used,
        dailyLimit: q.limit,
        day: q.day,
        hint: props.getProperty('AI_KEY')
          ? 'всё готово: впиши этот адрес в скрипт — Tampermonkey, «🌐 Прокси ИИ»'
          : 'не хватает свойства AI_KEY: Настройки проекта → Свойства скрипта'
      });
    }
    var all = rows();
    if (p.key) {
      for (var i = 0; i < all.length; i++) {
        if (all[i].key === String(p.key)) {
          return json({ ok: true, item: all[i] });
        }
      }
      return json({ ok: true, item: null });
    }
    if (p.all === '1') {
      return json({ ok: true, count: all.length, items: all });
    }
    // по умолчанию — лёгкий индекс, без содержимого ответов
    var index = all.map(function (x) {
      return { key: x.key, kind: x.kind, ext: x.ext, updated: x.updated };
    });
    return json({ ok: true, count: index.length, items: index });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

/* --------------------------------------------------------------- прокси ИИ --
 * Зачем это здесь.
 *
 * Ключ доступа к ИИ НЕЛЬЗЯ спрятать в браузере: скрипт, который им пользуется,
 * всё равно приносит ключ в браузер, и любой, кто поставил скрипт, может его
 * достать. Единственный способ спрятать по-настоящему — не держать ключ
 * в браузере: тогда запросы идут сюда, а ключ лежит здесь, в свойствах скрипта,
 * и наружу не отдаётся никогда.
 *
 * Включить (один раз):
 *   1. В редакторе Apps Script: «Настройки проекта» → «Свойства скрипта» →
 *      добавить свойство AI_KEY со своим ключом доступа к ИИ.
 *      Необязательное свойство AI_ENDPOINT — адрес, если он другой.
 *   2. Развернуть заново и вписать адрес веб-приложения в скрипт:
 *      значок Tampermonkey → «🌐 Прокси ИИ (если есть)».
 *
 * Как только адрес прокси задан, скрипт ходит только через него: ключа
 * в браузере больше нет вообще.
 *
 * ЧЕСТНО ПРО ОГРАНИЧЕНИЯ GOOGLE: один запрос должен уложиться в 60 секунд
 * (столько даёт UrlFetchApp), а всё приложение — в 6 минут. Сильная модель
 * с длинными размышлениями в это не всегда укладывается; тогда лучше работать
 * напрямую со своим ключом.
 * --------------------------------------------------------------------------- */

var AI_DEFAULT_ENDPOINT = 'https://api.reformboss.com/v1/chat/completions';
var AI_DEFAULT_LIMIT = 300;   // запросов в сутки, если свой предел не задан

/* Суточный счётчик запросов.
 *
 * Зачем: адрес прокси лежит в скрипте, а скрипт публичный — значит через прокси
 * может ходить кто угодно. Ключ при этом не утекает, но кредиты тратятся. Лимит
 * делает расход предсказуемым: даже если адрес разойдётся по людям, больше
 * заданного числа запросов в сутки через прокси не пройдёт.
 *
 * Считаем под блокировкой: запросы могут идти одновременно, и без неё часть
 * обращений не попала бы в счётчик. */
function aiQuota(bump) {
  var props = PropertiesService.getScriptProperties();
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { /* без блокировки тоже сойдёт */ }
  try {
    var today = Utilities.formatDate(new Date(), 'UTC', 'yyyy-MM-dd');
    var day = props.getProperty('AI_DAY') || '';
    var used = day === today ? Number(props.getProperty('AI_USED') || 0) : 0;
    var limit = Number(props.getProperty('AI_DAILY_LIMIT') || AI_DEFAULT_LIMIT);
    if (bump) {
      used++;
      props.setProperties({ AI_DAY: today, AI_USED: String(used) });
    }
    return { day: today, used: used, limit: limit };
  } finally {
    lock.releaseLock();
  }
}

function aiProxy(body) {
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty('AI_KEY');
  if (!key) {
    return { status: 500, text: '{"error":{"message":"AI_KEY не задан в свойствах скрипта"}}' };
  }
  var q = aiQuota(false);
  if (q.used >= q.limit) {
    return { status: 429, text: JSON.stringify({
      error: { message: 'суточный лимит прокси исчерпан (' + q.limit + ' запросов)' },
      status: 429
    }) };
  }

  var endpoint = props.getProperty('AI_ENDPOINT') || AI_DEFAULT_ENDPOINT;
  var payload = {
    model: body.model,
    messages: body.messages,
    max_tokens: body.max_tokens || 4000,
    temperature: body.temperature == null ? 0.2 : body.temperature
  };
  var res = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 200) aiQuota(true);      // в счётчик идут только удачные запросы
  return { status: code, text: res.getContentText() };
}

function doPost(e) {
  var body0 = null;
  try { body0 = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body0 = null; }

  /* Запрос к ИИ через прокси. Отвечаем ВСЕГДА кодом 200 — так устроен
     ContentService, — поэтому код ответа провайдера кладём в тело: скрипт
     читает поле status и понимает, что случилось. */
  if (body0 && body0.ai) {
    var r = aiProxy(body0.ai);
    var out = r.text;
    if (r.status !== 200) {
      var why = '';
      try { why = String((JSON.parse(r.text).error || {}).message || ''); } catch (err2) { why = ''; }
      out = JSON.stringify({ error: { message: why || 'сервис ИИ ответил ' + r.status }, status: r.status });
    }
    return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return json({ ok: false, error: 'занято, попробуйте ещё раз' });
  }
  try {
    var body = body0 || {};
    var items = body.items || (body.key ? [body] : []);
    var sh = sheet();

    var data = sh.getDataRange().getValues();
    var at = {};                       // ключ → номер строки
    for (var i = 1; i < data.length; i++) {
      if (data[i][0]) at[String(data[i][0])] = i + 1;
    }

    var saved = 0, skipped = 0;
    items.forEach(function (it) {
      var key = String((it && it.key) || '');
      var content = String((it && it.content) || '');
      if (!KEY_RE.test(key) || !content || content.length > MAX_CONTENT) { skipped++; return; }
      var row = [
        key,
        String(it.lesson || ''),
        Number(it.step) || 0,
        String(it.kind || 'code'),
        String(it.ext || 'txt'),
        escapeCell(content),
        String(it.author || ''),
        new Date()
      ];
      if (at[key]) sh.getRange(at[key], 1, 1, row.length).setValues([row]);
      else { sh.appendRow(row); at[key] = sh.getLastRow(); }
      saved++;
    });

    return json({ ok: true, saved: saved, skipped: skipped, total: Object.keys(at).length });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}
