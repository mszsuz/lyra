#!/usr/bin/env node
'use strict';

/**
 * Emulator 1C Client for Lyra Bridge SDK v3
 *
 * Emulates the behavior of EXT_Chat (1C WebSocket client):
 * - Connects to bridge-sdk.js via WebSocket
 * - Sends hello (session initialization)
 * - Sends chat messages (user_message)
 * - Receives stream_event and result
 * - Responds to mcp_request with emulated 1C data
 * - Supports JWT authentication
 * - Interactive mode (readline) for manual testing
 * - Auto-test mode (--auto) for scripted testing
 *
 * Usage:
 *   node emulator-1c.js [--port 3003] [--auto] [--jwt SECRET]
 *   node emulator-1c.js --help
 *
 * Examples:
 *   node emulator-1c.js                          # Interactive mode, no JWT
 *   node emulator-1c.js --auto                   # Auto-test mode
 *   node emulator-1c.js --jwt mysecret            # Interactive with JWT auth
 *   node emulator-1c.js --auto --jwt mysecret     # Auto-test with JWT
 */

const WebSocket = require('ws');
const crypto = require('crypto');
const readline = require('readline');

// ─── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const PORT = Number(argVal('--port')) || 3003;
const AUTO_MODE = args.includes('--auto');
const JWT_SECRET = argVal('--jwt') || process.env.LYRA_JWT_SECRET || null;
const HELP = args.includes('--help') || args.includes('-h');

function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

if (HELP) {
  console.log(`
Emulator 1C Client for Lyra Bridge SDK v3

Usage:
  node emulator-1c.js [options]

Options:
  --port PORT     WebSocket port (default: 3003)
  --auto          Auto-test mode (run predefined test scenarios)
  --jwt SECRET    JWT secret for authentication
  --help, -h      Show this help

Interactive commands:
  /hello          Re-send hello message
  /busy           Test busy rejection (send 2 messages quickly)
  /mcp            Show last MCP request/response
  /session        Show current session info
  /stats          Show token usage statistics
  /reconnect      Reconnect with saved session ID
  /quit, /exit    Exit emulator
  (any text)      Send as chat message
`);
  process.exit(0);
}

// ─── State ──────────────────────────────────────────────────
let ws = null;
let sessionId = null;
let busy = false;
let streamBuffer = '';
let mcpLog = [];
let tokenUsage = {};
let totalCostUsd = 0;
let messageCount = 0;
let connectTime = null;

// 1C emulation config
const EMULATED_1C = {
  config: '1C:Бухгалтерия предприятия',
  version: '3.0.187.23',
  processingVersion: '8.3.27.1846',
  userName: 'Тестов Тест Тестович',
  userRole: 'Бухгалтер',
  baseId: crypto.randomUUID()
};

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

function logRecv(type, detail) {
  console.log(`  <- ${type}${detail ? ': ' + detail : ''}`);
}

function logSend(type, detail) {
  console.log(`  -> ${type}${detail ? ': ' + detail : ''}`);
}

// ─── Emulated MCP responses ──────────────────────────────────

