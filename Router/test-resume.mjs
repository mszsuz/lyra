// Test: kill Claude mid-session → resume with --resume
// 1. hello → hello_ack → Claude spawns
// 2. Send "Привет, меня зовут Тест123" → wait for assistant_end
// 3. Kill ALL claude.exe child processes (simulating crash)
// 4. Send "как меня зовут?" → Router sees claudeProcess=null → respawn with --resume
// 5. If response contains "Тест123" → PASS

import { createHmac } from 'node:crypto';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const HMAC = 'wtFBIxmI__UGR23PSDUPgjj5MlkCtgAT1-WHkZmMGOX5MKge30CmyeOL3Ai2U-F_qCOPyAIjbkbAkP5W_RP7Yw';

function jwt(p) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify(p)).toString('base64url');
  const s = createHmac('sha256', HMAC).update(`${h}.${b}`).digest('base64url');
  return `${h}.${b}.${s}`;
}

const FORM_ID = 'test-resume-' + Date.now();
const token = jwt({ sub: 'lobby-user', exp: Math.floor(Date.now() / 1000) + 3600 });

let chatJwt = null;
let sessionChannel = null;
let sessionId = null;
let step = 'hello';
let chatWs = null;

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [step=${step}] ${msg}`);
}

// Step 1: Connect to lobby and send hello
const ws = new WebSocket('ws://localhost:11000/connection/websocket');

ws.addEventListener('open', () => {
  ws.send(JSON.stringify({ id: 1, connect: { token } }));
});

ws.addEventListener('message', (e) => {
  for (const line of e.data.split('\n')) {
    if (!line.trim() || line.trim() === '{}') continue;
    const msg = JSON.parse(line);

    if (msg.id === 1 && msg.connect) {
      log('Connected as lobby-user');
      ws.send(JSON.stringify({
        id: 2,
        publish: {
          channel: 'session:lobby',
          data: {
            type: 'hello',
            form_id: FORM_ID,
            config_name: 'БухгалтерияПредприятия',
            config_version: '3.0.191.41',
            computer: 'TESTPC',
          },
        },
      }));
      log('Published hello');
    }

    const data = msg.push?.pub?.data;
    if (!data) continue;

    if (data.type === 'hello_ack') {
      chatJwt = data.chat_jwt;
      sessionId = data.session_id;
      sessionChannel = `session:${sessionId}`;
      log(`hello_ack: session=${sessionId}`);
      ws.close();
      connectAsChat();
    }
  }
});

function connectAsChat() {
  chatWs = new WebSocket('ws://localhost:11000/connection/websocket');

  chatWs.addEventListener('open', () => {
    chatWs.send(JSON.stringify({ id: 1, connect: { token: chatJwt } }));
  });

  chatWs.addEventListener('message', (e) => {
    for (const line of e.data.split('\n')) {
      if (!line.trim() || line.trim() === '{}') continue;
      const msg = JSON.parse(line);

      if (msg.id === 1 && msg.connect) {
        log('Connected as chat user');
        step = 'first_msg';
        setTimeout(() => {
          log('Sending: "Привет! Меня зовут Тест123. Запомни это имя. Ответь коротко."');
          chatWs.send(JSON.stringify({
            id: 10,
            publish: {
              channel: sessionChannel,
              data: { type: 'chat', text: 'Привет! Меня зовут Тест123. Запомни это имя. Ответь коротко.' },
            },
          }));
          step = 'wait_first_end';
        }, 500);
      }

      const data = msg.push?.pub?.data;
      if (!data) continue;

      if (data.type === 'text_delta' && step !== 'killed') {
        process.stdout.write(data.text || '');
      }

      if (data.type === 'assistant_end' && step === 'wait_first_end') {
        console.log(''); // newline
        log(`First response done: "${(data.text || '').slice(0, 100)}"`);
        step = 'killing';

        // Kill only the Router's Claude process (not others like our parent claude.exe!)
        // Read router.log to find the PID
        log('Finding Router Claude PID from router.log...');
        try {
          const logContent = readFileSync('router.log', 'utf-8');
          const pidMatch = logContent.match(/Claude PID=(\d+)/);
          if (pidMatch) {
            const pid = pidMatch[1];
            log(`Killing Claude PID=${pid} (from router.log)`);
            execSync(`taskkill /PID ${pid} /T /F`, { encoding: 'utf-8' });
            log(`Killed PID ${pid}`);
          } else {
            log('ERROR: Could not find Claude PID in router.log');
          }
        } catch (err) {
          log(`Kill error: ${err.message}`);
        }

        step = 'killed';

        // Wait for Router to detect exit, then send resume question
        setTimeout(() => {
          step = 'resume_msg';
          log('Sending resume question: "Скажи, как меня зовут? Ответь одним словом."');
          chatWs.send(JSON.stringify({
            id: 12,
            publish: {
              channel: sessionChannel,
              data: { type: 'chat', text: 'Скажи, как меня зовут? Ответь одним словом.' },
            },
          }));
          step = 'wait_resume_end';
        }, 3000);
      }

      if (data.type === 'text_delta' && (step === 'wait_resume_end' || step === 'resume_msg')) {
        process.stdout.write(data.text || '');
      }

      if (data.type === 'assistant_end' && step === 'wait_resume_end') {
        console.log(''); // newline
        const fullText = (data.text || '').toLowerCase();
        const hasName = fullText.includes('тест123');
        log(`Resume response: "${(data.text || '').slice(0, 200)}"`);
        log(hasName ? '✓ PASS — Claude remembered "Тест123" after resume!' : '✗ FAIL — Claude did NOT remember the name');
        chatWs.close();
        setTimeout(() => process.exit(hasName ? 0 : 1), 500);
      }
    }
  });
}

setTimeout(() => {
  log('TIMEOUT');
  process.exit(1);
}, 180000);
