const { spawn } = require('child_process');

const claude = spawn('claude', [
  '-p',
  '--output-format', 'stream-json',
  '--input-format', 'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--disable-slash-commands'
], { stdio: ['pipe', 'pipe', 'pipe'] });

claude.stdout.on('data', (chunk) => {
  const lines = chunk.toString().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
        process.stdout.write(`[DELTA] "${msg.event.delta.text}"\n`);
      } else if (msg.type === 'assistant') {
        process.stdout.write(`[ASSISTANT] ${JSON.stringify(msg.message.content)}\n`);
      } else if (msg.type === 'result') {
        process.stdout.write(`[RESULT] "${msg.result}"\n`);
      } else {
        process.stdout.write(`[${msg.type}:${msg.subtype || msg.event?.type || ''}]\n`);
      }
    } catch (e) {}
  }
});

claude.stderr.on('data', (chunk) => {
  const s = chunk.toString().trim();
  if (s) console.log('[STDERR]', s.slice(0, 300));
});

claude.on('exit', (code) => {
  console.log('[EXIT] code:', code);
});

setTimeout(() => {
  const msg = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'Привет, скажи одно слово' }
  });
  console.log('[SEND]', msg);
  claude.stdin.write(msg + '\n');

  setTimeout(() => { claude.stdin.end(); }, 15000);
}, 3000);