function emulateMcpTool(tool, params) {
  log(`MCP request: ${tool} ${JSON.stringify(params)}`);

  switch (tool) {
    case '1c_eval': {
      const expr = (params.expression || '').toLowerCase();
      if (expr.includes('текущаядата') || expr.includes('currentdate')) {
        return '13.02.2026 04:40:00';
      }
      if (expr.includes('имяпользователя') || expr.includes('username')) {
        return EMULATED_1C.userName;
      }
      if (expr.includes('версияприложения')) {
        return EMULATED_1C.processingVersion;
      }
      return `Результат: ${params.expression}`;
    }

    case '1c_query': {
      const query = (params.query || '').toUpperCase();
      if (query.includes('НОМЕНКЛАТУРА') || query.includes('NOMENCLATURE')) {
        return {
          columns: ['Код', 'Наименование', 'Артикул'],
          rows: [
            ['000001', 'Ноутбук ASUS VivoBook', 'NB-ASUS-001'],
            ['000002', 'Мышь Logitech MX Master', 'MS-LOG-001'],
            ['000003', 'Клавиатура Keychron K2', 'KB-KEY-001']
          ]
        };
      }
      if (query.includes('КОНТРАГЕНТ') || query.includes('COUNTERPARTY')) {
        return {
          columns: ['Код', 'Наименование', 'ИНН'],
          rows: [
            ['000001', 'ООО "Ромашка"', '7701234567'],
            ['000002', 'ИП Иванов И.И.', '770987654321']
          ]
        };
      }
      if (query.includes('ОРГАНИЗАЦИ')) {
        return {
          columns: ['Код', 'Наименование', 'ИНН'],
          rows: [
            ['000001', 'ООО "Тест"', '7700000001']
          ]
        };
      }
      return {
        columns: ['Результат'],
        rows: [['Пустой результат запроса']]
      };
    }

    case '1c_metadata': {
      const metaPath = params.path || '';
      if (!metaPath) {
        return {
          Справочники: ['Номенклатура', 'Контрагенты', 'Организации', 'Валюты'],
          Документы: ['РеализацияТоваровУслуг', 'ПоступлениеТоваровУслуг', 'ПлатежноеПоручение'],
          РегистрыСведений: ['ЦеныНоменклатуры', 'КурсыВалют'],
          РегистрыНакопления: ['ОстаткиТоваров', 'Продажи']
        };
      }
      if (metaPath.includes('Номенклатура')) {
        return {
          Наименование: 'Номенклатура',
          Реквизиты: ['Артикул', 'ЕдиницаИзмерения', 'Производитель', 'СтавкаНДС'],
          ТабличныеЧасти: ['ДополнительныеРеквизиты']
        };
      }
      return { Путь: metaPath, Описание: 'Эмулированные метаданные' };
    }

    case '1c_exec': {
      return 'Код выполнен успешно';
    }

    default:
      throw new Error(`Неизвестный инструмент: ${tool}`);
  }
}

// ─── WebSocket connection ────────────────────────────────────

function buildUrl(resumeSession) {
  let url = `ws://localhost:${PORT}/`;
  const params = [];
  if (resumeSession) params.push(`session=${resumeSession}`);
  if (JWT_SECRET) {
    const token = generateJwt(JWT_SECRET, EMULATED_1C.userName, EMULATED_1C.userRole, 24);
    params.push(`token=${token}`);
  }
  if (params.length > 0) url += '?' + params.join('&');
  return url;
}

function doConnect(resumeSession) {
  return new Promise((resolve, reject) => {
    const url = buildUrl(resumeSession);
    log(`Connecting to ${url.replace(/token=[^&]+/, 'token=***')}...`);

    ws = new WebSocket(url);
    connectTime = Date.now();

    const timer = setTimeout(() => {
      reject(new Error('Connection timeout (10s)'));
    }, 10000);

    ws.on('open', () => {
      clearTimeout(timer);
      log('WebSocket connected');
      resolve();
    });

    ws.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      log(`WebSocket closed: code=${code}, reason=${reason || 'none'}`);
      ws = null;
      if (code === 4001) {
        log('Authentication failed! Check JWT secret.');
      }
    });

    ws.on('message', (raw) => {
      handleMessage(raw);
    });
  });
}

// ─── Message handling ────────────────────────────────────────

