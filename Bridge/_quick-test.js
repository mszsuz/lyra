#!/usr/bin/env node
'use strict';

// Quick integration test for bridge-sdk.js
// Run bridge first: node bridge-sdk.js --port 3098
// Then run: node _quick-test.js --port 3098

const WebSocket = require('ws');
const PORT = Number(process.argv[3]) || 3098;

const ws = new WebSocket(`ws://localhost:${PORT}/`);
let phase = 'connect';

ws.on('open', () => console.log('Connected'));

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === 'session') {
    console.log('Session:', msg.sessionId.slice(0, 8));
    ws.send(JSON.stringify({
      type: 'hello',
      config: 'БухгалтерияПредприятия',
      version: '3.0.150.27',
      userName: 'Тестов Т.Т.',
      userRole: 'user'
    }));
  }
  else if (msg.type === 'hello_ack') {
    phase = 'greeting';
    console.log('hello_ack OK. Waiting for greeting...');
  }
  else if (msg.type === 'stream_event' && phase === 'greeting') {
    const t = (msg.event && msg.event.delta && msg.event.delta.text) || '';
    if (t) process.stdout.write(t);
  }
  else if (msg.type === 'result' && phase === 'greeting') {
    console.log('');
    console.log(`--- Greeting done, cost: $${msg.costUsd} ---`);
    phase = 'chat';
    console.log('Sending: Что такое УСН?');
    ws.send(JSON.stringify({ type: 'chat', content: 'Что такое УСН?' }));
  }
  else if (msg.type === 'stream_event' && phase === 'chat') {
    const t = (msg.event && msg.event.delta && msg.event.delta.text) || '';
    if (t) process.stdout.write(t);
  }
  else if (msg.type === 'result' && phase === 'chat') {
    console.log('');
    console.log('--- Chat done ---');
    console.log('Result length:', (msg.result || '').length, 'chars');
    console.log('Usage:', JSON.stringify(msg.usage));
    console.log('Cost: $' + msg.costUsd);
    console.log('Duration:', msg.durationMs + 'ms');
    ws.close();
    setTimeout(() => process.exit(0), 500);
  }
  else if (msg.type === 'error') {
    console.log('ERROR:', msg.reason, msg.message);
    if (phase !== 'greeting' && phase !== 'chat') {
      ws.close();
      setTimeout(() => process.exit(1), 500);
    }
  }
});

ws.on('error', (e) => {
  console.log('WS Error:', e.message);
  process.exit(1);
});

setTimeout(() => {
  console.log('TIMEOUT (120s)');
  ws.close();
  process.exit(1);
}, 120000);
