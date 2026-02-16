#!/usr/bin/env node
'use strict';
// Имитация поведения Module.bsl — тест полного цикла bridge.js
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:3003');
let sessionId = '';
let currentText = '';
let busy = false;

function log(msg) { console.log('[' + new Date().toISOString().slice(11,19) + '] ' + msg); }

ws.on('open', () => {
  log('WS connected. Waiting for session...');
  busy = false;
});

ws.on('message', (data) => {
  const raw = data.toString();
  let obj;
  try { obj = JSON.parse(raw); } catch(e) { log('RAW: ' + raw.slice(0,100)); return; }

  const type = obj.type;

  if (type === 'session') {
    sessionId = obj.sessionId;
    log('SESSION: ' + sessionId.slice(0,8) + '...');

    // Ждём system init, потом отправляем сообщение
    setTimeout(() => {
      log('--- Sending chat: "Привет! Скажи одно слово." ---');
      ws.send(JSON.stringify({type:'chat', content:'Привет! Скажи одно слово.'}));
      currentText = '';
      busy = true;
    }, 3000);

  } else if (type === 'system') {
    log('SYSTEM: Claude CLI ready');

  } else if (type === 'stream_event') {
    const evt = obj.event;
    if (evt && evt.type === 'content_block_delta' && evt.delta && evt.delta.text) {
      currentText += evt.delta.text;
      log('STREAM_DELTA: "' + currentText + '"');
    } else if (evt) {
      log('STREAM_EVENT: ' + evt.type);
    }

  } else if (type === 'assistant') {
    const content = obj.message && obj.message.content;
    if (content) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          currentText = block.text;
          log('ASSISTANT_TEXT: "' + currentText + '"');
        }
      }
    }

  } else if (type === 'result') {
    log('RESULT: "' + obj.result + '" (cost: $' + (obj.total_cost_usd||0).toFixed(4) + ')');
    busy = false;
    currentText = '';
    log('=== TEST PASSED ===');
    ws.close();

  } else if (type === 'error') {
    log('ERROR: reason=' + obj.reason + ' message=' + obj.message);
    if (obj.reason !== 'busy') busy = false;

  } else if (type === 'claude_exit') {
    log('CLAUDE_EXIT: code=' + obj.code);
    busy = false;

  } else {
    log('UNKNOWN_TYPE: ' + type);
  }
});

ws.on('error', (err) => { log('WS ERROR: ' + err.message); process.exit(1); });
ws.on('close', () => { log('WS closed'); process.exit(0); });
setTimeout(() => { log('TIMEOUT 60s'); ws.close(); }, 60000);