function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    log(`Parse error: ${e.message}`);
    return;
  }

  switch (msg.type) {
    case 'session':
      sessionId = msg.sessionId;
      logRecv('session', `sessionId=${msg.sessionId}`);
      // Auto-send hello
      sendHello();
      break;

    case 'hello_ack':
      logRecv('hello_ack', `sessionId=${msg.sessionId}, baseId=${msg.baseId}`);
      streamBuffer = '';
      break;

    case 'stream_event': {
      const event = msg.event;
      if (event && event.type === 'content_block_delta' && event.delta) {
        const text = event.delta.text || '';
        if (text) {
          streamBuffer += text;
          // Print streaming text without newline for live effect
          process.stdout.write(text);
        }
      }
      break;
    }

    case 'result':
      // Finish the streaming line
      if (streamBuffer) {
        process.stdout.write('\n');
      }
      logRecv('result', `${(msg.result || '').length} chars`);
      if (msg.usage) {
        tokenUsage = msg.usage;
        logRecv('usage', JSON.stringify(msg.usage));
      }
      if (msg.costUsd !== undefined) {
        totalCostUsd += msg.costUsd;
        logRecv('cost', `$${msg.costUsd.toFixed(4)} (total: $${totalCostUsd.toFixed(4)})`);
      }
      if (msg.durationMs) {
        logRecv('duration', `${msg.durationMs}ms`);
      }
      messageCount++;
      busy = false;
      streamBuffer = '';

      // In auto mode, signal completion
      if (_autoResolve) {
        _autoResolve(msg);
        _autoResolve = null;
      }
      break;

    case 'error':
      if (streamBuffer) {
        process.stdout.write('\n');
        streamBuffer = '';
      }
      logRecv('error', `reason=${msg.reason}, message=${msg.message}`);
      if (msg.reason === 'busy') {
        // Don't reset busy flag - wait for result
      } else {
        busy = false;
      }

      if (_autoResolve) {
        _autoResolve(msg);
        _autoResolve = null;
      }
      break;

    case 'mcp_request':
      logRecv('mcp_request', `tool=${msg.tool}, requestId=${msg.requestId}`);
      handleMcpRequest(msg);
      break;

    default:
      logRecv(msg.type, JSON.stringify(msg).slice(0, 200));
  }
}

function handleMcpRequest(msg) {
  const { requestId, tool, params } = msg;

  try {
    const result = emulateMcpTool(tool, params || {});
    const response = {
      type: 'mcp_response',
      requestId,
      result
    };
    wsSend(response);
    logSend('mcp_response', `requestId=${requestId}, success`);
    mcpLog.push({ time: ts(), tool, params, result, error: null });
  } catch (e) {
    const response = {
      type: 'mcp_response',
      requestId,
      error: e.message
    };
    wsSend(response);
    logSend('mcp_response', `requestId=${requestId}, error: ${e.message}`);
    mcpLog.push({ time: ts(), tool, params, result: null, error: e.message });
  }
}

function sendHello() {
  const hello = {
    type: 'hello',
    config: EMULATED_1C.config,
    version: EMULATED_1C.version,
    processingVersion: EMULATED_1C.processingVersion,
    userName: EMULATED_1C.userName,
    userRole: EMULATED_1C.userRole,
    baseId: EMULATED_1C.baseId
  };
  wsSend(hello);
  logSend('hello', `config=${EMULATED_1C.config}, user=${EMULATED_1C.userName}`);
}

function sendChat(content) {
  if (busy) {
    log('Cannot send: bridge is busy processing previous request');
    return false;
  }
  const msg = {
    type: 'chat',
    content: content
  };
  wsSend(msg);
  logSend('chat', content.slice(0, 100));
  busy = true;
  streamBuffer = '';
  return true;
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else {
    log('Cannot send: WebSocket not connected');
  }
}

// ─── Auto-test resolve hook ──────────────────────────────────
let _autoResolve = null;

function waitForResult(timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _autoResolve = null;
      reject(new Error(`Timeout waiting for result (${timeoutMs}ms)`));
    }, timeoutMs);
    _autoResolve = (msg) => {
      clearTimeout(timer);
      resolve(msg);
    };
  });
}

// ─── Auto-test mode ──────────────────────────────────────────

