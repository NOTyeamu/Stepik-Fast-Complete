/*
 * Пересобирает answers/index.json по фактическому содержимому папки answers/.
 *
 * Запускается: из save-answer.mjs (после каждой записи) и руками при переносе
 * старых ответов. Формат индекса задан только здесь — другого источника нет.
 */
import { writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DIR = 'answers';

export function buildIndex(dir = DIR) {
  const index = {};
  if (!existsSync(dir)) return index;
  for (const name of readdirSync(dir).sort()) {
    const m = /^(l\d+_s\d+)\.([a-z0-9]+)$/i.exec(name);
    if (!m) continue;
    const ext = m[2].toLowerCase();
    index[m[1]] = { file: name, ext: ext, kind: ext === 'json' ? 'choice' : 'code' };
  }
  return index;
}

export function writeIndex(dir = DIR) {
  const index = buildIndex(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 1) + '\n', 'utf8');
  return index;
}

/* прямой запуск: node .github/scripts/make-index.mjs */
if (process.argv[1] && process.argv[1].endsWith('make-index.mjs')) {
  const index = writeIndex();
  console.log('в индексе ответов: ' + Object.keys(index).length);
}
