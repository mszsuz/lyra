// Test: tool_call/tool_result flow
// Simulates Chat EPF: listens on session channel, responds to tool_call with tool_result
import { createHmac } from 'node:crypto';

const HMAC = 'wtFBIxmI__UGR23PSDUPgjj5MlkCtgAT1-WHkZmMGOX5MKge30CmyeOL3Ai2U-F_qCOPyAIjbkbAkP5W_RP7Yw';
const WS_URL = 'ws://localhost:11000/connection/websocket';

function jwt(p) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(p)).toString('base64url');
  const s = createHmac('sha256', HMAC).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${s}`;
}

function parseMessages(data) {
  return data.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function connectWS(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let cmdId = 1;
    const handlers = [];

    ws.addEventListener('message', (event) => {
      for (const msg of parseMessages(event.data)) {
        if (msg.id === 1 && msg.connect) {
          resolve({ ws, cmdId: () => cmdId++, handlers, autoSubs: msg.connect.subs ? Object.keys(msg.connect.subs) : [] });
        }
        for (const h of [...handlers]) h(msg);
      }
    });

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: cmdId++, connect: { token } }));
    });

    ws.addEventListener('error', () => reject(new Error('WS error')));
    setTimeout(() => reject(new Error('Connect timeout')), 10000);
  });
}

// ========== MAIN ==========

console.log('=== Test: Tool Calls (hello → chat → tool_call → tool_result → answer) ===\n');

// Step 1: Connect to lobby, get session
const lobbyToken = jwt({ sub: 'lobby-user', exp: Math.floor(Date.now() / 1000) + 3600 });
const lobby = await connectWS(lobbyToken);
console.log('[1] Connected to lobby');

const helloAckPromise = new Promise((resolve) => {
  lobby.handlers.push((msg) => {
    const data = msg.push?.pub?.data;
    if (data?.type === 'hello_ack') resolve(data);
  });
});

lobby.ws.send(JSON.stringify({
  id: lobby.cmdId(),
  publish: {
    channel: 'session:lobby',
    data: {
      type: 'hello',
      form_id: `test-tools-${Date.now()}`,
      config_name: 'БухгалтерияПредприятия',
      config_version: '3.0.191.41',
      computer: 'TESTPC',
      connection_string: 'test',
    },
  },
}));

const helloAck = await helloAckPromise;
const channel = `session:${helloAck.session_id}`;
console.log(`[2] hello_ack: session=${helloAck.session_id}`);
lobby.ws.close();

// Step 2: Reconnect as Chat with chat_jwt
const chat = await connectWS(helloAck.chat_jwt);
console.log(`[3] Chat reconnected, auto-sub: ${chat.autoSubs.includes(channel)}`);

// Step 3: Set up tool_call handler — simulate Chat EPF
let toolCallReceived = false;
chat.handlers.push((msg) => {
  const data = msg.push?.pub?.data;
  if (data?.type === 'tool_call') {
    toolCallReceived = true;
    console.log(`[5] tool_call received: tool=${data.tool}, request_id=${data.request_id}`);
    console.log(`    params: ${JSON.stringify(data.params)}`);

    // Simulate 1C executing the query and returning result
    const mockResult = {
      columns: ['Наименование', 'ИНН'],
      rows: [
        { 'Наименование': 'ООО Ромашка', 'ИНН': '7701234567' },
        { 'Наименование': 'ИП Иванов', 'ИНН': '770987654321' },
      ],
    };

    // Send tool_result back
    setTimeout(() => {
      console.log('[6] Sending tool_result (mock 1C response)');
      chat.ws.send(JSON.stringify({
        id: chat.cmdId(),
        publish: {
          channel,
          data: {
            type: 'tool_result',
            request_id: data.request_id,
            result: JSON.stringify(mockResult),
          },
        },
      }));
    }, 200);
  }
});

// Step 4: Collect streaming events
const events = [];
let fullText = '';

chat.handlers.push((msg) => {
  const data = msg.push?.pub?.data;
  if (!data?.type) return;

  if (['text_delta', 'thinking_start', 'thinking_delta', 'thinking_end', 'assistant_end'].includes(data.type)) {
    events.push(data.type);

    if (data.type === 'text_delta') {
      fullText += data.text;
      process.stdout.write(data.text);
    }

    if (data.type === 'assistant_end') {
      console.log('\n');
      console.log(`[7] Streaming complete. Events: ${events.length}`);
      console.log(`    Types: ${[...new Set(events)].join(', ')}`);
      console.log(`    Text: "${fullText.slice(0, 300)}"`);
      console.log(`\n[RESULT] tool_call received: ${toolCallReceived ? 'OK' : 'FAIL'}`);
      console.log(`[RESULT] text_delta: ${events.includes('text_delta') ? 'OK' : 'FAIL'}`);
      console.log(`[RESULT] assistant_end: OK`);
      chat.ws.close();
      setTimeout(() => process.exit(0), 500);
    }
  }
});

// Wait for Claude to be ready, then send a question that triggers tool use
setTimeout(() => {
  console.log('[4] Sending chat: "Выполни запрос: ВЫБРАТЬ ПЕРВЫЕ 2 Наименование, ИНН ИЗ Справочник.Контрагенты"');
  chat.ws.send(JSON.stringify({
    id: chat.cmdId(),
    publish: {
      channel,
      data: {
        type: 'chat',
        text: 'Выполни запрос: ВЫБРАТЬ ПЕРВЫЕ 2 Наименование, ИНН ИЗ Справочник.Контрагенты',
      },
    },
  }));
}, 5000);

// Global timeout
setTimeout(() => {
  console.log('\n[TIMEOUT] 90s elapsed');
  console.log(`[RESULT] tool_call received: ${toolCallReceived ? 'OK' : 'FAIL'}`);
  console.log(`[RESULT] events: ${[...new Set(events)].join(', ') || 'none'}`);
  process.exit(1);
}, 90000);
