// Тест: полный путь Чат → Роутер → centrifugo_stdio → Claude
//
// 1. Подключаемся к lobby как Чат (общий JWT)
// 2. Отправляем hello → Роутер создаёт сессию + запускает centrifugo_stdio
// 3. Получаем hello_ack (session_id, chat_jwt)
// 4. Переподключаемся с chat_jwt (авто-подписка на канал сессии)
// 5. Отправляем {type: "chat", text: "вопрос"}
// 6. centrifugo_stdio получает → Claude → ответ в канал → мы получаем
//
// Запуск: node test-chat-via-router.mjs

import { createHmac } from 'node:crypto';

const HMAC_SECRET = 'wtFBIxmI__UGR23PSDUPgjj5MlkCtgAT1-WHkZmMGOX5MKge30CmyeOL3Ai2U-F_qCOPyAIjbkbAkP5W_RP7Yw';
const WS_URL = 'ws://localhost:11000/connection/websocket';

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
      ws.send(JSON.stringify({ id: cmdId++, connect: { token, name } }));
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

    ws.addEventListener('error', () => reject(new Error(`[${name}] WS error`)));
    setTimeout(() => reject(new Error(`[${name}] Connect timeout`)), 10000);
  });
}

function waitFor(client, predicate, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.handlers.splice(client.handlers.indexOf(handler), 1);
      reject(new Error(`[${client.name}] Timeout (${timeoutMs}ms)`));
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

// --- Main ---

async function main() {
  console.log('=== Тест: Чат → Роутер → Claude (полный флоу) ===\n');

  // 1. Общий JWT для lobby (как зашит в EPF Чата)
  const now = Math.floor(Date.now() / 1000);
  const lobbyJWT = generateJWT({
    sub: 'lobby-user',
    exp: now + 300,
  });

  // 2. Подключаемся к Centrifugo
  const chat = await connectClient('CHAT-lobby', lobbyJWT);
  console.log(`[1] Подключились к Centrifugo (client=${chat.clientId})`);

  // 3. Ждём hello_ack
  const helloAckPromise = waitFor(chat, msg => {
    const data = msg.push?.pub?.data;
    if (data && data.type === 'hello_ack') return data;
  }, 15000);

  // 4. Публикуем hello в session:lobby
  const formId = crypto.randomUUID();
  chat.ws.send(JSON.stringify({
    id: chat.cmdId(),
    publish: {
      channel: 'session:lobby',
      data: {
        type: 'hello',
        form_id: formId,
        config_name: 'ТестоваяКонфигурация',
        config_version: '1.0',
        config_id: 'test-config-id',
        computer: 'TEST-PC',
        connection_string: 'File="C:\\test"',
      },
    },
  }));
  console.log('[2] Отправлен hello в session:lobby');

  // 5. Получаем hello_ack
  let helloAck;
  try {
    helloAck = await helloAckPromise;
    console.log(`[3] Получен hello_ack:`);
    console.log(`    session_id: ${helloAck.session_id}`);
    console.log(`    status: ${helloAck.status}`);
    console.log(`    chat_jwt: ${helloAck.chat_jwt ? '✓' : '✗'}`);
    console.log(`    mobile_jwt: ${helloAck.mobile_jwt ? '✓' : '✗'}`);
  } catch (e) {
    console.error(`[FAIL] ${e.message}`);
    console.error('    Роутер не ответил на hello. Проверьте:');
    console.error('    1. Серверная база 1С запущена');
    console.error('    2. Расширение ЕХТ_Лира_Роутер загружено');
    console.error('    3. WebSocket-клиент подключён (Управление WebSocket-клиентами)');
    chat.ws.close();
    process.exit(1);
  }

  // 6. Переподключаемся с chat_jwt
  chat.ws.close();
  console.log('[4] Отключились от lobby');

  // Ждём пока centrifugo_stdio запустится
  console.log('    Ждём запуск centrifugo_stdio (5 сек)...');
  await new Promise(r => setTimeout(r, 5000));

  const chatSession = await connectClient('CHAT-session', helloAck.chat_jwt);
  const sessionChannel = `session:${helloAck.session_id}`;

  if (chatSession.autoSubs.includes(sessionChannel)) {
    console.log(`[5] Переподключились, авто-подписка на ${sessionChannel}`);
  } else {
    console.error(`[FAIL] Нет авто-подписки на ${sessionChannel}`);
    chatSession.ws.close();
    process.exit(1);
  }

  // 7. Слушаем ответ от Claude (универсальный протокол)
  let fullText = '';
  const responsePromise = waitFor(chatSession, msg => {
    const data = msg.push?.pub?.data;
    if (!data) return false;
    if (data.type === 'chat') return false; // наше сообщение

    if (data.type === 'text_delta' && data.text) {
      fullText += data.text;
      process.stdout.write(`    [text_delta] ${data.text.slice(0, 100)}\n`);
      return false; // ждём assistant_end
    }
    if (data.type === 'thinking_start') {
      console.log(`    [thinking_start]`);
      return false;
    }
    if (data.type === 'thinking_delta' && data.text) {
      process.stdout.write(`    [thinking_delta] ${data.text.slice(0, 80)}...\n`);
      return false;
    }
    if (data.type === 'thinking_end') {
      console.log(`    [thinking_end]`);
      return false;
    }
    if (data.type === 'assistant_end') {
      if (data.text && !fullText) fullText = data.text;
      return { type: 'assistant_end', text: fullText };
    }
    if (data.type === 'error') {
      console.log(`    [error] ${data.message}`);
      return data;
    }
    // Логируем другие типы
    if (data.type) {
      console.log(`    [${data.type}] ${JSON.stringify(data).slice(0, 150)}`);
    }
    return false;
  }, 120000);

  // 8. Отправляем вопрос
  const question = 'Сколько будет 7*8? Ответь одним числом.';
  chatSession.ws.send(JSON.stringify({
    id: chatSession.cmdId(),
    publish: {
      channel: sessionChannel,
      data: {
        type: 'chat',
        form_id: formId,
        session_id: helloAck.session_id,
        text: question,
      },
    },
  }));
  console.log(`[6] Отправлен вопрос: "${question}"`);

  // 9. Ждём ответ
  try {
    const response = await responsePromise;
    console.log(`\n[7] Ответ от Claude: "${fullText}"`);
    console.log('\n========================================');
    console.log('[OK] Полный флоу работает!');
    console.log('  1. Чат → hello (lobby) → Роутер');
    console.log('  2. Роутер создал сессию + запустил centrifugo_stdio');
    console.log('  3. hello_ack → Чат переподключился с JWT');
    console.log('  4. Чат → chat → centrifugo_stdio → Claude');
    console.log('  5. Claude → ответ → centrifugo_stdio → канал → Чат');
    console.log('========================================\n');
  } catch (e) {
    console.error(`\n[TIMEOUT] ${e.message}`);
    console.error('    centrifugo_stdio возможно не запустился.');
    console.error('    Проверьте журнал регистрации 1С (ЕХТ_Лира_Роутер.Модель)');
  }

  chatSession.ws.close();
  setTimeout(() => process.exit(0), 1000);
}

main().catch(err => { console.error(err); process.exit(1); });
