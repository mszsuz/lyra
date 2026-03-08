// Тест: полный флоу через реальный Роутер 1С (ЕХТ_Лира_Роутер)
// Роутер подключён к Centrifugo через автономный сервер (WebSocketКлиент "Роутер")
//
// Сценарий:
//   1. Чат подключается с общим JWT → publish hello в session:lobby
//   2. Роутер (1С) получает hello → генерирует JWT → hello_ack в канал сессии
//   3. Чат переподключается с chat_jwt → авто-подписка на канал сессии
//   4. Мобильное подключается с mobile_jwt → auth → auth_ack + balance_update
//
// Запуск: node test-router-flow.mjs
// Требует: Node.js 22+, Centrifugo на :11000, Роутер 1С подключён

const HMAC_SECRET = 'wtFBIxmI__UGR23PSDUPgjj5MlkCtgAT1-WHkZmMGOX5MKge30CmyeOL3Ai2U-F_qCOPyAIjbkbAkP5W_RP7Yw';
const API_KEY = 'tDpoTDd7P36lD-jf9jWRf4IBmeuK6QwZOfzoBhpq5fr4qMvzDscDy9xZmnjNY1czwxXneXaPETB4q2AC0H5z6g';
const WS_URL = 'ws://localhost:11000/connection/websocket';
const BASE = 'http://localhost:11000';

// --- JWT generation (minimal, for testing) ---
function base64url(str) {
  return Buffer.from(str).toString('base64url');
}

async function signJWT(payload) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const signature = Buffer.from(sig).toString('base64url');
  return `${data}.${signature}`;
}

// --- Centrifugo helpers ---
function parseMessages(data) {
  return data.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function connectClient(name, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let cmdId = 1;
    const handlers = [];

    ws.addEventListener('message', event => {
      for (const msg of parseMessages(event.data)) {
        // Ping/pong
        if (Object.keys(msg).length === 0) {
          ws.send('{}');
          return;
        }
        for (const h of [...handlers]) h(msg);
      }
    });

    ws.addEventListener('open', () => {
      console.log(`[${name}] WebSocket open, sending connect...`);
      ws.send(JSON.stringify({ id: cmdId++, connect: { token } }));
    });

    ws.addEventListener('error', e => {
      console.error(`[${name}] Error:`, e.message);
      reject(e);
    });

    const connectHandler = msg => {
      if (msg.id === 1 && msg.connect) {
        console.log(`[${name}] Connected! client=${msg.connect.client}`);
        if (msg.connect.subs) {
          console.log(`[${name}] Auto-subscribed:`, Object.keys(msg.connect.subs).join(', '));
        }
        handlers.splice(handlers.indexOf(connectHandler), 1);
        resolve({ ws, cmdId: () => cmdId++, name, handlers, clientId: msg.connect.client });
      }
      if (msg.id === 1 && msg.error) {
        console.error(`[${name}] Connect error:`, msg.error);
        reject(new Error(msg.error.message));
      }
    };
    handlers.push(connectHandler);
  });
}

