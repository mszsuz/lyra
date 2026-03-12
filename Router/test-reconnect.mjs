// Test: reconnect flow — two hellos with same form_id
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

async function sendHelloAndWait(formId) {
  const lobbyToken = jwt({ sub: 'lobby-user', exp: Math.floor(Date.now() / 1000) + 3600 });
  const lobby = await connectWS(lobbyToken);

  return new Promise((resolve) => {
    const results = {};
    lobby.handlers.push((msg) => {
      const data = msg.push?.pub?.data;
      if (data?.type === 'hello_ack') {
        results.helloAck = data;
      }
      if (data?.type === 'auth_ack') {
        results.authAck = data;
        lobby.ws.close();
        resolve(results);
      }
    });

    // Also resolve after timeout (reconnect doesn't send auth_ack)
    setTimeout(() => {
      lobby.ws.close();
      resolve(results);
    }, 5000);

    lobby.ws.send(JSON.stringify({
      id: lobby.cmdId(),
      publish: {
        channel: 'session:lobby',
        data: {
          type: 'hello',
          form_id: formId,
          config_name: 'БухгалтерияПредприятия',
          config_version: '3.0.191.41',
          computer: 'TESTPC',
          connection_string: 'test',
        },
      },
    }));
  });
}

// ========== MAIN ==========

console.log('=== Test: Reconnect (same form_id) ===\n');

const formId = `test-reconnect-${Date.now()}`;

// First hello — new session
console.log('[1] First hello (new session)...');
const first = await sendHelloAndWait(formId);
console.log(`    hello_ack: status=${first.helloAck?.status}, session=${first.helloAck?.session_id}`);
console.log(`    auth_ack: ${first.authAck?.status || 'N/A'}`);
console.log(`    chat_jwt: ${!!first.helloAck?.chat_jwt}`);
console.log(`    mobile_jwt: ${!!first.helloAck?.mobile_jwt}`);

const sessionId = first.helloAck?.session_id;

// Wait a bit
await new Promise(r => setTimeout(r, 1000));

// Second hello — same form_id → reconnect
console.log('\n[2] Second hello (reconnect, same form_id)...');
const second = await sendHelloAndWait(formId);
console.log(`    hello_ack: status=${second.helloAck?.status}, session=${second.helloAck?.session_id}`);
console.log(`    chat_jwt: ${!!second.helloAck?.chat_jwt}`);
console.log(`    mobile_jwt: ${!!second.helloAck?.mobile_jwt}`);

// Verify
const ok1 = first.helloAck?.status === 'awaiting_auth';
const ok2 = second.helloAck?.status === 'reconnected';
const ok3 = second.helloAck?.chat_jwt && !second.helloAck?.mobile_jwt; // new chat_jwt, no mobile_jwt
const ok4 = !!first.helloAck?.mobile_jwt; // first hello has mobile_jwt

console.log(`\n[RESULT] first hello → awaiting_auth: ${ok1 ? 'OK' : 'FAIL'}`);
console.log(`[RESULT] second hello → reconnected: ${ok2 ? 'OK' : 'FAIL'}`);
console.log(`[RESULT] reconnect: new chat_jwt, no mobile_jwt: ${ok3 ? 'OK' : 'FAIL'}`);
console.log(`[RESULT] first hello has mobile_jwt: ${ok4 ? 'OK' : 'FAIL'}`);

process.exit(ok1 && ok2 && ok3 && ok4 ? 0 : 1);
