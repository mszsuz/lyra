const { spawn } = require('child_process');

// Пробуем разные форматы входящих сообщений
const formats = [
  { type: 'user_message', content: 'скажи слово кот' },
  { role: 'user', content: 'скажи слово кот' },
  { type: 'human', content: 'скажи слово кот' },
  { type: 'message', role: 'user', content: 'скажи слово кот' },
];

let currentFormat = 0;

function testFormat(format) {
  return new Promise((resolve) => {
    console.log(`\n=== Тест формата: ${JSON.stringify(format)} ===`);

    const claude = spawn('claude', [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--disable-slash-commands'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let gotResponse = false;
    let timeout;

    claude.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
            console.log(`  [DELTA] "${msg.event.delta.text}"`);
            gotResponse = true;
          } else if (msg.type === 'result') {
            console.log(`  [RESULT] "${msg.result}"`);
          } else if (msg.type !== 'system') {
            console.log(`  [${msg.type}] ${msg.event?.type || ''}`);
          }
        } catch (e) {}
      }
    });

    claude.stderr.on('data', () => {});

    claude.on('exit', (code) => {
      clearTimeout(timeout);
      console.log(`  [EXIT] code=${code}, gotResponse=${gotResponse}`);
      resolve(gotResponse);
    });

    // Отправляем через 2 сек
    setTimeout(() => {
      const msg = JSON.stringify(format);
      console.log(`  [SEND] ${msg}`);
      claude.stdin.write(msg + '\n');

      // Ждём 10 сек на ответ
      timeout = setTimeout(() => {
        console.log(`  [TIMEOUT] Завершаем...`);
        claude.stdin.end();
        claude.kill();
      }, 10000);
    }, 2000);
  });
}

async function main() {
  for (const format of formats) {
    const success = await testFormat(format);
    if (success) {
      console.log(`\n✅ РАБОЧИЙ ФОРМАТ: ${JSON.stringify(format)}`);
      break;
    }
  }
}

main();
