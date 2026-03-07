// Тест: полный сценарий подключения (шаги 1-7 из INTERACTION-SCHEMA.md)
//
//   1. Чат: connect (общий JWT) + publish hello (без subscribe на lobby)
//   2. Роутер: получает hello, генерирует chat_jwt + mobile_jwt с channels claim
//   3. Роутер: Server API subscribe + publish hello_ack
//   4. Чат: получает hello_ack, отключается, переподключается с chat_jwt
//      -> channels claim = авто-подписка на канал сессии (не нужен отдельный subscribe)
//   5. Мобильное: подключается с mobile_jwt (из QR), авто-подписка на канал сессии
//   6. Мобильное: отправляет auth с user_id
//   7. Роутер: получает auth, отправляет auth_ack
//   8. Чат и Мобильное: оба получают auth_ack
//
// Запуск: node test-full-flow.mjs

import { createHmac } from 'node:crypto';

const HMAC_SECRET = 'wtFBIxmI__UGR23PSDUPgjj5MlkCtgAT1-WHkZmMGOX5MKge30CmyeOL3Ai2U-F_qCOPyAIjbkbAkP5W_RP7Yw';
const API_KEY = 'tDpoTDd7P36lD-jf9jWRf4IBmeuK6QwZOfzoBhpq5fr4qMvzDscDy9xZmnjNY1czwxXneXaPETB4q2AC0H5z6g';
const ROUTER_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyb3V0ZXItMSIsImV4cCI6MTc3MzQ3OTA5MiwiaWF0IjoxNzcyODc0MjkyfQ.PxtQmLONTsl-dhwB8cU7gcQykS794OV8A3uhv1Mb5ac';
const LOBBY_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjaGF0LWNsaWVudC0xIiwiZXhwIjoxNzczNDc5MTA0LCJpYXQiOjE3NzI4NzQzMDR9.QJnTw5lZgcF1FqqdN9dLD4l5p5_TknWfFeOk3VvkVaw';
const WS_URL = 'ws://localhost:11000/connection/websocket';
const API_URL = 'http://localhost:11000/api';

// --- JWT generation (HMAC SHA-256) ---

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
      reject(new Error(`[${client.name}] Timeout`));
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

async function subscribe(client, channel) {
  client.ws.send(JSON.stringify({ id: client.cmdId(), subscribe: { channel } }));
  const id = client.cmdId() - 1; // cmdId already incremented
  await waitFor(client, msg => {
    if (msg.subscribe !== undefined) return true;
    if (msg.error) throw new Error(`[${client.name}] Subscribe error: ${JSON.stringify(msg.error)}`);
  });
}

// --- Main test ---

