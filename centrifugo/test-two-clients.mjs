// Тест: Роутер (WS-клиент) подписан на lobby, Чат публикует hello в lobby
// Роутер получает hello, создаёт персональный канал, подписывает Чат, шлёт hello_ack
// Запуск: node test-two-clients.mjs

const API_KEY = 'tDpoTDd7P36lD-jf9jWRf4IBmeuK6QwZOfzoBhpq5fr4qMvzDscDy9xZmnjNY1czwxXneXaPETB4q2AC0H5z6g';
const ROUTER_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyb3V0ZXItMSIsImV4cCI6MTc3MzQ3OTA5MiwiaWF0IjoxNzcyODc0MjkyfQ.PxtQmLONTsl-dhwB8cU7gcQykS794OV8A3uhv1Mb5ac';
const CHAT_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjaGF0LWNsaWVudC0xIiwiZXhwIjoxNzczNDc5MTA0LCJpYXQiOjE3NzI4NzQzMDR9.QJnTw5lZgcF1FqqdN9dLD4l5p5_TknWfFeOk3VvkVaw';
const BASE = 'http://localhost:11000';

async function apiCall(method, params) {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify(params),
  });
  return res.json();
}

// Centrifugo может слать несколько JSON в одном фрейме, разделённых \n
function parseMessages(data) {
  return data.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function onMessages(ws, callback) {
  ws.addEventListener('message', (event) => {
    for (const msg of parseMessages(event.data)) {
      callback(msg);
    }
  });
}

function connectClient(name, token) {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost:11000/connection/websocket');
    let cmdId = 1;
    const handlers = [];

    onMessages(ws, (msg) => {
      for (const h of handlers) h(msg);
    });

    ws.addEventListener('open', () => {
      console.log(`[${name}] Connected, authenticating...`);
      ws.send(JSON.stringify({ id: cmdId++, connect: { token } }));
    });

    // Ждём connect response
    const connectHandler = (msg) => {
      if (msg.id === 1 && msg.connect) {
        console.log(`[${name}] Authenticated, client=${msg.connect.client}`);
        const idx = handlers.indexOf(connectHandler);
        if (idx >= 0) handlers.splice(idx, 1);
        resolve({ ws, cmdId: () => cmdId++, name, handlers });
      }
    };
    handlers.push(connectHandler);

    ws.addEventListener('error', (e) => console.error(`[${name}] Error:`, e.message));
  });
}

function waitFor(client, predicate) {
  return new Promise((resolve) => {
    const handler = (msg) => {
      const result = predicate(msg);
      if (result !== undefined && result !== false) {
        const idx = client.handlers.indexOf(handler);
        if (idx >= 0) client.handlers.splice(idx, 1);
        resolve(result);
      }
    };
    client.handlers.push(handler);
  });
}

async function main() {
  // 1. Подключаем Роутер
  const router = await connectClient('ROUTER', ROUTER_TOKEN);

  // 2. Роутер подписывается на lobby
  console.log('\n[ROUTER] Subscribing to session:lobby...');
  router.ws.send(JSON.stringify({ id: router.cmdId(), subscribe: { channel: 'session:lobby' } }));
  await waitFor(router, (msg) => msg.subscribe ? true : false);
  console.log('[ROUTER] Subscribed to session:lobby');

  // 3. Подключаем Чат
  const chat = await connectClient('CHAT', CHAT_TOKEN);

  // 4. Чат подписывается на lobby
  console.log('\n[CHAT] Subscribing to session:lobby...');
  chat.ws.send(JSON.stringify({ id: chat.cmdId(), subscribe: { channel: 'session:lobby' } }));
  await waitFor(chat, (msg) => msg.subscribe ? true : false);
  console.log('[CHAT] Subscribed to session:lobby');

  // 5. Роутер слушает lobby — когда придёт hello, создаст персональный канал
  const helloReceived = waitFor(router, async (msg) => {
    if (msg.push?.channel === 'session:lobby' && msg.push?.pub?.data?.type === 'hello') {
      const hello = msg.push.pub.data;
      console.log(`\n[ROUTER] >>> Received hello from lobby:`, JSON.stringify(hello));

      const sessionChannel = `session:sess-${Date.now()}`;
      const chatUser = hello.user;

      console.log(`[ROUTER] Creating personal channel "${sessionChannel}" for user "${chatUser}"`);
      const subRes = await apiCall('subscribe', { user: chatUser, channel: sessionChannel });
      console.log('[ROUTER] Server API subscribe:', JSON.stringify(subRes));

      console.log(`[ROUTER] Publishing hello_ack to "${sessionChannel}"`);
      const pubRes = await apiCall('publish', {
        channel: sessionChannel,
        data: { type: 'hello_ack', session_id: sessionChannel, qr: 'SCAN-THIS-QR' },
      });
      console.log('[ROUTER] Server API publish:', JSON.stringify(pubRes));

      return true;
    }
  });

  // 6. Чат слушает — должен получить hello_ack на персональном канале
  const chatGotAck = waitFor(chat, (msg) => {
    if (msg.push && msg.push.channel !== 'session:lobby') {
      console.log(`[CHAT] >>> Received on ${msg.push.channel}:`, JSON.stringify(msg.push, null, 2));
      if (msg.push.pub?.data?.type === 'hello_ack') {
        return msg.push.pub.data;
      }
    }
  });

  // 7. Чат отправляет hello в lobby
  console.log('\n[CHAT] Publishing hello to session:lobby...');
  chat.ws.send(JSON.stringify({
    id: chat.cmdId(),
    publish: {
      channel: 'session:lobby',
      data: {
        type: 'hello',
        user: 'chat-client-1',
        configuration: 'БухгалтерияПредприятия',
        version: '3.0.191.41',
        computer: 'BUHPC-01',
        connection_string: 'Srvr="srv1c";Ref="buh_prod";',
      },
    },
  }));

  // 8. Ждём результат
  await helloReceived;
  const ack = await chatGotAck;
  console.log(`\n========================================`);
  console.log(`[SUCCESS] Chat received hello_ack!`);
  console.log(`  session_id: ${ack.session_id}`);
  console.log(`  qr: ${ack.qr}`);
  console.log(`========================================\n`);

  router.ws.close();
  chat.ws.close();
  setTimeout(() => process.exit(0), 500);
}

main().catch((err) => { console.error(err); process.exit(1); });
