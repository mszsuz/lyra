#!/usr/bin/env node
// Тест: формат push.join и push.leave в Centrifugo v6
// Логируем ВСЕ raw-сообщения чтобы найти формат join/leave

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('./centrifugo/config.json', 'utf-8'));
const SECRET = config.client.token.hmac_secret_key;
const API_KEY = config.http_api.key;
const PORT = config.http_server.port;
const WS_URL = `ws://localhost:${PORT}/connection/websocket`;
const API_URL = `http://localhost:${PORT}/api`;

function generateJWT(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

async function apiCall(method, params) {
  const res = await fetch(`${API_URL}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(params),
  });
  return res.json();
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  console.log('=== Тест: RAW push messages в Centrifugo v6 ===\n');

  // Роутер с channels claim на session:lobby
  const routerJwt = generateJWT({ sub: 'router-1', channels: ['session:lobby'], exp: now + 3600 });

  const router = new WebSocket(WS_URL);
  let routerClientId;

  // Логируем ВСЕ сообщения роутера
  router.addEventListener('message', (e) => {
    const text = typeof e.data === 'string' ? e.data : e.data.toString();
    for (const line of text.split('\n')) {
      if (!line.trim() || line.trim() === '{}') continue;
      console.log(`[Router RAW] ${line}`);
    }
  });

  await new Promise((resolve, reject) => {
    router.addEventListener('open', () => {
      router.send(JSON.stringify({ id: 1, connect: { token: routerJwt, name: 'test-router' } }));
    });
    const h = (e) => {
      const text = typeof e.data === 'string' ? e.data : e.data.toString();
      for (const line of text.split('\n')) {
        if (!line.trim() || line.trim() === '{}') continue;
        try {
          const msg = JSON.parse(line);
          if (msg.connect) {
            routerClientId = msg.connect.client;
            router.removeEventListener('message', h);
            resolve();
          }
        } catch {}
      }
    };
    router.addEventListener('message', h);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  console.log(`\n[Router] client=${routerClientId}\n`);

  await new Promise(r => setTimeout(r, 500));

  // --- Тест 1: Клиент с channels claim ---
  console.log('--- Тест 1: Клиент с channels claim ---');
  const clientJwt1 = generateJWT({ sub: 'chat-test', channels: ['session:lobby'], exp: now + 3600 });
  const client1 = new WebSocket(WS_URL);

  client1.addEventListener('message', (e) => {
    const text = typeof e.data === 'string' ? e.data : e.data.toString();
    for (const line of text.split('\n')) {
      if (!line.trim() || line.trim() === '{}') continue;
      console.log(`[Client1 RAW] ${line}`);
    }
  });

  await new Promise((resolve, reject) => {
    client1.addEventListener('open', () => {
      client1.send(JSON.stringify({ id: 1, connect: { token: clientJwt1 } }));
    });
    const h = (e) => {
      const text = typeof e.data === 'string' ? e.data : e.data.toString();
      for (const line of text.split('\n')) {
        try { if (JSON.parse(line).connect) { client1.removeEventListener('message', h); resolve(); } } catch {}
      }
    };
    client1.addEventListener('message', h);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  console.log('[Client1] Connected');

  await new Promise(r => setTimeout(r, 2000));
  client1.close();
  console.log('[Client1] Closed');
  await new Promise(r => setTimeout(r, 2000));

  // --- Тест 2: Server API subscribe ---
  console.log('\n--- Тест 2: Server API subscribe ---');
  const clientJwt2 = generateJWT({ sub: 'chat-test-2', exp: now + 3600 }); // без channels
  const client2 = new WebSocket(WS_URL);
  let client2Id;

  client2.addEventListener('message', (e) => {
    const text = typeof e.data === 'string' ? e.data : e.data.toString();
    for (const line of text.split('\n')) {
      if (!line.trim() || line.trim() === '{}') continue;
      console.log(`[Client2 RAW] ${line}`);
    }
  });

  await new Promise((resolve, reject) => {
    client2.addEventListener('open', () => {
      client2.send(JSON.stringify({ id: 1, connect: { token: clientJwt2 } }));
    });
    const h = (e) => {
      const text = typeof e.data === 'string' ? e.data : e.data.toString();
      for (const line of text.split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg.connect) { client2Id = msg.connect.client; client2.removeEventListener('message', h); resolve(); }
        } catch {}
      }
    };
    client2.addEventListener('message', h);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  console.log(`[Client2] Connected, client=${client2Id}`);

  console.log('[API] subscribe...');
  const res = await apiCall('subscribe', { user: 'chat-test-2', client: client2Id, channel: 'session:lobby' });
  console.log(`[API] result: ${JSON.stringify(res)}`);

  await new Promise(r => setTimeout(r, 2000));
  client2.close();
  console.log('[Client2] Closed');
  await new Promise(r => setTimeout(r, 2000));

  console.log('\n=== КОНЕЦ ===');
  router.close();
  setTimeout(() => process.exit(0), 500);
}

main().catch(e => { console.error(e); process.exit(1); });
