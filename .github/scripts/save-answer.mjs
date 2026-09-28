/*
 * Записывает один ответ в answers/ и пересобирает answers/index.json.
 *
 * Вход:  PAYLOAD = base64(JSON {key, kind, ext, content, author})
 * Запускается из .github/workflows/answers.yml, руками не нужен.
 * Скрипт идемпотентный: повторный запуск с тем же ответом ничего не меняет.
 */
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, writeIndex } from './make-index.mjs';

const KEY_RE = /^l\d{1,12}_s\d{1,6}$/;
const MAX_BYTES = 200 * 1024;

function die(msg) {
  console.error('ОШИБКА: ' + msg);
  process.exit(1);
}

const raw = process.env.PAYLOAD || '';
if (!raw) die('не передан PAYLOAD');

let item;
try {
  item = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
} catch (e) {
  die('payload не разбирается: ' + e.message);
}

const key = String(item.key || '');
if (!KEY_RE.test(key)) die('плохой ключ шага: ' + JSON.stringify(key));

const content = String(item.content || '');
if (!content.trim()) die('пустой ответ');
if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) die('ответ больше 200 КБ');

const kind = item.kind === 'choice' ? 'choice' : 'code';
const ext = (String(item.ext || (kind === 'choice' ? 'json' : 'txt')).toLowerCase()
  .replace(/[^a-z0-9]/g, '').slice(0, 8)) || 'txt';
const file = key + '.' + ext;

mkdirSync(DIR, { recursive: true });
const target = join(DIR, file);
const same = existsSync(target) && readFileSync(target, 'utf8') === content;
writeFileSync(target, content, 'utf8');

const index = writeIndex();

console.log((same ? 'уже было: ' : 'записано: ') + file +
  ' · всего ответов в папке: ' + Object.keys(index).length +
  (item.author ? ' · автор: ' + item.author : ''));