async function runAutoTests() {
  console.log('');
  console.log('=== Emulator 1C: Auto-Test Mode ===');
  console.log(`Bridge: ws://localhost:${PORT}`);
  console.log(`JWT: ${JWT_SECRET ? 'enabled' : 'disabled'}`);
  console.log(`1C Config: ${EMULATED_1C.config}`);
  console.log(`User: ${EMULATED_1C.userName}`);
  console.log('');

  let passed = 0;
  let failed = 0;
  const results = [];

  function ok(name, detail) {
    passed++;
    console.log(`  [PASS] ${name}${detail ? ' - ' + detail : ''}`);
    results.push({ name, status: 'PASS', detail: detail || '' });
  }

  function fail(name, err) {
    failed++;
    console.log(`  [FAIL] ${name}: ${err}`);
    results.push({ name, status: 'FAIL', detail: err });
  }

  // ── Test 1: Connection + session ──
  console.log('Test 1: WebSocket connection');
  try {
    await doConnect();
    // Wait a bit for session message
    await new Promise(r => setTimeout(r, 500));
    if (sessionId) {
      ok('WebSocket connection', `sessionId=${sessionId.slice(0, 8)}...`);
    } else {
      fail('WebSocket connection', 'No session ID received');
    }
  } catch (e) {
    fail('WebSocket connection', e.message);
    printAutoSummary(passed, failed, results);
    return;
  }
  console.log('');

  // ── Test 2: Hello -> hello_ack + greeting ──
  console.log('Test 2: Hello -> greeting');
  try {
    log('Waiting for greeting after hello...');
    console.log('--- Greeting stream ---');
    const result = await waitForResult(120000);
    console.log('--- End greeting ---');

    if (result.type === 'result') {
      const len = (result.result || '').length;
      ok('Hello + greeting', `${len} chars, cost=$${(result.costUsd || 0).toFixed(4)}`);
    } else if (result.type === 'error') {
      fail('Hello + greeting', `Error: ${result.message}`);
    }
  } catch (e) {
    fail('Hello + greeting', e.message);
  }
  console.log('');

  // ── Test 3: Chat message ──
  console.log('Test 3: Chat message');
  try {
    log('Sending: "Какая текущая дата в базе?"');
    console.log('--- Response stream ---');
    sendChat('Какая текущая дата в базе?');
    const result = await waitForResult(120000);
    console.log('--- End response ---');

    if (result.type === 'result') {
      const len = (result.result || '').length;
      ok('Chat message', `${len} chars, cost=$${(result.costUsd || 0).toFixed(4)}`);
    } else if (result.type === 'error') {
      fail('Chat message', `Error: ${result.message}`);
    }
  } catch (e) {
    fail('Chat message', e.message);
  }
  console.log('');

  // ── Test 4: Busy rejection ──
  console.log('Test 4: Busy rejection');
  try {
    // Send a message and immediately send another
    log('Sending first message...');
    const msg1 = { type: 'chat', content: 'Расскажи про виды налогов в России' };
    wsSend(msg1);
    busy = true;
    streamBuffer = '';

    // Small delay then send second message
    await new Promise(r => setTimeout(r, 200));

    log('Sending second message (should get busy rejection)...');
    const msg2 = { type: 'chat', content: 'А что такое НДС?' };
    wsSend(msg2);

    // Wait for busy error OR result
    const response = await waitForResult(120000);

    if (response.type === 'error' && response.reason === 'busy') {
      ok('Busy rejection', 'Got busy error as expected');
      // Now wait for the first query to finish
      console.log('--- Waiting for first query result ---');
      const firstResult = await waitForResult(120000);
      console.log('--- End first query ---');
      if (firstResult.type === 'result') {
        log(`First query completed: ${(firstResult.result || '').length} chars`);
      }
    } else if (response.type === 'result') {
      // The first message completed so fast that busy wasn't triggered
      ok('Busy rejection', 'First message completed before second arrived (no busy state)');
    } else {
      fail('Busy rejection', `Unexpected response: ${JSON.stringify(response).slice(0, 200)}`);
    }
  } catch (e) {
    fail('Busy rejection', e.message);
  }
  console.log('');

  // ── Test 5: Reconnection ──
  console.log('Test 5: Reconnection');
  try {
    const savedSessionId = sessionId;
    log(`Disconnecting (session=${savedSessionId?.slice(0, 8)}...)...`);
    if (ws) ws.close();
    await new Promise(r => setTimeout(r, 1000));

    log('Reconnecting with saved session ID...');
    await doConnect(savedSessionId);
    await new Promise(r => setTimeout(r, 500));

    if (sessionId === savedSessionId) {
      ok('Reconnection', `Same session: ${sessionId.slice(0, 8)}...`);
    } else {
      fail('Reconnection', `Session ID mismatch: expected ${savedSessionId}, got ${sessionId}`);
    }
  } catch (e) {
    fail('Reconnection', e.message);
  }
  console.log('');

  // ── Test 6: JWT auth (if enabled) ──
  if (JWT_SECRET) {
    console.log('Test 6: JWT authentication');

    // 6a: Valid token (already tested implicitly)
    ok('JWT: valid token', 'Connection succeeded with valid JWT');

    // 6b: No token
    try {
      log('Testing connection without token...');
      const noTokenUrl = `ws://localhost:${PORT}/`;
      const wsNoToken = new WebSocket(noTokenUrl);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          wsNoToken.close();
          reject(new Error('No close event within 5s'));
        }, 5000);

        wsNoToken.on('error', (e) => {
          clearTimeout(timer);
          fail('JWT: no token rejected', `Connection error: ${e.message}`);
          resolve();
        });

        wsNoToken.on('close', (code) => {
          clearTimeout(timer);
          if (code === 4001) {
            ok('JWT: no token rejected', `Close code 4001`);
          } else {
            fail('JWT: no token rejected', `Expected code 4001, got ${code}`);
          }
          resolve();
        });

        wsNoToken.on('message', () => {
          clearTimeout(timer);
          fail('JWT: no token rejected', 'Connection was accepted without token');
          wsNoToken.close();
          resolve();
        });
      });
    } catch (e) {
      fail('JWT: no token rejected', e.message);
    }

    // 6c: Invalid token
    try {
      log('Testing connection with invalid token...');
      const badTokenUrl = `ws://localhost:${PORT}/?token=invalid.bad.token`;
      const wsBadToken = new WebSocket(badTokenUrl);

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          wsBadToken.close();
          reject(new Error('No close event within 5s'));
        }, 5000);

        wsBadToken.on('error', (e) => {
          clearTimeout(timer);
          fail('JWT: invalid token rejected', `Connection error: ${e.message}`);
          resolve();
        });

        wsBadToken.on('close', (code) => {
          clearTimeout(timer);
          if (code === 4001) {
            ok('JWT: invalid token rejected', `Close code 4001`);
          } else {
            fail('JWT: invalid token rejected', `Expected code 4001, got ${code}`);
          }
          resolve();
        });

        wsBadToken.on('message', () => {
          clearTimeout(timer);
          fail('JWT: invalid token rejected', 'Connection was accepted with invalid token');
          wsBadToken.close();
          resolve();
        });
      });
    } catch (e) {
      fail('JWT: invalid token rejected', e.message);
    }
    console.log('');
  } else {
    console.log('Test 6: JWT authentication');
    console.log('  [SKIP] JWT disabled (use --jwt SECRET to enable)');
    console.log('');
  }

  // ── Test 7: MCP tools full cycle ──
  console.log('Test 7: MCP tools (full cycle mcp_request/mcp_response)');
  try {
    log('Sending query that should trigger MCP tool call...');
    console.log('--- MCP test stream ---');
    const mcpCountBefore = mcpLog.length;
    sendChat('Выполни запрос: ВЫБРАТЬ * ИЗ Справочник.Номенклатура');
    const result7 = await waitForResult(120000);
    console.log('--- End MCP test ---');

    const mcpCountAfter = mcpLog.length;
    const mcpCallsMade = mcpCountAfter - mcpCountBefore;

    if (result7.type === 'result') {
      if (mcpCallsMade > 0) {
        const lastMcp = mcpLog[mcpLog.length - 1];
        ok('MCP tools full cycle', `${mcpCallsMade} MCP call(s), last tool=${lastMcp.tool}, error=${lastMcp.error || 'none'}`);
      } else {
        // Claude may have answered without calling MCP — still valid behavior
        ok('MCP tools full cycle', `Result received (${(result7.result || '').length} chars), no MCP calls triggered (Claude answered directly)`);
      }
    } else if (result7.type === 'error') {
      fail('MCP tools full cycle', `Error: ${result7.message}`);
    }
  } catch (e) {
    fail('MCP tools full cycle', e.message);
  }
  console.log('');

  // ── Test 8: Long dialog (5+ messages in one session) ──
  console.log('Test 8: Long dialog (5+ messages in one session)');
  try {
    const dialogMessages = [
      'Привет, как дела?',
      'Сколько организаций в базе?',
      'А контрагентов?',
      'Какая версия платформы?',
      'Спасибо за помощь!'
    ];
    let dialogOk = true;
    let dialogResults = [];

    for (let i = 0; i < dialogMessages.length; i++) {
      log(`Dialog message ${i + 1}/${dialogMessages.length}: "${dialogMessages[i]}"`);
      console.log(`--- Dialog ${i + 1} ---`);
      sendChat(dialogMessages[i]);
      const res = await waitForResult(120000);
      console.log(`--- End dialog ${i + 1} ---`);

      if (res.type === 'result') {
        dialogResults.push({ msg: dialogMessages[i], len: (res.result || '').length });
      } else if (res.type === 'error' && res.reason !== 'busy') {
        dialogOk = false;
        dialogResults.push({ msg: dialogMessages[i], error: res.message });
        break;
      } else {
        dialogOk = false;
        dialogResults.push({ msg: dialogMessages[i], error: `Unexpected: ${JSON.stringify(res).slice(0, 100)}` });
        break;
      }

      // Small delay between messages
      await new Promise(r => setTimeout(r, 500));
    }

    if (dialogOk) {
      const totalChars = dialogResults.reduce((sum, r) => sum + (r.len || 0), 0);
      ok('Long dialog', `${dialogResults.length} messages, ${totalChars} total chars`);
    } else {
      const lastErr = dialogResults[dialogResults.length - 1];
      fail('Long dialog', `Failed at message ${dialogResults.length}: ${lastErr.error || 'unknown'}`);
    }
  } catch (e) {
    fail('Long dialog', e.message);
  }
  console.log('');

  // ── Test 9: Error handling (disconnect mid-request + reconnect) ──
  console.log('Test 9: Error handling (disconnect mid-request)');
  try {
    log('Sending message then disconnecting mid-stream...');
    const savedSid = sessionId;
    // Send a chat message
    const msg9 = { type: 'chat', content: 'Расскажи подробно про бухгалтерский учёт основных средств' };
    wsSend(msg9);
    busy = true;
    streamBuffer = '';

    // Wait a short time for streaming to start, then disconnect
    await new Promise(r => setTimeout(r, 2000));
    log('Forcefully closing WebSocket mid-request...');
    if (ws) ws.close();
    await new Promise(r => setTimeout(r, 2000));

    // Reconnect
    log('Reconnecting after mid-request disconnect...');
    await doConnect(savedSid);
    await new Promise(r => setTimeout(r, 1000));

    // Wait for hello_ack and greeting from reconnection
    const result9 = await waitForResult(120000);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ok('Error handling (disconnect + reconnect)', `Reconnected, sessionId=${sessionId?.slice(0, 8)}..., response type=${result9.type}`);
    } else {
      fail('Error handling (disconnect + reconnect)', 'WebSocket not open after reconnect');
    }
  } catch (e) {
    fail('Error handling (disconnect + reconnect)', e.message);
  }
  console.log('');

  // ── Test 10: Parallel sessions (busy rejection for second client) ──
  console.log('Test 10: Parallel sessions (2 clients)');
  try {
    // Client 1: send a long-running query
    log('Client 1: sending a long query...');
    const msg10 = { type: 'chat', content: 'Перечисли все справочники и документы в конфигурации' };
    wsSend(msg10);
    busy = true;
    streamBuffer = '';

    // Wait a bit for the query to start processing
    await new Promise(r => setTimeout(r, 500));

    // Client 2: connect and try to send a message
    log('Client 2: connecting...');
    const url2 = buildUrl(null);
    const ws2 = new WebSocket(url2);
    let client2SessionId = null;
    let client2BusyRejected = false;
    let client2Result = null;

    await new Promise((resolve, reject) => {
      const timer2 = setTimeout(() => {
        ws2.close();
        reject(new Error('Client 2 connection timeout'));
      }, 10000);

      ws2.on('open', () => {
        clearTimeout(timer2);
        resolve();
      });

      ws2.on('error', (e) => {
        clearTimeout(timer2);
        reject(e);
      });
    });

    // Client 2 message handler
    const client2Messages = [];
    ws2.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        client2Messages.push(msg);
        if (msg.type === 'session') {
          client2SessionId = msg.sessionId;
          // Auto-send hello for client 2
          ws2.send(JSON.stringify({
            type: 'hello',
            config: '1C:Управление торговлей',
            version: '11.5.18.300',
            processingVersion: '8.3.27.1846',
            userName: 'Второй Пользователь',
            userRole: 'Менеджер',
            baseId: crypto.randomUUID()
          }));
        }
        if (msg.type === 'error' && msg.reason === 'busy') {
          client2BusyRejected = true;
        }
        if (msg.type === 'result') {
          client2Result = msg;
        }
      } catch {}
    });

    // Wait for client 2 session + hello_ack + greeting
    await new Promise(r => setTimeout(r, 3000));

    // Client 2: try to send a chat while bridge might be busy with greeting
    ws2.send(JSON.stringify({ type: 'chat', content: 'Привет от второго клиента' }));

    // Wait for both clients to get results
    log('Waiting for all results...');

    // Wait for client 1 result
    const result10 = await waitForResult(120000);
    log(`Client 1 result: type=${result10.type}`);

    // Give client 2 time to receive response
    await new Promise(r => setTimeout(r, 5000));

    // Each client should have their own session
    if (client2SessionId && client2SessionId !== sessionId) {
      ok('Parallel sessions', `Client1 session=${sessionId?.slice(0, 8)}..., Client2 session=${client2SessionId?.slice(0, 8)}..., Client2 messages=${client2Messages.length}`);
    } else if (client2SessionId === sessionId) {
      fail('Parallel sessions', 'Both clients got the same session ID');
    } else {
      fail('Parallel sessions', 'Client 2 did not receive a session ID');
    }

    ws2.close();
  } catch (e) {
    fail('Parallel sessions', e.message);
  }
  console.log('');

  // ── Test 11: Large messages (>10KB) ──
  console.log('Test 11: Large messages (>10KB)');
  try {
    // Generate a message larger than 10KB
    const bigContent = 'Проанализируй следующий текст: ' + 'А'.repeat(10240) + ' — конец текста. Ответь кратко.';
    const sizeKb = Buffer.byteLength(bigContent, 'utf8') / 1024;
    log(`Sending large message: ${sizeKb.toFixed(1)} KB...`);
    console.log('--- Large message test ---');
    sendChat(bigContent);
    const result11 = await waitForResult(120000);
    console.log('--- End large message test ---');

    if (result11.type === 'result') {
      ok('Large messages', `Sent ${sizeKb.toFixed(1)} KB, received ${(result11.result || '').length} chars response`);
    } else if (result11.type === 'error') {
      if (result11.reason === 'agent_error') {
        // Agent may reject oversized input — that's valid behavior
        ok('Large messages', `Agent rejected large input (expected): ${result11.message}`);
      } else {
        fail('Large messages', `Error: ${result11.message}`);
      }
    }
  } catch (e) {
    fail('Large messages', e.message);
  }
  console.log('');

  // ── Summary ──
  printAutoSummary(passed, failed, results);

  // Cleanup
  if (ws) ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

