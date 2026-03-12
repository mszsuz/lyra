#!/usr/bin/env node
// Тест 1c-mcp-relay: запускает relay как дочерний процесс, отправляет MCP JSON-RPC,
// проверяет ответы.
//
// Запуск: node test-relay.mjs

import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HMAC_SECRET = 'wtFBIxmI__UGR23PSDUPgjj5MlkCtgAT1-WHkZmMGOX5MKge30CmyeOL3Ai2U-F_qCOPyAIjbkbAkP5W_RP7Yw';
const WS_URL = 'ws://localhost:11000/connection/websocket';
const TEST_CHANNEL = 'session:test-relay-' + Date.now();
const TOOLS_PATH = resolve(__dirname, '../../1ext.ru/projects/github.com/ЕХТ_Лира_Роутер/Профили/Основной/tools.json')
  .replace(/\\/g, '/');
// Use relative path from repo root
const TOOLS_PATH_REL = resolve(__dirname, '../../../1ext.ru/projects/github.com/ЕХТ_Лира_Роутер/Профили/Основной/tools.json');

// --- JWT ---
function generateJWT(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', HMAC_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

const token = generateJWT({
  sub: 'test-relay',
  channels: [TEST_CHANNEL],
  exp: Math.floor(Date.now() / 1000) + 3600,
});

// --- Resolve tools path ---
const toolsPath = 'C:/1ext.ru/projects/github.com/ЕХТ_Лира_Роутер/Профили/Основной/tools.json';

console.log('=== Test 1c-mcp-relay ===');
console.log(`Channel: ${TEST_CHANNEL}`);
console.log(`Tools: ${toolsPath}`);
console.log();

// --- Spawn relay ---
const relayPath = resolve(__dirname, 'relay.mjs');
const relay = spawn('node', [
  relayPath,
  '--url', WS_URL,
  '--token', token,
  '--channel', TEST_CHANNEL,
  '--tools', toolsPath,
], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

relay.stderr.on('data', (d) => {
  process.stderr.write(`  [relay] ${d}`);
});

// --- Read responses ---
let buf = '';
const responses = [];
const waiters = [];

relay.stdout.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      responses.push(msg);
      // Resolve any waiters
      for (const w of [...waiters]) {
        if (w.check(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    } catch (e) {
      console.error('  [stdout] non-JSON:', line);
    }
  }
});

function waitForResponse(id, timeoutMs = 10000) {
  // Check if already received
  const existing = responses.find(r => r.id === id);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for response id=${id}`));
    }, timeoutMs);
    waiters.push({
      check: (msg) => msg.id === id,
      resolve: (msg) => { clearTimeout(timer); resolve(msg); },
    });
  });
}

function send(msg) {
  relay.stdin.write(JSON.stringify(msg) + '\n');
}

// --- Wait for relay to be ready ---
await new Promise(r => setTimeout(r, 2000));

// --- Test 1: initialize ---
console.log('Test 1: initialize');
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {} } });

try {
  const resp = await waitForResponse(1);
  console.log('  Response:', JSON.stringify(resp));
  const ok = resp.result?.protocolVersion && resp.result?.serverInfo?.name === '1c-mcp-relay';
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}`);
} catch (e) {
  console.log(`  ❌ FAIL: ${e.message}`);
}

// Send initialized notification
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

// --- Test 2: tools/list ---
console.log('\nTest 2: tools/list');
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

try {
  const resp = await waitForResponse(2);
  const toolNames = resp.result?.tools?.map(t => t.name) || [];
  console.log('  Tools:', toolNames.join(', '));
  const ok = toolNames.includes('v8_query') && toolNames.includes('v8_eval')
    && toolNames.includes('v8_metadata') && toolNames.includes('v8_exec');
  console.log(`  ${ok ? '✅ PASS' : '❌ FAIL'}`);

  // Check inputSchema format (should be camelCase for MCP)
  const queryTool = resp.result.tools.find(t => t.name === 'v8_query');
  const hasInputSchema = !!queryTool?.inputSchema;
  console.log(`  inputSchema present: ${hasInputSchema ? '✅' : '❌'}`);
} catch (e) {
  console.log(`  ❌ FAIL: ${e.message}`);
}

// --- Test 3: tools/call (will timeout since no 1C client, but tests the publish flow) ---
console.log('\nTest 3: tools/call (expect timeout — no 1C client to respond)');
send({
  jsonrpc: '2.0', id: 3, method: 'tools/call',
  params: { name: 'v8_eval', arguments: { expression: 'Строка(ТекущаяДата())' } }
});

// We expect this to timeout or return error since there's no Chat client
try {
  const resp = await waitForResponse(3, 5000);
  // If we get a response, it should be an error (timeout)
  const hasError = resp.result?.isError || resp.error;
  console.log('  Response:', JSON.stringify(resp).slice(0, 200));
  console.log(`  ${hasError ? '✅ PASS (got error as expected)' : '⚠️ Unexpected success'}`);
} catch (e) {
  console.log(`  ✅ PASS (timeout — no 1C client, expected)`);
}

// --- Cleanup ---
console.log('\n=== Done ===');
relay.kill();
process.exit(0);
