// Тест: centrifugo-stdio — Centrifugo channel ↔ CLI stdin/stdout bridge
//
// 1. Генерируем JWT с channels claim для канала сессии
// 2. Запускаем centrifugo-stdio с echo-программой (node -e "readline → JSON.stringify → stdout")
// 3. Подключаемся как "Чат" к каналу
// 4. Публикуем billing_ok → centrifugo-stdio получает → echo пишет в stdout → publish обратно
// 5. Чат получает ответ echo-программы
//
// Запуск: node test-centrifugo-stdio.mjs

import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HMAC_SECRET = 'wtFBIxmI__UGR23PSDUPgjj5MlkCtgAT1-WHkZmMGOX5MKge30CmyeOL3Ai2U-F_qCOPyAIjbkbAkP5W_RP7Yw';
const API_KEY = 'tDpoTDd7P36lD-jf9jWRf4IBmeuK6QwZOfzoBhpq5fr4qMvzDscDy9xZmnjNY1czwxXneXaPETB4q2AC0H5z6g';
const WS_URL = 'ws://localhost:11000/connection/websocket';
const API_URL = 'http://localhost:11000/api';

const BRIDGE_EXE = String.raw`C:\1ext.ru\projects\github.com\ЕХТ_Центрифуга\centrifugo_stdio\target\release\centrifugo-stdio.exe`;

// --- JWT ---

function generateJWT(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', HMAC_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

// --- Centrifugo helpers ---

function parseMessages(data) {
  return data.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function apiCall(method, params) {
  const res = await fetch(`${API_URL}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(params),
  });
  return res.json();
}

function connectClient(name, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let cmdId = 1;
    const handlers = [];

    ws.addEventListener('message', event => {
      for (const msg of parseMessages(event.data)) {
        for (const h of [...handlers]) h(msg);
      }
    });

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: cmdId++, connect: { token } }));
    });

    const connectHandler = msg => {
      if (msg.id === 1 && msg.connect) {
        handlers.splice(handlers.indexOf(connectHandler), 1);
        resolve({
          ws, cmdId: () => cmdId++, name, handlers,
          clientId: msg.connect.client,
          autoSubs: msg.connect.subs ? Object.keys(msg.connect.subs) : [],
        });
      }
      if (msg.id === 1 && msg.error) {
        reject(new Error(`[${name}] Connect error: ${JSON.stringify(msg.error)}`));
      }
    };
    handlers.push(connectHandler);

    ws.addEventListener('error', e => reject(new Error(`[${name}] WS error`)));
  });
}

function waitFor(client, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.handlers.splice(client.handlers.indexOf(handler), 1);
      reject(new Error(`[${client.name}] Timeout waiting for message`));
    }, timeoutMs);

    const handler = msg => {
      const result = predicate(msg);
      if (result !== undefined && result !== false) {
        clearTimeout(timer);
        client.handlers.splice(client.handlers.indexOf(handler), 1);
        resolve(result);
      }
    };
    client.handlers.push(handler);
  });
}

// --- Echo program ---
// Reads JSON lines from stdin, adds "echo": true, writes back to stdout

const ECHO_SCRIPT = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  try {
    const data = JSON.parse(line);
    data.echo = true;
    data.echo_timestamp = Date.now();
    console.log(JSON.stringify(data));
  } catch(e) {
    console.log(JSON.stringify({error: 'parse_error', raw: line}));
  }
});
`;

// --- Main test ---

async function main() {
  const sessionId = `test-stdio-${Date.now()}`;
  const sessionChannel = `session:${sessionId}`;

  console.log('=== Тест centrifugo-stdio ===');
  console.log(`    Канал: ${sessionChannel}\n`);

  // 1. Генерируем JWT для bridge и для Чата
  const now = Math.floor(Date.now() / 1000);
  const bridgeJWT = generateJWT({
    sub: `bridge-${sessionId}`,
    channels: [sessionChannel],
    exp: now + 300,
  });
  const chatJWT = generateJWT({
    sub: `chat-${sessionId}`,
    channels: [sessionChannel],
    exp: now + 300,
  });
  console.log('[1] JWT сгенерированы');

  // 2. Создаём config файл для echo-программы
  const configPath = join(tmpdir(), `lyra-test-${sessionId}.json`);
  writeFileSync(configPath, JSON.stringify({
    program: 'node',
    args: ['-e', ECHO_SCRIPT],
  }));
  console.log(`[2] Config: ${configPath}`);

  // 3. Запускаем centrifugo-stdio
  const bridge = spawn(BRIDGE_EXE, [
    '--url', WS_URL,
    '--token', bridgeJWT,
    '--channel', sessionChannel,
    '--listen', 'billing_ok',
    '--config', configPath,
    '--name', `bridge-test-${sessionId}`,
  ]);

  bridge.stderr.on('data', data => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      console.log(`    [bridge] ${line}`);
    }
  });

  bridge.on('exit', code => {
    console.log(`    [bridge] exited with code ${code}`);
  });

  // Ждём подключения bridge (по логам)
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log('[3] centrifugo-stdio запущен');

  // 4. Подключаемся как Чат
  const chat = await connectClient('CHAT', chatJWT);
  if (chat.autoSubs.includes(sessionChannel)) {
    console.log(`[4] Чат подключён, авто-подписка на ${sessionChannel}`);
  } else {
    console.error(`[FAIL] Чат НЕ подписан на ${sessionChannel}`);
    cleanup();
    return;
  }

  // 5. Ждём echo-ответа от bridge
  const echoPromise = waitFor(chat, msg => {
    const data = msg.push?.pub?.data;
    if (data && data.echo === true) {
      return data;
    }
  }, 10000);

  // 6. Публикуем billing_ok в канал (как Биллинг)
  const testText = 'Почему у контрагента Ромашка не заполнен КПП?';
  chat.ws.send(JSON.stringify({
    id: chat.cmdId(),
    publish: {
      channel: sessionChannel,
      data: {
        type: 'billing_ok',
        session_id: sessionId,
        text: testText,
        form_id: 'test-form-id',
      },
    },
  }));
  console.log(`[5] Опубликован billing_ok: "${testText}"`);

  // 7. Получаем echo-ответ
  try {
    const echoData = await echoPromise;
    console.log(`[6] Получен echo-ответ от bridge:`);
    console.log(`    type: ${echoData.type}`);
    console.log(`    text: ${echoData.text}`);
    console.log(`    echo: ${echoData.echo}`);
    console.log(`    echo_timestamp: ${echoData.echo_timestamp}`);

    if (echoData.type === 'billing_ok' && echoData.text === testText && echoData.echo === true) {
      console.log('\n========================================');
      console.log('[OK] Тест пройден!');
      console.log('  1. centrifugo-stdio подключился к Centrifugo');
      console.log('  2. Подписался на канал сессии');
      console.log('  3. Получил billing_ok из канала');
      console.log('  4. Передал в stdin echo-программы');
      console.log('  5. Прочитал stdout echo-программы');
      console.log('  6. Опубликовал результат обратно в канал');
      console.log('  7. Чат получил echo-ответ');
      console.log('========================================\n');
    } else {
      console.error('[FAIL] Данные не совпадают');
    }
  } catch (e) {
    console.error(`[FAIL] ${e.message}`);
  }

  cleanup();

  function cleanup() {
    chat.ws.close();
    bridge.kill();
    try { unlinkSync(configPath); } catch {}
    setTimeout(() => process.exit(0), 500);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
