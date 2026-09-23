// One checkpoint: fetch teammates' published changes and show their latest status.
// This never merges, checks out, commits, pushes or overwrites working files.
import { execFileSync } from 'node:child_process';

const role = process.argv[2];
if (!['frontend', 'backend'].includes(role)) {
  console.error('Использование: npm run team:sync -- frontend|backend');
  process.exit(1);
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 25000 });
try {
  console.log('Рабочая копия:\n' + git('status', '--short', '--branch').trim());
  git('fetch', 'origin');
  console.log('\nПолучены опубликованные изменения. Рабочие файлы не изменены.');
  const peer = role === 'frontend' ? 'backend' : 'frontend';
  const ref = `origin/feat/${peer}`;
  try { git('rev-parse', '--verify', ref); }
  catch {
    console.log(`\nВетка ${ref} ещё не опубликована. Продолжайте независимую работу по контракту.`);
    process.exit(0);
  }
  console.log(`\nПоследние изменения ${peer}:\n` + git('log', '-3', '--format=%h %s', ref).trim());
  console.log('\nСтатус второго участника:');
  try { console.log(git('show', `${ref}:docs/${peer.toUpperCase()}_STATUS.md`).trim()); }
  catch { console.log('Файл статуса ещё не опубликован. Смотрите коммиты этой ветки.'); }
  console.log(`\nДля просмотра изменений: git diff HEAD...${ref} --stat`);
  console.log('Объединяйте код отдельно, после проверки и сохранения своей работы.');
} catch (error) {
  console.error('Не удалось синхронизироваться: ' + (error.stderr?.toString().trim() || error.message));
  process.exitCode = 1;
}
