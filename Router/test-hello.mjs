// Test: hello flow with Node.js Router
import { createHmac } from 'node:crypto';

const HMAC = 'wtFBIxmI__UGR23PSDUPgjj5MlkCtgAT1-WHkZmMGOX5MKge30CmyeOL3Ai2U-F_qCOPyAIjbkbAkP5W_RP7Yw';

function jwt(p) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(p)).toString('base64url');
  const s = createHmac('sha256', HMAC).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${s}`;
}

const token = jwt({ sub: 'lobby-user', exp: Math.floor(Date.now() / 1000) + 3600 });
const ws = new WebSocket('ws://localhost:11000/connection/websocket');

const results = { hello_ack: false, auth_ack: false };

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ id: 1, connect: { token } }));
});

ws.addEventListener('message', (e) => {
  for (const line of e.data.split('\n')) {
    if (!line.trim() || line.trim() === '{}') continue;
    const msg = JSON.parse(line);

    if (msg.id === 1 && msg.connect) {
      console.log('[TEST] Connected as lobby-user');
      ws.send(JSON.stringify({
        id: 2,
        publish: {
          channel: 'session:lobby',
          data: {
            type: 'hello',
            form_id: 'test-form-' + Date.now(),
            config_name: 'БухгалтерияПредприятия',
            config_version: '3.0.191.41',
            computer: 'TESTPC',
            connection_string: 'test',
          },
        },
      }));
      console.log('[TEST] Published hello');
    }

    const data = msg.push?.pub?.data;
    if (!data) continue;

    if (data.type === 'hello_ack') {
      results.hello_ack = true;
      console.log(`[TEST] hello_ack: status=${data.status}, session=${data.session_id}`);
      console.log(`[TEST]   chat_jwt: ${!!data.chat_jwt}`);
      console.log(`[TEST]   mobile_jwt: ${!!data.mobile_jwt}`);
    }

    if (data.type === 'auth_ack') {
      results.auth_ack = true;
      console.log(`[TEST] auth_ack: status=${data.status}`);
      // Done
      ws.close();
      setTimeout(() => {
        console.log(`\n[RESULT] hello_ack: ${results.hello_ack ? 'OK' : 'FAIL'}`);
        console.log(`[RESULT] auth_ack: ${results.auth_ack ? 'OK' : 'FAIL'}`);
        process.exit(results.hello_ack && results.auth_ack ? 0 : 1);
      }, 500);
    }
  }
});

setTimeout(() => {
  console.log('[TEST] TIMEOUT');
  console.log(`[RESULT] hello_ack: ${results.hello_ack ? 'OK' : 'FAIL'}`);
  console.log(`[RESULT] auth_ack: ${results.auth_ack ? 'OK' : 'FAIL'}`);
  process.exit(1);
}, 10000);
