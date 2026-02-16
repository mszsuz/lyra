#!/usr/bin/env node
'use strict';

/**
 * Lyra Bridge SDK — Load Test
 *
 * Launches N parallel WebSocket connections to lyra-bridge-sdk.js,
 * measures first-response latency, checks busy rejection behavior,
 * and outputs a summary table via console.table.
 *
 * Usage:
 *   node load-test.js [N] [--port PORT] [--jwt SECRET] [--timeout MS]
 *
 * Examples:
 *   node load-test.js                  # 5 clients, port 3003, no JWT
 *   node load-test.js 10               # 10 clients
 *   node load-test.js 3 --jwt secret   # 3 clients with JWT
 *   node load-test.js 5 --timeout 60000 # 60s timeout per client
 */

const WebSocket = require('ws');
const crypto = require('crypto');

// ─── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const N = parseInt(args.find(a => /^\d+$/.test(a))) || 5;
const PORT = Number(argVal('--port')) || 3003;
const JWT_SECRET = argVal('--jwt') || process.env.LYRA_JWT_SECRET || null;
const TIMEOUT = Number(argVal('--timeout')) || 120000;

function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

// ─── JWT ─────────────────────────────────────────────────────

function generateJwt(secret, user, role, expiresHours) {
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
    .createHmac('sha256', secret)
    .update(signatureInput)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  return `${headerB64}.${payloadB64}.${signature}`;
}

// ─── Logging ─────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// ─── Single client runner ────────────────────────────────────

/**
 * Runs a single client lifecycle:
 *  1. Connect to bridge
 *  2. Send hello
 *  3. Wait for greeting (first response)
 *  4. Send a chat message
 *  5. Wait for result or error (busy rejection)
 *  6. Disconnect
 *
 * Returns: { clientId, connectMs, firstResponseMs, chatResponseMs, status, error, busyRejected, resultLen }
 */
