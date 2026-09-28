/*
 * Единственный, кто пишет в answers/. Запускается из .github/workflows/answers.yml.
 *
 * Делает одно из двух:
 *  1) если это push в answers/ не от робота — откатывает папку к состоянию до этого
 *     push'а (так ответы нельзя ни испортить, ни удалить даже тем, у кого есть токен
 *     с правом Contents: write);
 *  2) иначе переносит всё из inbox/ в answers/ и пересобирает index.json.
 *     Уже существующий ответ не перезаписывается никогда — папка только пополняется.
 *
 * Скрипт идемпотентный: повторный запуск ничего не меняет.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DIR, writeIndex } from './make-index.mjs';

const INBOX = 'inbox';
const BOT_EMAIL = 'stepik-answers-bot@users.noreply.github.com';
const NAME_RE = /^(l\d{1,12}_s\d{1,6})\.([a-z0-9]+)$/i;
const MAX_BYTES = 200 * 1024;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const before = (process.env.BEFORE_SHA || '').trim();
const committer = (process.env.COMMITTER_EMAIL || '').trim();
const message = (process.env.COMMIT_MESSAGE || '').trim();
const event = (process.env.EVENT_NAME || '').trim();
const known = before && !/^0+$/.test(before);

/* 1) откат самовольных правок в answers/.
   Правки руками разрешены, если коммит от имени робота или в сообщении есть [answers-ok]. */
if (event === 'push' && known && committer !== BOT_EMAIL && !/\[answers-ok\]/.test(message)) {
  /* если git не сработает — падаем громко: молча пропустить защиту хуже, чем упасть */
  const touched = git('diff', '--name-only', before, 'HEAD', '--', DIR);
  if (touched) {
    console.log('в ' + DIR + '/ писали не через робота (' + (committer || 'без коммиттера') + ') — откатываю');
    git('checkout', before, '--', DIR);
    /* checkout не удаляет файлы, которых не было в той версии, — убираем их сами */
    const good = new Set(git('ls-tree', '--name-only', '-r', before, DIR).split('\n').filter(Boolean));
    for (const name of readdirSync(DIR)) {
      const full = DIR + '/' + name;
      if (!good.has(full)) { unlinkSync(full); console.log('удалён лишний файл ' + full); }
    }
    writeIndex();
    process.exit(0);
  }
}

/* 2) перенос очереди */
if (!existsSync(INBOX)) {
  console.log('очереди inbox/ нет — нечего переносить');
  writeIndex();
  process.exit(0);
}

mkdirSync(DIR, { recursive: true });
let added = 0, skipped = 0;

for (const name of readdirSync(INBOX)) {
  const src = join(INBOX, name);
  const dst = join(DIR, name);
  const m = NAME_RE.exec(name);
  let keep = false;
  try {
    const content = readFileSync(src, 'utf8');
    keep = !!m && content.trim().length > 0 && Buffer.byteLength(content, 'utf8') <= MAX_BYTES && !existsSync(dst);
    if (keep) { writeFileSync(dst, content, 'utf8'); added++; }
  } catch (e) {
    keep = false;
  }
  if (!keep) skipped++;
  unlinkSync(src);
}

writeIndex();
console.log('перенесено ответов: ' + added + ' · пропущено: ' + skipped +
  ' · всего в папке: ' + Object.keys(JSON.parse(readFileSync(join(DIR, 'index.json'), 'utf8'))).length);
