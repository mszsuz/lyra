#!/usr/bin/env node
'use strict';

// Тест: две "1С" одновременно — разные сессии, разные ответы
const WebSocket = require('ws');
const BRIDGE_URL = 'ws://localhost:3003';

function log(name, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${name}] ${msg}`);
}

function connectClient(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(BRIDGE_URL);
    const state = { name, ws, sessionId: null, deltas: '', resultText: '', gotResult: false };

    ws.on('open', () => log(name, 'connected'));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'session') {
          state.sessionId = msg.sessionId;
          log(name, `session: ${msg.sessionId.slice(0, 8)}...`);
        } else if (msg.type === 'stream_event' && msg.event?.delta?.text) {
          state.deltas += msg.event.delta.text;
        } else if (msg.type === 'result') {
          state.gotResult = true;
          state.resultText = msg.result || '';
          log(name, `result: "${state.resultText.slice(0, 80)}"`);
        }
      } catch (e) {}
    });

    ws.on('error', (e) => log(name, `error: ${e.message}`));

    setTimeout(() => resolve(state), 1000);
  });
}

function waitResult(state, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (state.gotResult) { clearInterval(check); resolve(true); }
    }, 500);
    setTimeout(() => { clearInterval(check); resolve(false); }, timeoutMs);
  });
}

async function main() {
  console.log('═══ ТЕСТ: Две сессии одновременно ═══\n');

  // Подключаем двух клиентов
  const client1 = await connectClient('1С-А');
  const client2 = await connectClient('1С-Б');

  // Проверяем разные сессии
  const diffSessions = client1.sessionId !== client2.sessionId;
  log('TEST', `Разные session ID: ${diffSessions ? '✅' : '❌'} (${client1.sessionId?.slice(0,8)} vs ${client2.sessionId?.slice(0,8)})`);

  // Ждём инициализации обоих Claude
  log('TEST', 'waiting 20s for both Claude to init...');
  await new Promise(r => setTimeout(r, 20000));

  // Отправляем РАЗНЫЕ вопросы одновременно
  log('1С-А', 'sending: "2+2=?"');
  log('1С-Б', 'sending: "столица Франции?"');

  client1.ws.send(JSON.stringify({ type: 'chat', content: '2+2=? Ответь только числом.' }));
  client2.ws.send(JSON.stringify({ type: 'chat', content: 'Столица Франции? Одно слово.' }));

  // Ждём оба результата
  const [got1, got2] = await Promise.all([
    waitResult(client1, 120000),
    waitResult(client2, 120000),
  ]);

  console.log('\n═══ ИТОГИ ═══');

  const checks = [
    { name: 'Разные session ID', ok: diffSessions },
    { name: `1С-А получила ответ`, ok: got1, detail: client1.resultText.slice(0, 50) },
    { name: `1С-Б получила ответ`, ok: got2, detail: client2.resultText.slice(0, 50) },
    {
      name: 'Ответы не перепутались',
      ok: got1 && got2 &&
        (client1.resultText.includes('4') || client1.deltas.includes('4')) &&
        (client2.resultText.toLowerCase().includes('париж') || client2.deltas.toLowerCase().includes('париж')),
      detail: `А="${client1.resultText.slice(0,30)}" Б="${client2.resultText.slice(0,30)}"`
    },
  ];

  let passed = 0;
  for (const c of checks) {
    const icon = c.ok ? '✅' : '❌';
    console.log(`  ${icon} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    if (c.ok) passed++;
  }
  console.log(`\n  ${passed}/${checks.length} passed`);

  client1.ws.close();
  client2.ws.close();
  process.exit(passed === checks.length ? 0 : 1);
}

main();
