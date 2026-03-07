// Тест: виден ли client ID отправителя в push-сообщении?
// Два клиента с одинаковым JWT (sub), один публикует — смотрим что приходит второму.

const SHARED_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzaGFyZWQtdXNlciIsImV4cCI6MTg3Mjg3NDAwMCwiaWF0IjoxNzcyODc0MDAwfQ';
// Нужен валидный токен — сгенерим через centrifugo

const API_KEY = 'tDpoTDd7P36lD-jf9jWRf4IBmeuK6QwZOfzoBhpq5fr4qMvzDscDy9xZmnjNY1czwxXneXaPETB4q2AC0H5z6g';

function parseMessages(data) {
  return data.split('\n').filter(Boolean).map(l => JSON.parse(l));
}

async function main() {
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzaGFyZWQtbG9iYnktdXNlciIsImV4cCI6MTc3MzQ4MDczNywiaWF0IjoxNzcyODc1OTM3fQ.EEnfPBkp5dYrt3H0N0O0Wqy5BNm2ypeOPzeBw4D-Z20';
  console.log('Using shared token (sub=shared-lobby-user)');

  // Клиент 1 (Роутер) — подписан на lobby, слушает
  const ws1 = new WebSocket('ws://localhost:11000/connection/websocket');
  let ws1Client = null;

  await new Promise(resolve => {
    ws1.addEventListener('open', () => {
      ws1.send(JSON.stringify({ id: 1, connect: { token } }));
    });
    ws1.addEventListener('message', (e) => {
      for (const msg of parseMessages(e.data)) {
        if (msg.connect) {
          ws1Client = msg.connect.client;
          console.log(`[WS1/Router] client=${ws1Client}`);
          ws1.send(JSON.stringify({ id: 2, subscribe: { channel: 'session:lobby' } }));
        }
        if (msg.id === 2 && msg.subscribe !== undefined) resolve();
      }
    });
  });
  console.log('[WS1/Router] Subscribed to lobby');

  // Клиент 2 (Чат) — тот же JWT, подписан на lobby, публикует hello
  const ws2 = new WebSocket('ws://localhost:11000/connection/websocket');
  let ws2Client = null;

  await new Promise(resolve => {
    ws2.addEventListener('open', () => {
      ws2.send(JSON.stringify({ id: 1, connect: { token } }));
    });
    ws2.addEventListener('message', (e) => {
      for (const msg of parseMessages(e.data)) {
        if (msg.connect) {
          ws2Client = msg.connect.client;
          console.log(`[WS2/Chat] client=${ws2Client}`);
          ws2.send(JSON.stringify({ id: 2, subscribe: { channel: 'session:lobby' } }));
        }
        if (msg.id === 2 && msg.subscribe !== undefined) resolve();
      }
    });
  });
  console.log('[WS2/Chat] Subscribed to lobby');

  // WS1 слушает — что придёт в push от WS2?
  const pushReceived = new Promise(resolve => {
    ws1.addEventListener('message', (e) => {
      for (const msg of parseMessages(e.data)) {
        if (msg.push?.channel === 'session:lobby' && msg.push?.pub) {
          console.log('\n[WS1/Router] RAW PUSH:');
          console.log(JSON.stringify(msg, null, 2));
          resolve(msg);
        }
      }
    });
  });

  // WS2 публикует hello
  console.log('\n[WS2/Chat] Publishing hello...');
  ws2.send(JSON.stringify({
    id: 3,
    publish: {
      channel: 'session:lobby',
      data: { type: 'hello', configuration: 'БухгалтерияПредприятия' }
    }
  }));

  const push = await pushReceived;

  console.log('\n--- РЕЗУЛЬТАТ ---');
  console.log('pub.info:', JSON.stringify(push.push?.pub?.info));
  console.log('Есть ли client в push:', push.push?.pub?.info?.client ? 'ДА' : 'НЕТ');

  // Теперь тест: subscribe с client ID
  console.log(`\n[API] Subscribe user="shared-lobby-user" client="${ws2Client}" to session:test-personal...`);
  const res = await fetch('http://localhost:11000/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ user: 'shared-lobby-user', client: ws2Client, channel: 'session:test-personal' }),
  });
  console.log('[API] Result:', await res.json());

  // Проверяем: WS2 получил подписку? WS1 — нет?
  const ws2Got = new Promise(resolve => {
    const h = (e) => {
      for (const msg of parseMessages(e.data)) {
        if (msg.push?.channel === 'session:test-personal') {
          console.log('[WS2/Chat] Got subscription push:', JSON.stringify(msg.push));
          ws2.removeEventListener('message', h);
          resolve(true);
        }
      }
    };
    ws2.addEventListener('message', h);
  });

  let ws1Got = false;
  const h1 = (e) => {
    for (const msg of parseMessages(e.data)) {
      if (msg.push?.channel === 'session:test-personal') {
        ws1Got = true;
        console.log('[WS1/Router] ALSO got subscription (WRONG!):', JSON.stringify(msg.push));
      }
    }
  };
  ws1.addEventListener('message', h1);

  await ws2Got;
  await new Promise(r => setTimeout(r, 1000));

  console.log(`\n--- ИТОГ ---`);
  console.log(`WS1 (Router) got personal channel: ${ws1Got ? 'ДА (плохо!)' : 'НЕТ (правильно!)'}`);
  console.log(`WS2 (Chat) got personal channel: ДА (правильно!)`);

  ws1.close();
  ws2.close();
  setTimeout(() => process.exit(0), 500);
}

main().catch(e => { console.error(e); process.exit(1); });
