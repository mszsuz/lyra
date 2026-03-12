// Тест: проверка интеграции Vega MCP через Роутер
//
// Отправляем hello с config_name = 'EXT_ServicesDB' (маппится на Vega Demo:60020)
// Задаём вопрос, требующий инструменты Vega (search_metadata)
// Ожидаем что Claude вызовет tool_call с vega-инструментом
//
// Запуск: node test-vega-mcp.mjs

import { createHmac } from 'node:crypto';

const HMAC_SECRET = 'wtFBIxmI__UGR23PSDUPgjj5MlkCtgAT1-WHkZmMGOX5MKge30CmyeOL3Ai2U-F_qCOPyAIjbkbAkP5W_RP7Yw';
const WS_URL = 'ws://localhost:11000/connection/websocket';

function generateJWT(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', HMAC_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

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

async function main() {
  console.log('=== Тест: Vega MCP через Роутер ===\n');

  const now = Math.floor(Date.now() / 1000);
  const lobbyJWT = generateJWT({ sub: 'lobby-user', exp: now + 300 });

  // 1. Подключаемся к lobby
  const chat = await connectClient('CHAT-lobby', lobbyJWT);
  console.log(`[1] Подключились к Centrifugo (client=${chat.clientId})`);

  // 2. Ждём hello_ack
  const helloAckPromise = waitFor(chat, msg => {
    const data = msg.push?.pub?.data;
    if (data && data.type === 'hello_ack') return data;
  }, 15000);

  // 3. Отправляем hello с config_name = EXT_ServicesDB → Vega Demo:60020
  const formId = crypto.randomUUID();
  chat.ws.send(JSON.stringify({
    id: chat.cmdId(),
    publish: {
      channel: 'session:lobby',
      data: {
        type: 'hello',
        form_id: formId,
        config_name: 'EXT_ServicesDB',
        config_version: '1.0',
        config_id: 'test-vega',
        computer: 'TEST-PC',
        connection_string: 'File="C:\\test"',
      },
    },
  }));
  console.log('[2] Отправлен hello (config_name=EXT_ServicesDB → Vega Demo)');

  // 4. Получаем hello_ack
  let helloAck;
  try {
    helloAck = await helloAckPromise;
    console.log(`[3] hello_ack: session_id=${helloAck.session_id}, status=${helloAck.status}`);
  } catch (e) {
    console.error(`[FAIL] ${e.message}`);
    chat.ws.close();
    process.exit(1);
  }

  // 5. Переподключаемся с chat_jwt
  chat.ws.close();
  console.log('[4] Ждём запуск centrifugo_stdio (5 сек)...');
  await new Promise(r => setTimeout(r, 5000));

  const chatSession = await connectClient('CHAT-session', helloAck.chat_jwt);
  const sessionChannel = `session:${helloAck.session_id}`;

  if (!chatSession.autoSubs.includes(sessionChannel)) {
    console.error(`[FAIL] Нет авто-подписки на ${sessionChannel}`);
    chatSession.ws.close();
    process.exit(1);
  }
  console.log(`[5] Переподключились на ${sessionChannel}`);

  // 6. Слушаем ответ — ищем tool_call с vega
  let foundVegaTool = false;
  let fullText = '';
  const responsePromise = waitFor(chatSession, msg => {
    const data = msg.push?.pub?.data;
    if (!data) return false;
    if (data.type === 'chat') return false;

    if (data.type === 'tool_call') {
      console.log(`    [tool_call] ${JSON.stringify(data).slice(0, 200)}`);
      if (JSON.stringify(data).includes('vega')) {
        foundVegaTool = true;
        console.log('    ✓ VEGA TOOL DETECTED!');
      }
      return false;
    }
    if (data.type === 'tool_result') {
      console.log(`    [tool_result] ${JSON.stringify(data).slice(0, 200)}`);
      return false;
    }
    if (data.type === 'text_delta' && data.text) {
      fullText += data.text;
      return false;
    }
    if (data.type === 'thinking_start' || data.type === 'thinking_end') return false;
    if (data.type === 'thinking_delta') return false;
    if (data.type === 'assistant_end') {
      if (data.text && !fullText) fullText = data.text;
      return { done: true };
    }
    if (data.type === 'error') {
      console.log(`    [error] ${data.message || JSON.stringify(data)}`);
      return { done: true, error: true };
    }
    if (data.type) {
      console.log(`    [${data.type}] ${JSON.stringify(data).slice(0, 150)}`);
    }
    return false;
  }, 120000);

  // 7. Задаём вопрос, требующий Vega
  const question = 'Найди в метаданных конфигурации справочник Номенклатура, используй инструмент search_metadata';
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
  console.log(`[6] Вопрос: "${question}"`);

  // 8. Ждём ответ
  try {
    await responsePromise;
    console.log(`\n[7] Ответ: "${fullText.slice(0, 200)}..."`);
    console.log(`\n========================================`);
    if (foundVegaTool) {
      console.log('[OK] Vega MCP работает! Claude использовал vega-инструмент.');
    } else {
      console.log('[WARN] Ответ получен, но vega tool_call не обнаружен.');
      console.log('       Возможно Claude ответил без инструментов.');
    }
    console.log('========================================\n');
  } catch (e) {
    console.error(`\n[TIMEOUT] ${e.message}`);
  }

  chatSession.ws.close();
  setTimeout(() => process.exit(0), 1000);
}

main().catch(err => { console.error(err); process.exit(1); });
