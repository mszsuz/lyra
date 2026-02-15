// Тест: подключаемся к bridge, отправляем сообщение через 5 сек (не ждём init)
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3003');

ws.on('open', () => console.log('[1C] connected'));

ws.on('message', (raw) => {
  const text = raw.toString();
  try {
    const msg = JSON.parse(text);
    if (msg.type === 'session') {
      console.log(`[1C] session: ${msg.sessionId}`);
    } else if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta' && msg.event?.delta?.text) {
      process.stdout.write(msg.event.delta.text);
    } else if (msg.type === 'result') {
      console.log(`\n[1C] RESULT: "${msg.result}"`);
      ws.close();
    } else {
      console.log(`[1C] [${msg.type}:${msg.subtype || msg.event?.type || ''}]`);
    }
  } catch (e) {
    console.log(`[1C] raw: ${text.slice(0, 150)}`);
  }
});

ws.on('close', () => { console.log('[1C] disconnected'); process.exit(0); });

// Просто шлём через 10 сек
setTimeout(() => {
  console.log('[1C] sending chat...');
  ws.send(JSON.stringify({ type: 'chat', content: 'Привет, скажи одно слово' }));
}, 10000);

setTimeout(() => { console.log('[1C] timeout'); ws.close(); }, 120000);
