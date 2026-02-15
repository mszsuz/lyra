#!/usr/bin/env node
'use strict';

/**
 * Test for bridge-sdk.js
 *
 * Tests:
 * 1. WebSocket connection
 * 2. Session creation (hello -> hello_ack)
 * 3. Chat -> streaming events -> result
 * 4. Busy rejection (concurrent request)
 * 5. Reconnection with session ID
 * 6. MCP request/response (if 1C connected)
 *
 * Usage:
 *   1. Start bridge:  node bridge-sdk.js --port 3003
 *   2. Run tests:     node test-bridge-sdk.js [--port 3003]
 *
 * Or auto-start bridge:
 *   node test-bridge-sdk.js --auto
 */

const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const PORT = Number(argVal('--port')) || 3003;
const AUTO_START = args.includes('--auto');
const TIMEOUT = 60000;  // 60s timeout for agent responses

function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

let bridgeProcess = null;
let passed = 0;
let failed = 0;
let skipped = 0;

// JWT secret for tests (should match bridge LYRA_JWT_SECRET env var)
const TEST_JWT_SECRET = process.env.LYRA_JWT_SECRET || null;

/**
 * Generate HS256 JWT token for tests
 */
function generateTestToken(user, role, expiresHours) {
  if (!TEST_JWT_SECRET) return null;

  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: user,
    role: role,
    iat: now,
    exp: now + (expiresHours * 3600)
  };

  const base64url = (str) => Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const signatureInput = `${headerB64}.${payloadB64}`;
  const signature = crypto
    .createHmac('sha256', TEST_JWT_SECRET)
    .update(signatureInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${headerB64}.${payloadB64}.${signature}`;
}

// ─── Test helpers ────────────────────────────────────────────

function log(msg) {
  console.log(`  ${msg}`);
}

function ok(name) {
  passed++;
  console.log(`  [PASS] ${name}`);
}

function fail(name, err) {
  failed++;
  console.log(`  [FAIL] ${name}: ${err}`);
}

function skip(name, reason) {
  skipped++;
  console.log(`  [SKIP] ${name}: ${reason}`);
}

function connect(sessionId, token) {
  let url = `ws://localhost:${PORT}/`;
  const params = [];

  if (sessionId) params.push(`session=${sessionId}`);
  if (token !== undefined) params.push(`token=${token}`);

  if (params.length > 0) {
    url += '?' + params.join('&');
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('Connection timeout (5s)'));
    }, 5000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function waitForMessage(ws, predicate, timeoutMs = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      reject(new Error(`Timeout waiting for message (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(raw) {
      try {
        const msg = JSON.parse(raw);
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg);
        }
      } catch {}
    }
    ws.on('message', handler);
  });
}

function collectMessages(ws, timeoutMs = TIMEOUT) {
  const messages = [];
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.removeListener('message', handler);
      resolve(messages);
    }, timeoutMs);

    function handler(raw) {
      try {
        const msg = JSON.parse(raw);
        messages.push(msg);
        if (msg.type === 'result' || msg.type === 'error') {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(messages);
        }
      } catch {}
    }
    ws.on('message', handler);
  });
}

function send(ws, data) {
  ws.send(JSON.stringify(data));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Tests ───────────────────────────────────────────────────

async function testAuthNoToken() {
  const name = 'Auth: connection without token';
  if (!TEST_JWT_SECRET) {
    skip(name, 'JWT disabled');
    return;
  }

  try {
    const ws = await connect(null, null);  // no token
    // Should get close event with code 4001
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No close event')), 2000);
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        if (code === 4001) {
          ok(name);
          resolve();
        } else {
          fail(name, `Expected code 4001, got ${code}: ${reason}`);
          resolve();
        }
      });
      ws.on('message', () => {
        clearTimeout(timer);
        fail(name, 'Connection accepted without token');
        resolve();
      });
    });
  } catch (e) {
    fail(name, e.message);
  }
}

async function testAuthInvalidToken() {
  const name = 'Auth: connection with invalid token';
  if (!TEST_JWT_SECRET) {
    skip(name, 'JWT disabled');
    return;
  }

  try {
    const ws = await connect(null, 'invalid.token.here');
    // Should get close event with code 4001
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No close event')), 2000);
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        if (code === 4001) {
          ok(name);
          resolve();
        } else {
          fail(name, `Expected code 4001, got ${code}: ${reason}`);
          resolve();
        }
      });
      ws.on('message', () => {
        clearTimeout(timer);
        fail(name, 'Connection accepted with invalid token');
        resolve();
      });
    });
  } catch (e) {
    fail(name, e.message);
  }
}

async function testConnection() {
  const name = 'WebSocket connection';
  try {
    const token = TEST_JWT_SECRET ? generateTestToken('Test User', 'user', 24) : null;
    const ws = await connect(null, token);
    const msg = await waitForMessage(ws, m => m.type === 'session', 5000);
    if (msg.sessionId) {
      ok(name);
    } else {
      fail(name, 'No sessionId in session message');
    }
    ws.close();
    return msg.sessionId;
  } catch (e) {
    fail(name, e.message);
    return null;
  }
}

async function testHello() {
  const name = 'Hello -> hello_ack';
  try {
    const token = TEST_JWT_SECRET ? generateTestToken('Test User', 'user', 24) : null;
    const ws = await connect(null, token);
    await waitForMessage(ws, m => m.type === 'session', 5000);

    send(ws, {
      type: 'hello',
      config: 'БухгалтерияПредприятия',
      version: '3.0.150.27',
      userName: 'Тест Тестович',
      userRole: 'user'
    });

    const ack = await waitForMessage(ws, m => m.type === 'hello_ack', 5000);
    if (ack.sessionId && ack.baseId) {
      ok(name);
    } else {
      fail(name, `Missing fields: ${JSON.stringify(ack)}`);
    }

    // After hello_ack, Haiku should start greeting (stream events)
    log('Waiting for greeting stream...');
    const messages = await collectMessages(ws, TIMEOUT);

    const streamEvents = messages.filter(m => m.type === 'stream_event');
    const resultMsg = messages.find(m => m.type === 'result');

    if (streamEvents.length > 0) {
      ok('Greeting: stream events received');
      const texts = streamEvents
        .filter(m => m.event?.delta?.text)
        .map(m => m.event.delta.text);
      log(`  Streamed ${texts.length} text chunks, total ${texts.join('').length} chars`);
      log(`  Preview: "${texts.join('').slice(0, 100)}..."`);
    } else {
      fail('Greeting: stream events', 'No stream events received');
    }

    if (resultMsg) {
      ok('Greeting: result message');
      log(`  Result: "${(resultMsg.result || '').slice(0, 100)}..."`);
      if (resultMsg.usage) {
        log(`  Usage: ${JSON.stringify(resultMsg.usage)}`);
      }
      if (resultMsg.costUsd !== undefined) {
        log(`  Cost: $${resultMsg.costUsd}`);
      }
    } else {
      fail('Greeting: result message', 'No result message received');
    }

    ws.close();
    return ack.sessionId;
  } catch (e) {
    fail(name, e.message);
    return null;
  }
}

async function testChat(sessionId) {
  const name = 'Chat -> streaming -> result';
  if (!sessionId) {
    skip(name, 'No session from previous test');
    return null;
  }

  try {
    const token = TEST_JWT_SECRET ? generateTestToken('Test User', 'user', 24) : null;
    const ws = await connect(sessionId, token);
    await waitForMessage(ws, m => m.type === 'session', 5000);

    log('Sending: "Что такое УСН?"');
    send(ws, { type: 'chat', content: 'Что такое УСН?' });

    const messages = await collectMessages(ws, TIMEOUT);

    const streamEvents = messages.filter(m => m.type === 'stream_event');
    const resultMsg = messages.find(m => m.type === 'result');
    const errorMsg = messages.find(m => m.type === 'error');

    if (errorMsg) {
      fail(name, `Error: ${errorMsg.message}`);
      ws.close();
      return sessionId;
    }

    if (streamEvents.length > 0 && resultMsg) {
      ok(name);
      const texts = streamEvents
        .filter(m => m.event?.delta?.text)
        .map(m => m.event.delta.text);
      log(`  ${texts.length} text chunks, ${texts.join('').length} chars`);
      log(`  Preview: "${texts.join('').slice(0, 150)}..."`);
      log(`  Duration: ${resultMsg.durationMs}ms, Cost: $${resultMsg.costUsd}`);
    } else if (resultMsg) {
      ok(name + ' (no streaming, but got result)');
      log(`  Result: "${(resultMsg.result || '').slice(0, 150)}..."`);
    } else {
      fail(name, `Got ${messages.length} messages but no result`);
    }

    ws.close();
    return sessionId;
  } catch (e) {
    fail(name, e.message);
    return sessionId;
  }
}

async function testBusyRejection(sessionId) {
  const name = 'Busy rejection';
  if (!sessionId) {
    skip(name, 'No session');
    return;
  }

  try {
    const token = TEST_JWT_SECRET ? generateTestToken('Test User', 'user', 24) : null;
    const ws = await connect(sessionId, token);
    await waitForMessage(ws, m => m.type === 'session', 5000);

    // Send a complex question that takes time
    send(ws, { type: 'chat', content: 'Расскажи подробно про виды налогообложения в России.' });
    // Immediately send another question
    await sleep(100);
    send(ws, { type: 'chat', content: 'А что такое ЕНВД?' });

    // The second should get a busy error
    const busyMsg = await waitForMessage(ws, m => m.type === 'error' && m.reason === 'busy', 5000);

    if (busyMsg) {
      ok(name);
    } else {
      fail(name, 'No busy rejection received');
    }

    // Wait for the first query to finish
    await waitForMessage(ws, m => m.type === 'result', TIMEOUT);
    ws.close();
  } catch (e) {
    fail(name, e.message);
  }
}

async function testReconnection(sessionId) {
  const name = 'Reconnection with session ID';
  if (!sessionId) {
    skip(name, 'No session');
    return;
  }

  try {
    const token = TEST_JWT_SECRET ? generateTestToken('Test User', 'user', 24) : null;
    const ws = await connect(sessionId, token);
    const msg = await waitForMessage(ws, m => m.type === 'session', 5000);

    if (msg.sessionId === sessionId) {
      ok(name);
    } else {
      fail(name, `Session ID mismatch: expected ${sessionId}, got ${msg.sessionId}`);
    }

    ws.close();
  } catch (e) {
    fail(name, e.message);
  }
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('=== Lyra Bridge SDK Tests ===\n');

  // Auto-start bridge if requested
  if (AUTO_START) {
    console.log('Starting bridge-sdk.js...');
    bridgeProcess = spawn('node', [path.join(__dirname, 'bridge-sdk.js'), '--port', String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    bridgeProcess.stdout.on('data', d => process.stdout.write(`  [bridge] ${d}`));
    bridgeProcess.stderr.on('data', d => process.stderr.write(`  [bridge-err] ${d}`));

    // Wait for bridge to start
    await sleep(2000);
    console.log('');
  }

  try {
    // Test 0a: Auth without token (if JWT enabled)
    console.log('Test 0a: Auth without token');
    await testAuthNoToken();
    console.log('');

    // Test 0b: Auth with invalid token (if JWT enabled)
    console.log('Test 0b: Auth with invalid token');
    await testAuthInvalidToken();
    console.log('');

    // Test 1: Connection
    console.log('Test 1: WebSocket connection');
    await testConnection();
    console.log('');

    // Test 2: Hello + greeting
    console.log('Test 2: Hello -> hello_ack + greeting');
    const sessionId = await testHello();
    console.log('');

    // Test 3: Chat with simple question
    console.log('Test 3: Chat -> streaming -> result');
    await testChat(sessionId);
    console.log('');

    // Test 4: Busy rejection (disabled by default — takes long)
    if (args.includes('--full')) {
      console.log('Test 4: Busy rejection');
      await testBusyRejection(sessionId);
      console.log('');
    } else {
      console.log('Test 4: Busy rejection');
      skip('Busy rejection', 'Use --full to enable');
      console.log('');
    }

    // Test 5: Reconnection
    console.log('Test 5: Reconnection');
    await testReconnection(sessionId);
    console.log('');

  } catch (e) {
    console.error(`Unexpected error: ${e.message}`);
  }

  // Summary
  console.log('=== Summary ===');
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log('');

  if (bridgeProcess) {
    bridgeProcess.kill();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  if (bridgeProcess) bridgeProcess.kill();
  process.exit(1);
});