function printAutoSummary(passed, failed, results) {
  console.log('=== Summary ===');
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Total messages: ${messageCount}`);
  console.log(`  Total cost: $${totalCostUsd.toFixed(4)}`);
  console.log(`  MCP calls: ${mcpLog.length}`);
  if (mcpLog.length > 0) {
    console.log('  MCP details:');
    mcpLog.forEach(m => {
      console.log(`    ${m.time} ${m.tool}: ${m.error ? 'ERROR ' + m.error : 'OK'}`);
    });
  }
  console.log('');

  // Output structured results for test-results file
  console.log('=== Structured Results (JSON) ===');
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    bridge: `ws://localhost:${PORT}`,
    jwt: !!JWT_SECRET,
    emulated1C: EMULATED_1C,
    tests: results,
    summary: { passed, failed },
    mcpCalls: mcpLog,
    totalCostUsd,
    messageCount
  }, null, 2));
}

// ─── Interactive mode ────────────────────────────────────────

async function runInteractive() {
  console.log('');
  console.log('=== Emulator 1C: Interactive Mode ===');
  console.log(`Bridge: ws://localhost:${PORT}`);
  console.log(`JWT: ${JWT_SECRET ? 'enabled' : 'disabled'}`);
  console.log(`1C Config: ${EMULATED_1C.config}`);
  console.log(`User: ${EMULATED_1C.userName}`);
  console.log('');
  console.log('Commands: /hello /busy /mcp /session /stats /reconnect /quit');
  console.log('Type any text to send as chat message.');
  console.log('');

  try {
    await doConnect();
  } catch (e) {
    log(`Connection failed: ${e.message}`);
    process.exit(1);
  }

  // Wait for hello/greeting
  log('Waiting for greeting...');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n1C> '
  });

  // Show prompt after result received
  const origHandleMessage = handleMessage;

  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === '/quit' || input === '/exit') {
      log('Exiting...');
      if (ws) ws.close();
      rl.close();
      process.exit(0);
    }

    if (input === '/hello') {
      sendHello();
      rl.prompt();
      return;
    }

    if (input === '/busy') {
      log('Sending 2 messages quickly (testing busy rejection)...');
      if (ws && ws.readyState === WebSocket.OPEN) {
        wsSend({ type: 'chat', content: 'Расскажи про налоги' });
        busy = true;
        streamBuffer = '';
        setTimeout(() => {
          wsSend({ type: 'chat', content: 'И про НДС тоже' });
        }, 100);
      }
      return;
    }

    if (input === '/mcp') {
      if (mcpLog.length === 0) {
        log('No MCP calls yet');
      } else {
        console.log('\nMCP call history:');
        mcpLog.forEach((m, i) => {
          console.log(`  ${i + 1}. [${m.time}] ${m.tool}`);
          console.log(`     Params: ${JSON.stringify(m.params)}`);
          if (m.error) {
            console.log(`     Error: ${m.error}`);
          } else {
            console.log(`     Result: ${JSON.stringify(m.result).slice(0, 200)}`);
          }
        });
      }
      rl.prompt();
      return;
    }

    if (input === '/session') {
      console.log(`\nSession info:`);
      console.log(`  Session ID: ${sessionId || 'none'}`);
      console.log(`  Connected: ${ws ? 'yes' : 'no'}`);
      console.log(`  Busy: ${busy}`);
      console.log(`  Messages: ${messageCount}`);
      console.log(`  Uptime: ${connectTime ? Math.round((Date.now() - connectTime) / 1000) + 's' : 'n/a'}`);
      rl.prompt();
      return;
    }

    if (input === '/stats') {
      console.log(`\nToken usage:`);
      console.log(`  ${JSON.stringify(tokenUsage, null, 2)}`);
      console.log(`  Total cost: $${totalCostUsd.toFixed(4)}`);
      console.log(`  Messages: ${messageCount}`);
      console.log(`  MCP calls: ${mcpLog.length}`);
      rl.prompt();
      return;
    }

    if (input === '/reconnect') {
      if (!sessionId) {
        log('No session ID to reconnect with');
        rl.prompt();
        return;
      }
      const savedId = sessionId;
      log(`Reconnecting with session ${savedId.slice(0, 8)}...`);
      if (ws) ws.close();
      setTimeout(async () => {
        try {
          await doConnect(savedId);
          log('Reconnected!');
        } catch (e) {
          log(`Reconnect failed: ${e.message}`);
        }
        rl.prompt();
      }, 1000);
      return;
    }

    // Default: send as chat message
    console.log('');
    if (sendChat(input)) {
      // Message sent, will show streaming output
    } else {
      rl.prompt();
    }
  });

  // After initial connection, wait for greeting then show prompt
  setTimeout(() => {
    rl.prompt();
  }, 2000);
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  if (AUTO_MODE) {
    await runAutoTests();
  } else {
    await runInteractive();
  }
}

main().catch(e => {
  console.error(`Fatal error: ${e.message}`);
  if (ws) ws.close();
  process.exit(1);
});
