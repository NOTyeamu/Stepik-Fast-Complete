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

function doPost(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return json({ ok: false, error: 'занято, попробуйте ещё раз' });
  }
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
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
