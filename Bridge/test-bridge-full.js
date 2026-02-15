#!/usr/bin/env node
'use strict';

// Полный тест bridge.js — эмулируем 1С-клиент
// Не ждём init — отправляем с задержкой (Claude буферизует stdin)

const WebSocket = require('ws');
const BRIDGE_URL = 'ws://localhost:3003';

let savedSessionId = null;
const results = [];

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}
function pass(name) { results.push({ name, ok: true }); log(`  ✅ ${name}`); }
function fail(name, reason) { results.push({ name, ok: false, reason }); log(`  ❌ ${name}: ${reason}`); }

// Подключение к bridge с обработкой всех типов событий
function connect(url) {
  const ws = new WebSocket(url);
  const state = {
    ws,
    sessionId: null,
    deltas: '',
    resultText: '',
    gotInit: false,
    gotResult: false,
    mcpRequests: [],    // полученные mcp_request
  };

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'session') {
        state.sessionId = msg.sessionId;
      } else if (msg.type === 'system' && msg.subtype === 'init') {
        state.gotInit = true;
      } else if (msg.type === 'stream_event' && msg.event?.delta?.text) {
        state.deltas += msg.event.delta.text;
      } else if (msg.type === 'result') {
        state.gotResult = true;
        state.resultText = msg.result || '';
      } else if (msg.type === 'mcp_request') {
        state.mcpRequests.push(msg);
      }
    } catch (e) {}
  });

  return state;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForResult(state, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (state.gotResult) {
        clearInterval(check);
        resolve(true);
      }
    }, 500);
    setTimeout(() => { clearInterval(check); resolve(false); }, timeoutMs);
  });
}

function waitForMcp(state, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (state.mcpRequests.length > 0) {
        clearInterval(check);
        resolve(true);
      }
    }, 500);
    setTimeout(() => { clearInterval(check); resolve(false); }, timeoutMs);
  });
}

// ══════════════════════════════════════════════════════════════
//  ТЕСТ 1: Базовый чат
// ══════════════════════════════════════════════════════════════
async function test1_chat() {
  log('═══ ТЕСТ 1: Базовый чат ═══');
  const s = connect(BRIDGE_URL);

  await wait(1000);
  log(`session: ${s.sessionId}`);
  savedSessionId = s.sessionId;

  // Ждём 15 сек на инициализацию, потом шлём
  log('waiting 15s for Claude init...');
  await wait(15000);

  log('sending: "столица России? одно слово"');
  s.ws.send(JSON.stringify({ type: 'chat', content: 'Столица России? Ответь одним словом.' }));

  const got = await waitForResult(s, 120000);

  s.sessionId ? pass('Session ID получен') : fail('Session ID', 'empty');
  s.deltas.length > 0 ? pass(`Стриминг: "${s.deltas}"`) : fail('Стриминг', 'no deltas');
  got ? pass(`Result: "${s.resultText}"`) : fail('Result', 'timeout');

  // НЕ закрываем ws — Claude остаётся для следующих тестов
  log(`Claude pid alive, session ${s.sessionId}`);
  return s;
}

// ══════════════════════════════════════════════════════════════
//  ТЕСТ 2: MCP — Claude вызывает 1c_eval, "1С" отвечает
// ══════════════════════════════════════════════════════════════
async function test2_mcp(s) {
  log('═══ ТЕСТ 2: MCP-инструменты ═══');

  // Сбрасываем состояние для нового вопроса
  s.deltas = '';
  s.resultText = '';
  s.gotResult = false;
  s.mcpRequests = [];

  log('sending: "вычисли Строка(ТекущаяДата()) через 1c_eval"');
  s.ws.send(JSON.stringify({
    type: 'chat',
    content: 'Вызови инструмент 1c_eval с выражением Строка(ТекущаяДата()) и покажи результат.'
  }));

  // Ждём MCP-запрос от Claude
  log('waiting for MCP request from Claude...');
  const gotMcp = await waitForMcp(s, 120000);

  if (gotMcp) {
    const req = s.mcpRequests[0];
    pass(`MCP-запрос получен: tool=${req.tool}`);
    log(`  params: ${JSON.stringify(req.params)}`);

    // Отвечаем как 1С
    const fakeResult = '08.02.2026';
    log(`sending mcp_response: "${fakeResult}"`);
    s.ws.send(JSON.stringify({
      type: 'mcp_response',
      requestId: req.requestId,
      result: fakeResult
    }));

    // Ждём финальный ответ Claude
    const gotResult = await waitForResult(s, 60000);
    gotResult ? pass(`Result: "${s.resultText.slice(0, 100)}"`) : fail('Result после MCP', 'timeout');
    (s.deltas.includes('2026') || s.deltas.includes('08') || s.resultText.includes('2026') || s.resultText.includes('08'))
      ? pass('Claude использовал данные от "1С"')
      : fail('Данные от 1С в ответе', `"${s.deltas.slice(0, 80)}"`);
  } else {
    fail('MCP-запрос', 'Claude не вызвал инструмент за 120с');
    fail('Result после MCP', 'skipped');
    fail('Данные от 1С', 'skipped');
  }

  return s;
}

// ══════════════════════════════════════════════════════════════
//  ТЕСТ 3: Переподключение
// ══════════════════════════════════════════════════════════════
async function test3_reconnect(oldState) {
  log('═══ ТЕСТ 3: Переподключение ═══');

  // Закрываем старое соединение
  oldState.ws.close();
  await wait(2000);

  // Переподключаемся с тем же session ID
  log(`reconnecting to session: ${savedSessionId}`);
  const s = connect(`${BRIDGE_URL}/?session=${savedSessionId}`);

  await wait(2000);
  const sameSession = s.sessionId === savedSessionId;
  sameSession ? pass(`Session ID совпал: ${s.sessionId}`) : fail('Session ID', `got ${s.sessionId}`);

  // Шлём сообщение — Claude уже работает
  log('sending: "скажи работает"');
  s.ws.send(JSON.stringify({ type: 'chat', content: 'Скажи "работает"' }));

  const got = await waitForResult(s, 60000);
  got ? pass(`Ответ: "${s.resultText}"`) : fail('Ответ', 'timeout');

  s.ws.close();
}

// ══════════════════════════════════════════════════════════════
async function main() {
  log('╔══════════════════════════════════════╗');
  log('║   ПОЛНЫЙ ТЕСТ BRIDGE.JS v2          ║');
  log('╚══════════════════════════════════════╝\n');

  const s1 = await test1_chat();
  console.log();

  const s2 = await test2_mcp(s1);
  console.log();

  await test3_reconnect(s2);
  console.log();

  // Итоги
  log('═══ ИТОГИ ═══');
  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}${r.reason ? ` — ${r.reason}` : ''}`);
  }
  console.log(`\n  ${passed}/${total} passed`);
  process.exit(passed === total ? 0 : 1);
}

main();
