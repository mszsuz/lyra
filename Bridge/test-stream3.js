const { spawn } = require('child_process');

// Пробуем ещё форматы и ждём init перед отправкой
const formats = [
  'скажи слово кот',
  JSON.stringify({ content: 'скажи слово кот' }),
  JSON.stringify({ text: 'скажи слово кот' }),
  JSON.stringify({ prompt: 'скажи слово кот' }),
  JSON.stringify({ type: 'user_input', content: 'скажи слово кот' }),
  JSON.stringify({ type: 'user_input_event', content: 'скажи слово кот' }),
];

function testFormat(msg) {
  return new Promise((resolve) => {
    console.log(`\n=== Тест: ${msg.slice(0, 80)} ===`);

    const claude = spawn('claude', [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--disable-slash-commands'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let gotResponse = false;
    let initDone = false;

    claude.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);

          // Ждём init
          if (parsed.type === 'system' && parsed.subtype === 'init') {
            initDone = true;
            console.log(`  [INIT] tools: ${parsed.tools?.length}, sending message...`);
            claude.stdin.write(msg + '\n');
          }

          if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta') {
            console.log(`  [DELTA] "${parsed.event.delta.text}"`);
            gotResponse = true;
          } else if (parsed.type === 'result') {
            console.log(`  [RESULT] "${parsed.result?.slice(0, 100)}"`);
          }
        } catch (e) {}
      }
    });

    claude.stderr.on('data', (chunk) => {
      const s = chunk.toString();
      if (s.includes('Error')) console.log(`  [STDERR] ${s.trim().slice(0, 150)}`);
    });

    claude.on('exit', (code) => {
      console.log(`  [EXIT] code=${code}, gotResponse=${gotResponse}, initDone=${initDone}`);
      resolve(gotResponse);
    });

    setTimeout(() => {
      claude.stdin.end();
      claude.kill();
    }, 12000);
  });
}

async function main() {
  for (const fmt of formats) {
    const success = await testFormat(fmt);
    if (success) {
      console.log(`\n✅ РАБОЧИЙ ФОРМАТ: ${fmt}`);
      break;
    }
  }
}

main();
