// Тест: минимальный путь Чат → Centrifugo → Claude
//
// 1. Генерируем JWT с channels claim для канала сессии
// 2. Запускаем centrifugo-stdio с Claude CLI (claude -p --output-format stream-json)
// 3. Подключаемся как "Чат" к тому же каналу
// 4. Публикуем {type: "chat", text: "вопрос"} → centrifugo-stdio → Claude → ответ в канал
// 5. Чат получает стриминг ответа Claude
//
// Запуск: node test-chat-claude.mjs

import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HMAC_SECRET = 'wtFBIxmI__UGR23PSDUPgjj5MlkCtgAT1-WHkZmMGOX5MKge30CmyeOL3Ai2U-F_qCOPyAIjbkbAkP5W_RP7Yw';
const WS_URL = 'ws://localhost:11000/connection/websocket';

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
  return data.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
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

function waitForMessages(client, predicate, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(() => {
      client.handlers.splice(client.handlers.indexOf(handler), 1);
      // Возвращаем что собрали (не ошибка — Claude может долго думать)
      resolve(collected);
    }, timeoutMs);

    const handler = msg => {
      const result = predicate(msg);
      if (result === 'done') {
        clearTimeout(timer);
        client.handlers.splice(client.handlers.indexOf(handler), 1);
        resolve(collected);
      } else if (result) {
        collected.push(result);
      }
    };
    client.handlers.push(handler);
  });
}

// --- Main test ---

async function main() {
  const sessionId = `test-claude-${Date.now()}`;
  const sessionChannel = `session:${sessionId}`;

  console.log('=== Тест: Чат → Centrifugo → Claude ===');
  console.log(`    Канал: ${sessionChannel}\n`);

  // 1. JWT для bridge и для Чата
  const now = Math.floor(Date.now() / 1000);
  const bridgeJWT = generateJWT({
    sub: `bridge-${sessionId}`,
    channels: [sessionChannel],
    exp: now + 600,
  });
  const chatJWT = generateJWT({
    sub: `chat-${sessionId}`,
    channels: [sessionChannel],
    exp: now + 600,
  });
  console.log('[1] JWT сгенерированы');

  // 2. Конфиг: claude-wrapper.mjs — читает JSON из stdin, вызывает claude -p, пишет JSON в stdout
  const wrapperPath = new URL('./claude-wrapper.mjs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1').replaceAll('%20', ' ');
  const configPath = join(tmpdir(), `lyra-claude-${sessionId}.json`);
  writeFileSync(configPath, JSON.stringify({
    program: 'node',
    args: [wrapperPath],
  }));
  console.log(`[2] Config: ${configPath}`);

  // 3. Запускаем centrifugo-stdio с Claude
  const bridge = spawn(BRIDGE_EXE, [
    '--url', WS_URL,
    '--token', bridgeJWT,
    '--channel', sessionChannel,
    '--listen', 'chat',
    '--config', configPath,
    '--name', `bridge-claude-${sessionId}`,
  ]);

  bridge.stderr.on('data', data => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      console.log(`    [bridge] ${line}`);
    }
  });

  bridge.on('exit', code => {
    console.log(`    [bridge] exited with code ${code}`);
  });

  // Ждём подключения bridge
  await new Promise(resolve => setTimeout(resolve, 3000));
  console.log('[3] centrifugo-stdio + Claude запущены');

  // 4. Подключаемся как Чат
  const chat = await connectClient('CHAT', chatJWT);
  if (chat.autoSubs.includes(sessionChannel)) {
    console.log(`[4] Чат подключён, авто-подписка на ${sessionChannel}`);
  } else {
    console.error(`[FAIL] Чат НЕ подписан на ${sessionChannel}`);
    cleanup();
    return;
  }

  // 5. Слушаем ответы от Claude (через centrifugo-stdio → claude-wrapper)
  let fullText = '';
  const responsePromise = waitForMessages(chat, msg => {
    const data = msg.push?.pub?.data;
    if (!data) return false;

    // Пропускаем своё же сообщение (chat)
    if (data.type === 'chat') return false;

    // assistant_output от claude-wrapper
    if (data.type === 'assistant_output' && data.text) {
      fullText += data.text;
      return 'done';
    }

    // Любой другой тип — логируем
    if (data.type) {
      console.log(`    [event] ${data.type}: ${JSON.stringify(data).slice(0, 200)}`);
      return data;
    }
    return false;
  }, 120000);

  // 6. Отправляем вопрос
  const question = 'Сколько будет 2+2? Ответь одним числом.';
  chat.ws.send(JSON.stringify({
    id: chat.cmdId(),
    publish: {
      channel: sessionChannel,
      data: {
        type: 'chat',
        text: question,
      },
    },
  }));
  console.log(`[5] Отправлен вопрос: "${question}"\n`);
  console.log('--- Ответ Claude ---');

  // 7. Ждём ответ
  const events = await responsePromise;
  console.log('\n--- Конец ответа ---\n');

  if (fullText || events.length > 0) {
    console.log('========================================');
    console.log('[OK] Тест пройден!');
    console.log(`  Получено ${events.length} событий от Claude`);
    if (fullText) console.log(`  Текст: "${fullText.trim()}"`);
    console.log('  Чат → Centrifugo → centrifugo-stdio → Claude → ответ → Centrifugo → Чат');
    console.log('========================================\n');
  } else {
    console.error('[TIMEOUT] Ответ от Claude не получен за 60 секунд');
  }

  cleanup();

  function cleanup() {
    chat.ws.close();
    bridge.kill();
    try { unlinkSync(configPath); } catch {}
    setTimeout(() => process.exit(0), 1000);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
