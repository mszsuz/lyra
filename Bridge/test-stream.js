const { spawn } = require('child_process');

const claude = spawn('claude', [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--disable-slash-commands'
], { stdio: ['pipe', 'pipe', 'pipe'] });

let output = '';

claude.stdout.on('data', (chunk) => {
  const lines = chunk.toString().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      // Показываем только интересные типы
      if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
        process.stdout.write(`[DELTA] ${msg.event.delta.text}\n`);
      } else if (msg.type === 'assistant') {
        process.stdout.write(`[FULL] ${JSON.stringify(msg.message.content)}\n`);
      } else if (msg.type === 'result') {
        process.stdout.write(`[RESULT] ${msg.result}\n`);
      } else {
        process.stdout.write(`[${msg.type}${msg.subtype ? ':' + msg.subtype : ''}] ${msg.event?.type || ''}\n`);
      }
    } catch (e) {
      process.stdout.write(`[RAW] ${line.slice(0, 100)}\n`);
    }
  }
});

claude.stderr.on('data', (chunk) => {
  // ignore stderr
});

claude.on('exit', (code) => {
  process.stdout.write(`\n[EXIT] code=${code}\n`);
});

// Отправляем сообщение через 1 секунду (дождёмся инициализации)
setTimeout(() => {
  const msg = JSON.stringify({ type: 'user_message', content: 'Привет, скажи одно слово' });
  process.stdout.write(`[SEND] ${msg}\n`);
  claude.stdin.write(msg + '\n');

  // Закрываем stdin через 15 секунд
  setTimeout(() => {
    claude.stdin.end();
  }, 15000);
}, 2000);
