#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const PORT = 3003;
const ws = new WebSocket(`ws://localhost:${PORT}`);

const t0 = Date.now();
const mark = (label) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

let sessionId = null;
let gotInit = false;
let gotFirstDelta = false;

ws.on('open', () => mark('WebSocket connected'));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === 'session' && !sessionId) {
    sessionId = msg.sessionId;
    mark(`session: ${sessionId.slice(0, 8)}...`);
    // Отправляем сообщение сразу, не ждём init
    const chat = JSON.stringify({ type: 'chat', content: '2+2=? Ответь только числом.' });
    ws.send(chat);
    mark('chat sent');
  }

  if (msg.type === 'system' && msg.subtype === 'init' && !gotInit) {
    gotInit = true;
    mark('init received');
  }

  // Первая дельта текста
  if (!gotFirstDelta && msg.type === 'stream_event' &&
      msg.event?.type === 'content_block_delta' &&
      msg.event?.delta?.type === 'text_delta') {
    gotFirstDelta = true;
    mark(`first delta: "${msg.event.delta.text}"`);
  }

  if (msg.type === 'result') {
    mark(`result: "${msg.result}"`);
    console.log(`\n═══ ИТОГО ═══`);
    console.log(`  Общее время до ответа: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    ws.close();
    setTimeout(() => process.exit(0), 500);
  }
});

ws.on('error', (e) => {
  console.error('WS error:', e.message);
  process.exit(1);
});

// Таймаут
setTimeout(() => {
  console.error('TIMEOUT 120s');
  process.exit(1);
}, 120000);
