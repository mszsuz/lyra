// Тест: Чат НЕ подписывается на lobby — только connect + publish hello
// Проверяем:
//   1. publish без subscribe работает (allow_publish_for_client: true)
//   2. Роутер получает hello с pub.info.client (UUID соединения Чата)
//   3. Server API subscribe по client UUID + publish hello_ack — Чат получает
// Запуск: node test-no-subscribe-lobby.mjs

const API_KEY = 'tDpoTDd7P36lD-jf9jWRf4IBmeuK6QwZOfzoBhpq5fr4qMvzDscDy9xZmnjNY1czwxXneXaPETB4q2AC0H5z6g';
const ROUTER_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyb3V0ZXItMSIsImV4cCI6MTc3MzQ3OTA5MiwiaWF0IjoxNzcyODc0MjkyfQ.PxtQmLONTsl-dhwB8cU7gcQykS794OV8A3uhv1Mb5ac';
const CHAT_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjaGF0LWNsaWVudC0xIiwiZXhwIjoxNzczNDc5MTA0LCJpYXQiOjE3NzI4NzQzMDR9.QJnTw5lZgcF1FqqdN9dLD4l5p5_TknWfFeOk3VvkVaw';

async function apiCall(method, params) {
  const res = await fetch(`http://localhost:11000/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(params),
  });
  return res.json();
}

function parseMessages(data) {
  return data.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function connectClient(name, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost:11000/connection/websocket');
    let cmdId = 1;
    const handlers = [];

    ws.addEventListener('message', event => {
      for (const msg of parseMessages(event.data)) {
        for (const h of handlers) h(msg);
      }
    });

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: cmdId++, connect: { token } }));
    });

    const connectHandler = msg => {
      if (msg.id === 1 && msg.connect) {
        console.log(`[${name}] Connected, client=${msg.connect.client}`);
        handlers.splice(handlers.indexOf(connectHandler), 1);
        resolve({ ws, cmdId: () => cmdId++, name, handlers, clientId: msg.connect.client });
      }
    };
    handlers.push(connectHandler);

    ws.addEventListener('error', e => { console.error(`[${name}] Error:`, e.message); reject(e); });
  });
}

function waitFor(client, predicate, timeoutMs = 5000) {
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
    client.handlers.push(handler);
  });
}

async function main() {
  console.log('=== Тест: Чат без subscribe на lobby ===\n');

  // 1. Роутер: connect + subscribe на lobby
  const router = await connectClient('ROUTER', ROUTER_TOKEN);
  router.ws.send(JSON.stringify({ id: router.cmdId(), subscribe: { channel: 'session:lobby' } }));
  await waitFor(router, msg => msg.subscribe ? true : false);
  console.log('[ROUTER] Subscribed to session:lobby\n');

  // 2. Чат: ТОЛЬКО connect, БЕЗ subscribe на lobby
  const chat = await connectClient('CHAT', CHAT_TOKEN);
  console.log('[CHAT] Connected, NOT subscribing to lobby\n');

  // 3. Роутер ждёт hello — проверяем pub.info.client
  const helloPromise = waitFor(router, async msg => {
    if (msg.push?.channel === 'session:lobby' && msg.push?.pub?.data?.type === 'hello') {
      const clientUUID = msg.push.pub.info?.client;
      console.log('[ROUTER] Got hello!');
      console.log(`  pub.info.client = ${clientUUID}`);
      console.log(`  data = ${JSON.stringify(msg.push.pub.data)}`);

      if (!clientUUID) {
        console.error('[FAIL] pub.info.client is missing!');
        process.exit(1);
      }

      // 4. Server API subscribe — подписать конкретное соединение Чата на канал сессии
      const sessionChannel = `session:test-${Date.now()}`;
      console.log(`\n[ROUTER] Server API subscribe: client=${clientUUID} -> ${sessionChannel}`);
      const subRes = await apiCall('subscribe', {
        user: 'chat-client-1',  // sub из JWT Чата
        client: clientUUID,
        channel: sessionChannel,
      });
      console.log('[ROUTER] subscribe result:', JSON.stringify(subRes));

      // 5. Server API publish — hello_ack в канал сессии
      console.log(`[ROUTER] Server API publish: hello_ack -> ${sessionChannel}`);
      const pubRes = await apiCall('publish', {
        channel: sessionChannel,
        data: {
          type: 'hello_ack',
          session_id: sessionChannel,
          status: 'awaiting_auth',
          chat_jwt: 'eyJ-fake-chat-jwt',
          mobile_jwt: 'eyJ-fake-mobile-jwt',
        },
      });
      console.log('[ROUTER] publish result:', JSON.stringify(pubRes));

      return true;
    }
  });

  // 6. Чат ждёт hello_ack на канале сессии (НЕ на lobby)
  const ackPromise = waitFor(chat, msg => {
    if (msg.push && msg.push.channel !== 'session:lobby' && msg.push.pub?.data?.type === 'hello_ack') {
      return msg.push.pub.data;
    }
  });

  // 7. Чат публикует hello в lobby БЕЗ subscribe
  console.log('[CHAT] Publishing hello to session:lobby (without subscribe)...');
  chat.ws.send(JSON.stringify({
    id: chat.cmdId(),
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

  // Проверяем что publish прошёл (нет ошибки)
  const publishResponse = await waitFor(chat, msg => {
    if (msg.id && (msg.publish !== undefined || msg.error)) return msg;
  });

  if (publishResponse.error) {
    console.error(`\n[FAIL] Publish rejected: ${JSON.stringify(publishResponse.error)}`);
    process.exit(1);
  }
  console.log('[CHAT] Publish accepted (no error)\n');

  // 8. Ждём результаты
  await helloPromise;
  const ack = await ackPromise;

  console.log(`\n========================================`);
  console.log(`[OK] Все проверки пройдены:`);
  console.log(`  1. Publish без subscribe на lobby — работает`);
  console.log(`  2. pub.info.client — присутствует`);
  console.log(`  3. Server API subscribe + publish — Чат получил hello_ack`);
  console.log(`  hello_ack: ${JSON.stringify(ack)}`);
  console.log(`========================================\n`);

  router.ws.close();
  chat.ws.close();
  setTimeout(() => process.exit(0), 500);
}

main().catch(err => { console.error(err); process.exit(1); });
