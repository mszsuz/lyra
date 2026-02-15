// Тест bridge.js — эмулируем 1С-клиент
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3003');

ws.on('open', () => {
  console.log('[1C] connected');
});

ws.on('message', (raw) => {
  const text = raw.toString();
  try {
    const msg = JSON.parse(text);

    if (msg.type === 'session') {
      console.log(`[1C] session: ${msg.sessionId}`);
      // Ждём init от Claude, потом отправляем сообщение
      console.log('[1C] waiting for Claude init...');
    } else if (msg.type === 'system' && msg.subtype === 'init') {
      console.log(`[1C] Claude init OK, sending message...`);
      ws.send(JSON.stringify({ type: 'chat', content: 'Привет! Скажи одно слово.' }));
    } else if (msg.type === 'stream_event') {
      const evt = msg.event;
      if (evt.type === 'content_block_delta' && evt.delta?.text) {
        process.stdout.write(evt.delta.text);
      }
    } else if (msg.type === 'result') {
      console.log(`\n[1C] RESULT: "${msg.result}"`);
    } else if (msg.type === 'claude_exit') {
      console.log(`[1C] Claude exited: ${msg.code}`);
      ws.close();
    } else {
      // Другие события — кратко
      console.log(`[1C] [${msg.type}:${msg.subtype || msg.event?.type || ''}]`);
    }
  } catch (e) {
    console.log(`[1C] raw: ${text.slice(0, 100)}`);
  }
});

ws.on('close', () => {
  console.log('[1C] disconnected');
  process.exit(0);
});

ws.on('error', (e) => {
  console.error('[1C] error:', e.message);
});

// Таймаут 60 сек
setTimeout(() => {
  console.log('[1C] timeout, closing');
  ws.close();
}, 60000);
