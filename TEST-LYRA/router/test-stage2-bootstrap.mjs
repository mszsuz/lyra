#!/usr/bin/env node
// Тест Этапа 2: Bootstrap через персональные каналы
// 1. Mobile подключается к mobile:lobby → получает push.subscribe на mobile:<clientUUID>
// 2. Публикует register в bootstrap-канал → получает register_ack с user_jwt
// 3. Lobby не видит никаких бизнес-данных
// 4. Повторная регистрация → тот же user_id

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync('./centrifugo/config.json', 'utf-8'));
const SECRET = config.client.token.hmac_secret_key;
const PORT = config.http_server.port;
const WS_URL = `ws://localhost:${PORT}/connection/websocket`;

function generateJWT(payload) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${h}.${b}.${createHmac('sha256', SECRET).update(`${h}.${b}`).digest('base64url')}`;
}

function parseMessages(data) {
  const text = typeof data === 'string' ? data : data.toString();
  return text.split('\n').filter(l => l.trim() && l.trim() !== '{}').map(l => JSON.parse(l));
}

let passed = 0, failed = 0;
function check(name, condition) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  const testDeviceId = `test-bootstrap-${Date.now()}`;
  const mobileLobbyJwt = generateJWT({ sub: 'lobby-mobile', channels: ['mobile:lobby'], exp: now + 3600 });

  console.log('=== Тест Этапа 2: Bootstrap через персональные каналы ===\n');

  // --- Spy: подключаемся к lobby и слушаем бизнес-сообщения ---
  const spyJwt = generateJWT({ sub: 'spy', channels: ['mobile:lobby'], exp: now + 3600 });
  const spy = new WebSocket(WS_URL);
  const lobbyMessages = [];

  await new Promise((resolve, reject) => {
    spy.addEventListener('open', () => {
      spy.send(JSON.stringify({ id: 1, connect: { token: spyJwt } }));
    });
    spy.addEventListener('message', (e) => {
      for (const msg of parseMessages(e.data)) {
        if (msg.connect) resolve();
        // Собираем ВСЕ pub в lobby
        if (msg.push?.channel === 'mobile:lobby' && msg.push?.pub?.data) {
          lobbyMessages.push(msg.push.pub.data);
        }
      }
    });
    setTimeout(() => reject(new Error('spy timeout')), 5000);
  });
  console.log('[Spy] Подключён к mobile:lobby\n');

  // --- 1. Mobile подключается к lobby ---
  console.log('1. Mobile подключается к mobile:lobby');
  const mobile = new WebSocket(WS_URL);
  let mobileClientId;
  let bootstrapChannel = null;
  const bootstrapMessages = [];

  await new Promise((resolve, reject) => {
    mobile.addEventListener('open', () => {
      mobile.send(JSON.stringify({ id: 1, connect: { token: mobileLobbyJwt } }));
    });
    mobile.addEventListener('message', (e) => {
      for (const msg of parseMessages(e.data)) {
        if (msg.connect) {
          mobileClientId = msg.connect.client;
          console.log(`  [Mobile] client=${mobileClientId}`);
          resolve();
        }
      }
    });
    setTimeout(() => reject(new Error('mobile timeout')), 5000);
  });

  // Слушаем push.subscribe и все сообщения
  mobile.addEventListener('message', (e) => {
    for (const msg of parseMessages(e.data)) {
      // push.subscribe = роутер подписал нас на bootstrap-канал
      if (msg.push?.subscribe !== undefined && msg.push?.channel) {
        if (msg.push.channel.startsWith('mobile:') && msg.push.channel !== 'mobile:lobby') {
          bootstrapChannel = msg.push.channel;
          console.log(`  [Mobile] push.subscribe: ${bootstrapChannel}`);
        }
      }
      // pub в bootstrap-канал
      if (msg.push?.pub?.data && msg.push?.channel === bootstrapChannel) {
        bootstrapMessages.push(msg.push.pub.data);
      }
    }
  });

  // Ждём push.subscribe на bootstrap-канал
  console.log('\n2. Ожидание push.subscribe на bootstrap-канал...');
  const deadline = Date.now() + 10000;
  while (!bootstrapChannel && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
  }

  check('push.subscribe получен', !!bootstrapChannel);
  check('канал = mobile:<clientUUID>', bootstrapChannel === `mobile:${mobileClientId}`);

  if (!bootstrapChannel) {
    console.log('\n=== ТЕСТ ПРЕРВАН: bootstrap-канал не получен ===');
    spy.close(); mobile.close();
    setTimeout(() => process.exit(1), 500);
    return;
  }

  // --- 3. Publish register в bootstrap-канал ---
  console.log('\n3. Publish register в bootstrap-канал');
  mobile.send(JSON.stringify({
    id: 10,
    publish: {
      channel: bootstrapChannel,
      data: { type: 'register', device_id: testDeviceId },
    },
  }));

  // Ждём register_ack
  const ackDeadline = Date.now() + 15000;
  while (bootstrapMessages.length === 0 && Date.now() < ackDeadline) {
    await new Promise(r => setTimeout(r, 100));
  }

  const ack = bootstrapMessages.find(m => m.type === 'register_ack');
  const err = bootstrapMessages.find(m => m.type === 'register_error');

  if (ack) {
    console.log(`  register_ack: ${JSON.stringify(ack)}`);
    check('status == ok', ack.status === 'ok');
    check('user_id присутствует', !!ack.user_id);
    check('user_jwt присутствует', !!ack.user_jwt);
    check('balance >= 0', ack.balance >= 0);
  } else if (err) {
    console.log(`  register_error: ${JSON.stringify(err)}`);
    check('register_ack получен', false);
  } else {
    console.log('  Нет ответа в bootstrap-канале');
    check('register_ack получен', false);
  }

  // --- 4. Проверяем что lobby пуст ---
  console.log('\n4. Lobby traffic check');
  await new Promise(r => setTimeout(r, 1000)); // подождать чтобы spy собрал сообщения
  const businessMsgs = lobbyMessages.filter(m => m.type !== undefined);
  check('lobby пуст (0 бизнес-сообщений)', businessMsgs.length === 0);
  if (businessMsgs.length > 0) {
    console.log(`  Найдены сообщения в lobby: ${JSON.stringify(businessMsgs)}`);
  }

  // --- 5. Подключение к user-каналу ---
  if (ack?.user_jwt) {
    console.log('\n5. Подключение к user-каналу с user_jwt');
    const userWs = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
      userWs.addEventListener('open', () => {
        userWs.send(JSON.stringify({ id: 1, connect: { token: ack.user_jwt } }));
      });
      userWs.addEventListener('message', (e) => {
        for (const msg of parseMessages(e.data)) {
          if (msg.connect) {
            check('авто-подписка на user-канал', !!msg.connect.subs?.[`user:${ack.user_id}`]);
            resolve();
          }
        }
      });
      setTimeout(() => reject(new Error('user connect timeout')), 5000);
    });
    userWs.close();
  }

  // --- 6. Повторная регистрация (новое соединение) ---
  console.log('\n6. Повторная регистрация (тот же device_id, новое соединение)');
  const mobile2 = new WebSocket(WS_URL);
  let bootstrap2 = null;
  const bootstrap2Messages = [];

  await new Promise((resolve, reject) => {
    mobile2.addEventListener('open', () => {
      mobile2.send(JSON.stringify({ id: 1, connect: { token: mobileLobbyJwt } }));
    });
    mobile2.addEventListener('message', (e) => {
      for (const msg of parseMessages(e.data)) {
        if (msg.connect) resolve();
        if (msg.push?.subscribe !== undefined && msg.push?.channel?.startsWith('mobile:') && msg.push.channel !== 'mobile:lobby') {
          bootstrap2 = msg.push.channel;
        }
        if (bootstrap2 && msg.push?.pub?.data && msg.push.channel === bootstrap2) {
          bootstrap2Messages.push(msg.push.pub.data);
        }
      }
    });
    setTimeout(() => reject(new Error('timeout')), 5000);
  });

  // Ждём bootstrap2
  const dl2 = Date.now() + 10000;
  while (!bootstrap2 && Date.now() < dl2) await new Promise(r => setTimeout(r, 100));

  if (bootstrap2) {
    mobile2.send(JSON.stringify({
      id: 10,
      publish: { channel: bootstrap2, data: { type: 'register', device_id: testDeviceId } },
    }));

    const dl3 = Date.now() + 10000;
    while (bootstrap2Messages.length === 0 && Date.now() < dl3) await new Promise(r => setTimeout(r, 100));

    const ack2 = bootstrap2Messages.find(m => m.type === 'register_ack');
    check('повторный register_ack', !!ack2);
    check('тот же user_id', ack2?.user_id === ack?.user_id);
  } else {
    check('bootstrap2 получен', false);
  }

  mobile2.close();
  mobile.close();
  spy.close();

  console.log(`\n=== Результат: ${passed} passed, ${failed} failed ===`);
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
}

main().catch(e => { console.error(e); process.exit(1); });