async function runClient(clientId) {
  const startTime = Date.now();
  const result = {
    clientId,
    connectMs: null,
    firstResponseMs: null,
    chatResponseMs: null,
    status: 'unknown',
    error: null,
    busyRejected: false,
    resultLen: 0,
    sessionId: null
  };

  return new Promise((resolve) => {
    let ws = null;
    let sessionId = null;
    let helloAckReceived = false;
    let firstResultTime = null;
    let chatSentTime = null;
    let streamBuffer = '';
    let done = false;
    let greetingDone = false;

    const finish = (status, error) => {
      if (done) return;
      done = true;
      result.status = status;
      result.error = error || null;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      resolve(result);
    };

    // Timeout
    const timer = setTimeout(() => {
      finish('timeout', `Timeout after ${TIMEOUT}ms`);
    }, TIMEOUT);

    // Build URL
    let url = `ws://localhost:${PORT}/`;
    const params = [];
    if (JWT_SECRET) {
      const token = generateJwt(JWT_SECRET, `LoadTestUser${clientId}`, 'tester', 1);
      params.push(`token=${token}`);
    }
    if (params.length > 0) url += '?' + params.join('&');

    try {
      ws = new WebSocket(url);
    } catch (e) {
      clearTimeout(timer);
      finish('connect_error', e.message);
      return;
    }

    ws.on('open', () => {
      result.connectMs = Date.now() - startTime;
      log(`Client ${clientId}: connected in ${result.connectMs}ms`);
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      finish('ws_error', e.message);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      if (!done) {
        if (code === 4001) {
          finish('auth_failed', 'JWT authentication failed');
        } else {
          finish('disconnected', `Close code ${code}`);
        }
      }
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'session') {
        sessionId = msg.sessionId;
        result.sessionId = sessionId;
        // Send hello
        ws.send(JSON.stringify({
          type: 'hello',
          config: `LoadTest-Config-${clientId}`,
          version: '3.0.0',
          processingVersion: '8.3.27.1846',
          userName: `LoadTestUser${clientId}`,
          userRole: 'tester',
          baseId: crypto.randomUUID()
        }));
      }

      if (msg.type === 'hello_ack') {
        helloAckReceived = true;
      }

      if (msg.type === 'stream_event') {
        const event = msg.event;
        if (event && event.type === 'content_block_delta' && event.delta) {
          streamBuffer += (event.delta.text || '');
        }
      }

      if (msg.type === 'result' && !greetingDone) {
        // First result = greeting
        greetingDone = true;
        result.firstResponseMs = Date.now() - startTime;
        log(`Client ${clientId}: greeting received in ${result.firstResponseMs}ms (${(msg.result || '').length} chars)`);
        streamBuffer = '';

        // Now send a chat message
        chatSentTime = Date.now();
        ws.send(JSON.stringify({
          type: 'chat',
          content: `Привет, я клиент номер ${clientId}. Какая версия платформы?`
        }));
        return;
      }

      if (msg.type === 'result' && greetingDone) {
        // Chat result
        result.chatResponseMs = chatSentTime ? (Date.now() - chatSentTime) : null;
        result.resultLen = (msg.result || '').length;
        clearTimeout(timer);
        log(`Client ${clientId}: chat result in ${result.chatResponseMs}ms (${result.resultLen} chars)`);
        finish('ok', null);
        return;
      }

      if (msg.type === 'error') {
        if (msg.reason === 'busy') {
          result.busyRejected = true;
          log(`Client ${clientId}: busy rejection received`);

          if (greetingDone) {
            // We already got greeting, busy on chat — wait for underlying query
            // but mark as success (busy rejection IS expected under load)
            clearTimeout(timer);
            finish('busy_rejected', 'Busy rejection on chat (expected under load)');
          }
          // If greeting not done yet — wait for it
        } else {
          clearTimeout(timer);
          finish('error', msg.message || msg.reason);
        }
      }
    });
  });
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('=== Lyra Bridge SDK: Load Test ===');
  console.log(`Clients:   ${N}`);
  console.log(`Bridge:    ws://localhost:${PORT}`);
  console.log(`JWT:       ${JWT_SECRET ? 'enabled' : 'disabled'}`);
  console.log(`Timeout:   ${TIMEOUT}ms`);
  console.log(`Started:   ${ts()}`);
  console.log('');

  const overallStart = Date.now();

  // Launch all clients in parallel
  log(`Launching ${N} clients in parallel...`);
  const promises = [];
  for (let i = 1; i <= N; i++) {
    // Stagger connections by 100ms to avoid thundering herd
    promises.push(
      new Promise(r => setTimeout(r, (i - 1) * 100)).then(() => runClient(i))
    );
  }

  const results = await Promise.all(promises);
  const overallMs = Date.now() - overallStart;

  console.log('');
  console.log('=== Results ===');
  console.log('');

  // Prepare table data
  const tableData = results.map(r => ({
    'Client': r.clientId,
    'Status': r.status,
    'Connect (ms)': r.connectMs || '-',
    'Greeting (ms)': r.firstResponseMs || '-',
    'Chat (ms)': r.chatResponseMs || '-',
    'Busy?': r.busyRejected ? 'YES' : 'no',
    'Result (chars)': r.resultLen || 0,
    'Error': r.error ? r.error.slice(0, 50) : '-'
  }));

  console.table(tableData);
  console.log('');

  // Summary statistics
  const okResults = results.filter(r => r.status === 'ok');
  const busyResults = results.filter(r => r.busyRejected);
  const errorResults = results.filter(r => r.status !== 'ok' && !r.busyRejected);

  const connectTimes = results.filter(r => r.connectMs).map(r => r.connectMs);
  const greetingTimes = results.filter(r => r.firstResponseMs).map(r => r.firstResponseMs);
  const chatTimes = results.filter(r => r.chatResponseMs).map(r => r.chatResponseMs);

  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const min = (arr) => arr.length ? Math.min(...arr) : 0;
  const max = (arr) => arr.length ? Math.max(...arr) : 0;
  const p50 = (arr) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };

  console.log('=== Summary ===');
  console.log(`  Total clients:       ${N}`);
  console.log(`  Successful:          ${okResults.length}`);
  console.log(`  Busy rejected:       ${busyResults.length}`);
  console.log(`  Errors:              ${errorResults.length}`);
  console.log(`  Total time:          ${overallMs}ms`);
  console.log('');

  if (connectTimes.length > 0) {
    console.log('  Connect latency:');
    console.log(`    min=${min(connectTimes)}ms  avg=${avg(connectTimes)}ms  max=${max(connectTimes)}ms  p50=${p50(connectTimes)}ms`);
  }

  if (greetingTimes.length > 0) {
    console.log('  Greeting latency (from connect):');
    console.log(`    min=${min(greetingTimes)}ms  avg=${avg(greetingTimes)}ms  max=${max(greetingTimes)}ms  p50=${p50(greetingTimes)}ms`);
  }

  if (chatTimes.length > 0) {
    console.log('  Chat response latency:');
    console.log(`    min=${min(chatTimes)}ms  avg=${avg(chatTimes)}ms  max=${max(chatTimes)}ms  p50=${p50(chatTimes)}ms`);
  }

  console.log('');

  // Structured JSON output
  console.log('=== Structured Results (JSON) ===');
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    config: { clients: N, port: PORT, jwt: !!JWT_SECRET, timeoutMs: TIMEOUT },
    results: results.map(r => ({
      clientId: r.clientId,
      status: r.status,
      connectMs: r.connectMs,
      firstResponseMs: r.firstResponseMs,
      chatResponseMs: r.chatResponseMs,
      busyRejected: r.busyRejected,
      resultLen: r.resultLen,
      error: r.error
    })),
    summary: {
      total: N,
      ok: okResults.length,
      busyRejected: busyResults.length,
      errors: errorResults.length,
      overallMs,
      latency: {
        connect: { min: min(connectTimes), avg: avg(connectTimes), max: max(connectTimes), p50: p50(connectTimes) },
        greeting: { min: min(greetingTimes), avg: avg(greetingTimes), max: max(greetingTimes), p50: p50(greetingTimes) },
        chat: { min: min(chatTimes), avg: avg(chatTimes), max: max(chatTimes), p50: p50(chatTimes) }
      }
    }
  }, null, 2));

  // Exit code: 0 if at least 1 client succeeded
  process.exit(okResults.length > 0 ? 0 : 1);
}

main().catch(e => {
  console.error(`Fatal error: ${e.message}`);
  process.exit(1);
});
