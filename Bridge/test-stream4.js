const { spawn } = require('child_process');

// Просто дамп всего что приходит от claude в stream-json режиме
const claude = spawn('claude', [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--disable-slash-commands'
], { stdio: ['pipe', 'pipe', 'pipe'] });

console.log('[START] Process spawned, pid:', claude.pid);

claude.stdout.on('data', (chunk) => {
  console.log('[STDOUT]', chunk.toString().slice(0, 300));
});

claude.stderr.on('data', (chunk) => {
  console.log('[STDERR]', chunk.toString().slice(0, 300));
});

claude.on('exit', (code) => {
  console.log('[EXIT]', code);
});

// Через 5 секунд отправляем сообщение
setTimeout(() => {
  const msg = '{"type":"user_message","content":"скажи кот"}';
  console.log('[SEND]', msg);
  claude.stdin.write(msg + '\n');
}, 5000);

// Через 20 секунд завершаем
setTimeout(() => {
  console.log('[TIMEOUT] killing...');
  claude.stdin.end();
  claude.kill();
}, 20000);
