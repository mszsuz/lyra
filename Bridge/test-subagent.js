// Тест: может ли Claude-роутер запустить субагента и получить промежуточные результаты?
// Запуск: node test-subagent.js

const { spawn } = require('child_process');

const claude = spawn('claude', [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--verbose',
], { stdio: ['pipe', 'pipe', 'pipe'] });

let allOutput = [];

claude.stdout.on('data', (chunk) => {
  const lines = chunk.toString().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      const ts = new Date().toISOString().slice(11, 23);

      // Краткое описание типа сообщения
      let desc = msg.type;
      if (msg.type === 'stream_event' && msg.event?.delta?.text) {
        desc = `delta: "${msg.event.delta.text.slice(0, 60)}"`;
      } else if (msg.type === 'stream_event' && msg.event?.type) {
        desc = `stream: ${msg.event.type}`;
      } else if (msg.subtype) {
        desc = `${msg.type}:${msg.subtype}`;
      }

      console.log(`[${ts}] ${desc}`);
      allOutput.push({ ts, msg });
    } catch (e) {
      console.log(`[raw] ${line.slice(0, 100)}`);
    }
  }
});

claude.stderr.on('data', (chunk) => {
  const text = chunk.toString().trim();
  if (text) console.log(`[stderr] ${text.slice(0, 200)}`);
});

claude.on('close', (code) => {
  console.log(`\n=== Claude exited with code ${code} ===`);
  console.log(`Total messages: ${allOutput.length}`);

  // Ищем признаки субагента
  const toolUses = allOutput.filter(o =>
    o.msg.type === 'stream_event' &&
    o.msg.event?.type === 'content_block_start' &&
    o.msg.event?.content_block?.type === 'tool_use'
  );
  console.log(`Tool use blocks: ${toolUses.length}`);

  // Сохраняем полный лог
  require('fs').writeFileSync(
    'test-subagent-output.json',
    JSON.stringify(allOutput.map(o => o.msg), null, 2)
  );
  console.log('Full output saved to test-subagent-output.json');
});

// Отправляем запрос — просим использовать Task tool
setTimeout(() => {
  const message = {
    type: 'user',
    message: {
      role: 'user',
      content: 'Use the Task tool to launch a subagent (subagent_type: "general-purpose", model: "sonnet") with this prompt: "Calculate what is 127 * 389. Show your reasoning step by step. Then give the final answer." Return the subagent result to me.'
    }
  };

  console.log('--- Sending message ---');
  claude.stdin.write(JSON.stringify(message) + '\n');
}, 1000);

// Таймаут
setTimeout(() => {
  console.log('\n--- TIMEOUT 120s ---');
  claude.kill();
}, 120000);
