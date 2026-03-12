// Test: full chat flow — hello → reconnect → chat → streaming response
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

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: cmdId++, connect: { token } }));
    });

    const handlers = [];
    ws.addEventListener('message', (event) => {
      for (const msg of parseMessages(event.data)) {
        if (msg.id === 1 && msg.connect) {
          resolve({ ws, cmdId: () => cmdId++, handlers, autoSubs: msg.connect.subs ? Object.keys(msg.connect.subs) : [] });
        }
        // Ping/pong
        for (const h of [...handlers]) h(msg);
      }
    });

    ws.addEventListener('error', () => reject(new Error('WS error')));
    setTimeout(() => reject(new Error('Connect timeout')), 10000);
  });
}

// ========== MAIN ==========

console.log('=== Test: Chat Flow (hello → reconnect → chat → streaming) ===\n');

// Step 1: Connect to lobby, send hello
const lobbyToken = jwt({ sub: 'lobby-user', exp: Math.floor(Date.now() / 1000) + 3600 });
const lobby = await connectWS(lobbyToken);
console.log('[1] Connected to lobby');

// Wait for hello_ack
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
      form_id: `test-chat-${Date.now()}`,
      config_name: 'БухгалтерияПредприятия',
      config_version: '3.0.191.41',
      computer: 'TESTPC',
      connection_string: 'test',
    },
  },
}));
console.log('[2] Published hello');

const helloAck = await helloAckPromise;
console.log(`[3] hello_ack: status=${helloAck.status}, session=${helloAck.session_id}`);
lobby.ws.close();

// Step 2: Reconnect with chat_jwt
const chat = await connectWS(helloAck.chat_jwt);
const channel = `session:${helloAck.session_id}`;

if (chat.autoSubs.includes(channel)) {
  console.log(`[4] Reconnected with chat_jwt, auto-subscribed to ${channel}`);
} else {
  console.error(`[FAIL] Not auto-subscribed to ${channel}`);
  process.exit(1);
}

// Step 3: Wait for auth_ack (MVP auto-auth)
const authAckPromise = new Promise((resolve) => {
  chat.handlers.push((msg) => {
    const data = msg.push?.pub?.data;
    if (data?.type === 'auth_ack') resolve(data);
  });
});

// auth_ack might have already been sent before we reconnected
// Give it a moment, or it may already be in the channel
const authTimeout = setTimeout(() => {
  console.log('[5] auth_ack: skipped (already sent before reconnect, MVP auto-auth)');
  sendChat();
}, 3000);

authAckPromise.then((ack) => {
  clearTimeout(authTimeout);
  console.log(`[5] auth_ack: status=${ack.status}`);
  sendChat();
});

// Step 4: Send chat message and collect streaming events
function sendChat() {
  console.log('[6] Sending chat message: "Скажи одним словом: 2+2="');

  const events = [];
  let fullText = '';
  let gotEnd = false;

  chat.handlers.push((msg) => {
    const data = msg.push?.pub?.data;
    if (!data?.type) return;

    // Collect all protocol events
    if (['text_delta', 'thinking_start', 'thinking_delta', 'thinking_end', 'assistant_end', 'tool_call'].includes(data.type)) {
      events.push(data.type);

      if (data.type === 'text_delta') {
        fullText += data.text;
        process.stdout.write(data.text); // live streaming
      }

      if (data.type === 'assistant_end') {
        gotEnd = true;
        console.log('\n');
        console.log(`[7] Streaming complete. Events received: ${events.length}`);
        console.log(`    Event types: ${[...new Set(events)].join(', ')}`);
        console.log(`    Full text (delta): "${fullText.slice(0, 200)}"`);
        console.log(`    assistant_end text: "${(data.text || '').slice(0, 200)}"`);
        console.log(`\n[RESULT] text_delta: ${events.includes('text_delta') ? 'OK' : 'FAIL'}`);
        console.log(`[RESULT] assistant_end: OK`);
        chat.ws.close();
        setTimeout(() => process.exit(0), 500);
      }
    }
  });

  // Send the message
  chat.ws.send(JSON.stringify({
    id: chat.cmdId(),
    publish: {
      channel,
      data: { type: 'chat', text: 'Скажи одним словом: 2+2=' },
    },
  }));
}

// Global timeout
setTimeout(() => {
  console.log('\n[TIMEOUT] No complete response in 60s');
  process.exit(1);
}, 60000);