function waitFor(client, predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      handlers.splice(handlers.indexOf(handler), 1);
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
    const handlers = client.handlers;
    handlers.push(handler);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ==================== MAIN ====================
async function main() {
  console.log('=== Тест: полный флоу через Роутер 1С ===\n');

  // --- Шаг 1: Чат подключается с общим JWT ---
  console.log('--- Шаг 1: Чат подключается к Centrifugo ---');
  const lobbyJwt = await signJWT({
    sub: 'lobby-user',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const chat = await connectClient('CHAT', lobbyJwt);

  // --- Шаг 2: Чат публикует hello ---
  console.log('\n--- Шаг 2: Чат публикует hello в session:lobby ---');

  // Слушаем push на канале сессии (hello_ack придёт туда)
  const helloAckPromise = waitFor(chat, msg => {
    // hello_ack придёт через push.subscribe (Server API подпишет нас)
    // а потом push.pub с data
    if (msg.push?.pub?.data?.type === 'hello_ack') {
      return msg.push.pub.data;
    }
  });

  chat.ws.send(JSON.stringify({
    id: chat.cmdId(),
    publish: {
      channel: 'session:lobby',
      data: {
        type: 'hello',
        form_id: 'test-form-' + Date.now(),
        config_name: 'БухгалтерияПредприятия',
        config_version: '3.0.191.41',
        config_id: '',
        computer: 'TEST-PC',
        connection_string: 'File="C:\\Base";',
      },
    },
  }));
  console.log('[CHAT] hello published');

  // --- Шаг 3: Ждём hello_ack от Роутера ---
  console.log('\n--- Шаг 3: Ждём hello_ack от Роутера 1С ---');
  let helloAck;
  try {
    helloAck = await helloAckPromise;
  } catch (e) {
    console.error('\n[FAIL]', e.message);
    console.error('Проверьте:');
    console.error('  1. Centrifugo запущен на :11000');
    console.error('  2. Роутер 1С подключён (автономный сервер)');
    console.error('  3. Заголовки centrifugo-channels и centrifugo-handler заданы');
    chat.ws.close();
    process.exit(1);
  }

  console.log('[CHAT] Получен hello_ack!');
  console.log('  session_id:', helloAck.session_id);
  console.log('  status:', helloAck.status);
  console.log('  chat_jwt:', helloAck.chat_jwt?.substring(0, 40) + '...');
  console.log('  mobile_jwt:', helloAck.mobile_jwt?.substring(0, 40) + '...');

  const sessionId = helloAck.session_id;
  const chatJwt = helloAck.chat_jwt;
  const mobileJwt = helloAck.mobile_jwt;

  if (!chatJwt || !mobileJwt || !sessionId) {
    console.error('\n[FAIL] hello_ack неполный — нет chat_jwt, mobile_jwt или session_id');
    chat.ws.close();
    process.exit(1);
  }

  // --- Шаг 4: Чат переподключается с chat_jwt ---
  console.log('\n--- Шаг 4: Чат переподключается с chat_jwt ---');
  chat.ws.close();
  await sleep(500);
  const chatSession = await connectClient('CHAT-SESSION', chatJwt);
  console.log(`[CHAT-SESSION] Подключён к каналу session:${sessionId}`);

  // --- Шаг 5: Мобильное подключается с mobile_jwt ---
  console.log('\n--- Шаг 5: Мобильное подключается с mobile_jwt ---');
  const mobile = await connectClient('MOBILE', mobileJwt);
  console.log(`[MOBILE] Подключён к каналу session:${sessionId}`);

  // --- Шаг 6: Мобильное отправляет auth ---
  console.log('\n--- Шаг 6: Мобильное отправляет auth ---');

  const authAckPromise = waitFor(mobile, msg => {
    if (msg.push?.pub?.data?.type === 'auth_ack') {
      return msg.push.pub.data;
    }
  });

  const balancePromise = waitFor(mobile, msg => {
    if (msg.push?.pub?.data?.type === 'balance_update') {
      return msg.push.pub.data;
    }
  });

  // Чат тоже должен видеть auth_ack
  const chatAuthAckPromise = waitFor(chatSession, msg => {
    if (msg.push?.pub?.data?.type === 'auth_ack') {
      return msg.push.pub.data;
    }
  });

  mobile.ws.send(JSON.stringify({
    id: mobile.cmdId(),
    publish: {
      channel: `session:${sessionId}`,
      data: {
        type: 'auth',
        user_id: 'test-user-' + Date.now(),
        device_id: 'test-device-' + Date.now(),
      },
    },
  }));
  console.log('[MOBILE] auth published');

  // --- Шаг 7: Ждём auth_ack и balance_update ---
  console.log('\n--- Шаг 7: Ждём auth_ack и balance_update ---');

  try {
    const authAck = await authAckPromise;
    console.log('[MOBILE] Получен auth_ack!');
    console.log('  status:', authAck.status);
    console.log('  session_id:', authAck.session_id);

    const chatAuthAck = await chatAuthAckPromise;
    console.log('[CHAT-SESSION] Тоже получил auth_ack!');
    console.log('  status:', chatAuthAck.status);

    const balance = await balancePromise;
    console.log('[MOBILE] Получен balance_update!');
    console.log('  balance:', balance.balance, balance.currency);
  } catch (e) {
    console.error('\n[FAIL]', e.message);
    chatSession.ws.close();
    mobile.ws.close();
    process.exit(1);
  }

  // --- Итог ---
  console.log('\n========================================');
  console.log('[SUCCESS] Полный флоу через Роутер 1С работает!');
  console.log('  1. hello → hello_ack (JWT, session_id) ✓');
  console.log('  2. Переподключение с chat_jwt ✓');
  console.log('  3. Мобильное с mobile_jwt ✓');
  console.log('  4. auth → auth_ack ok ✓');
  console.log('  5. balance_update ✓');
  console.log('  6. Чат видит auth_ack ✓');
  console.log('========================================\n');

  chatSession.ws.close();
  mobile.ws.close();
  setTimeout(() => process.exit(0), 500);
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