async function main() {
  const sessionId = `test-${Date.now()}`;
  const sessionChannel = `session:${sessionId}`;

  console.log('=== Полный сценарий подключения (шаги 1-7) ===');
  console.log(`    Канал сессии: ${sessionChannel}\n`);

  // ===== Шаг 0: Роутер подключается и подписывается на lobby =====
  const router = await connectClient('ROUTER', ROUTER_TOKEN);
  await subscribe(router, 'session:lobby');
  console.log('[0] Роутер подключён, подписан на lobby');

  // ===== Шаг 1-2: Чат подключается с общим JWT, публикует hello =====
  const chatLobby = await connectClient('CHAT-LOBBY', LOBBY_TOKEN);
  console.log(`[1] Чат подключён к lobby (client=${chatLobby.clientId})`);

  // Роутер ждёт hello
  const helloPromise = waitFor(router, msg => {
    if (msg.push?.channel === 'session:lobby' && msg.push?.pub?.data?.type === 'hello') {
      return { data: msg.push.pub.data, clientUUID: msg.push.pub.info?.client };
    }
  });

  chatLobby.ws.send(JSON.stringify({
    id: chatLobby.cmdId(),
    publish: {
      channel: 'session:lobby',
      data: {
        type: 'hello',
        configuration: 'БухгалтерияПредприятия',
        version: '3.0.191.41',
        computer: 'BUHPC-01',
        connection_string: 'Srvr="srv1c";Ref="buh_prod";',
      },
    },
  }));
  console.log('[2] Чат опубликовал hello (без subscribe на lobby)');

  // ===== Шаг 3: Роутер обрабатывает hello =====
  const hello = await helloPromise;
  console.log(`[3] Роутер получил hello (pub.info.client = ${hello.clientUUID})`);

  // Генерируем 2 JWT с channels claim
  const now = Math.floor(Date.now() / 1000);
  const chatJWT = generateJWT({
    sub: `chat-${sessionId}`,
    channels: [sessionChannel],
    exp: now + 86400,
  });
  const mobileJWT = generateJWT({
    sub: `mobile-${sessionId}`,
    channels: [sessionChannel],
    exp: now + 300, // 5 минут
  });
  console.log('    Сгенерированы chat_jwt и mobile_jwt');

  // Server API subscribe — подписать конкретное соединение Чата на канал сессии
  const chatUser = 'chat-client-1'; // sub из общего JWT
  await apiCall('subscribe', { user: chatUser, client: hello.clientUUID, channel: sessionChannel });
  console.log(`    Server API subscribe: client=${hello.clientUUID} -> ${sessionChannel}`);

  // Чат ждёт hello_ack
  const ackPromise = waitFor(chatLobby, msg => {
    if (msg.push?.channel === sessionChannel && msg.push?.pub?.data?.type === 'hello_ack') {
      return msg.push.pub.data;
    }
  });

  // Server API publish — hello_ack
  await apiCall('publish', {
    channel: sessionChannel,
    data: {
      type: 'hello_ack',
      session_id: sessionId,
      status: 'awaiting_auth',
      chat_jwt: chatJWT,
      mobile_jwt: mobileJWT,
    },
  });
  console.log('    Server API publish: hello_ack');

  // ===== Шаг 4: Чат получает hello_ack =====
  const ack = await ackPromise;
  console.log(`[4] Чат получил hello_ack (status=${ack.status})`);

  // ===== Шаг 5: Чат переподключается с chat_jwt =====
  chatLobby.ws.close();

  const chat = await connectClient('CHAT', ack.chat_jwt);
  if (chat.autoSubs.includes(sessionChannel)) {
    console.log(`[5] Чат переподключился с chat_jwt — авто-подписка на ${sessionChannel}`);
  } else {
    console.error(`[FAIL] Чат НЕ авто-подписан на ${sessionChannel}. autoSubs: ${chat.autoSubs}`);
    process.exit(1);
  }

  // Роутер тоже подписывается на канал сессии (чтобы получать auth и сообщения)
  await subscribe(router, sessionChannel);
  console.log('    Роутер подписан на канал сессии');

  // ===== Шаг 6: Мобильное подключается с mobile_jwt (из QR) =====
  const mobile = await connectClient('MOBILE', ack.mobile_jwt);
  if (mobile.autoSubs.includes(sessionChannel)) {
    console.log(`[6] Мобильное подключилось с mobile_jwt — авто-подписка на ${sessionChannel}`);
  } else {
    console.error(`[FAIL] Мобильное НЕ авто-подписано на ${sessionChannel}. autoSubs: ${mobile.autoSubs}`);
    process.exit(1);
  }

  // ===== Шаг 7: Мобильное отправляет auth =====
  const authPromise = waitFor(router, msg => {
    if (msg.push?.channel === sessionChannel && msg.push?.pub?.data?.type === 'auth') {
      return msg.push.pub.data;
    }
  });

  mobile.ws.send(JSON.stringify({
    id: mobile.cmdId(),
    publish: {
      channel: sessionChannel,
      data: { type: 'auth', user_id: 'user-12345-phone-verified' },
    },
  }));
  console.log('[7] Мобильное отправило auth (user_id=user-12345-phone-verified)');

  const authData = await authPromise;
  console.log(`    Роутер получил auth на канале сессии`);

  // ===== Роутер отправляет auth_ack =====
  const chatAckPromise = waitFor(chat, msg => {
    if (msg.push?.channel === sessionChannel && msg.push?.pub?.data?.type === 'auth_ack') {
      return msg.push.pub.data;
    }
  });
  const mobileAckPromise = waitFor(mobile, msg => {
    if (msg.push?.channel === sessionChannel && msg.push?.pub?.data?.type === 'auth_ack') {
      return msg.push.pub.data;
    }
  });

  // Роутер публикует через Server API (как в реальном сценарии)
  await apiCall('publish', {
    channel: sessionChannel,
    data: { type: 'auth_ack', session_id: sessionId, status: 'ok' },
  });
  console.log('    Роутер отправил auth_ack через Server API');

  const chatAuthAck = await chatAckPromise;
  const mobileAuthAck = await mobileAckPromise;
  console.log(`    Чат получил auth_ack (status=${chatAuthAck.status})`);
  console.log(`    Мобильное получило auth_ack (status=${mobileAuthAck.status})`);

  // ===== Бонус: проверяем что сообщения на канале видят все =====
  const chatMsgPromise = waitFor(chat, msg => {
    if (msg.push?.channel === sessionChannel && msg.push?.pub?.data?.type === 'chat') {
      return msg.push.pub.data;
    }
  });
  const mobileMsgPromise = waitFor(mobile, msg => {
    if (msg.push?.channel === sessionChannel && msg.push?.pub?.data?.type === 'chat') {
      return msg.push.pub.data;
    }
  });

  // Имитируем стриминг ответа Claude через Server API (как делал бы Роутер/Адаптер)
  await apiCall('publish', {
    channel: sessionChannel,
    data: { type: 'chat', content: 'У контрагента Ромашка не заполнен КПП, потому что...' },
  });

  const chatMsg = await chatMsgPromise;
  const mobileMsg = await mobileMsgPromise;
  console.log('\n[+] Бонус: сообщение на канале видят оба:');
  console.log(`    Чат: "${chatMsg.content.substring(0, 40)}..."`);
  console.log(`    Мобильное: "${mobileMsg.content.substring(0, 40)}..."`);

  // ===== Итог =====
  console.log(`\n========================================`);
  console.log(`[OK] Полный сценарий пройден:`);
  console.log(`  1. Чат: connect + publish hello (без subscribe на lobby)`);
  console.log(`  2. Роутер: получил hello с pub.info.client`);
  console.log(`  3. JWT с channels claim -> авто-подписка (без subscribe)`);
  console.log(`  4. Server API subscribe + publish -> hello_ack доставлен`);
  console.log(`  5. Чат: переподключился с chat_jwt (авто-подписка)`);
  console.log(`  6. Мобильное: подключилось с mobile_jwt (авто-подписка)`);
  console.log(`  7. auth -> auth_ack: Чат и Мобильное получили`);
  console.log(`  8. Сообщения на канале видят все подписчики`);
  console.log(`========================================\n`);

  router.ws.close();
  chat.ws.close();
  mobile.ws.close();
  setTimeout(() => process.exit(0), 500);
}

main().catch(err => { console.error(err); process.exit(1); });
