// Слушатель session:lobby — выводит hello от Чата
import { createHmac } from 'crypto';

const CFG = {
  ws: 'ws://localhost:11000/connection/websocket',
  secret: 'wtFBIxmI__UGR23PSDUPgjj5MlkCtgAT1-WHkZmMGOX5MKge30CmyeOL3Ai2U-F_qCOPyAIjbkbAkP5W_RP7Yw',
};

function makeJWT(sub, channels) {
  const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({sub, exp: Math.floor(Date.now()/1000)+3600, ...(channels?{channels}:{})})).toString('base64url');
  const sig = createHmac('sha256', CFG.secret).update(header+'.'+payload).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

const token = makeJWT('test-listener', ['session:lobby']);
const ws = new WebSocket(CFG.ws);

ws.onopen = () => {
  console.log('Connected, subscribing to session:lobby...');
  ws.send(JSON.stringify({id:1, connect:{token}}));
};

ws.onmessage = (e) => {
  for (const line of e.data.split('\n')) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.push?.pub?.data) {
      console.log('\n=== HELLO DATA ===');
      console.log(JSON.stringify(msg.push.pub.data, null, 2));
      console.log('==================\n');
      // Закрыть после получения
      setTimeout(() => { ws.close(); process.exit(0); }, 1000);
    } else if (msg.id === 1) {
      console.log('Subscribed to lobby. Waiting for hello...');
    }
  }
};

ws.onerror = (e) => console.error('WS error:', e.message);

// Таймаут 30 сек
setTimeout(() => { console.log('Timeout'); ws.close(); process.exit(1); }, 30000);
