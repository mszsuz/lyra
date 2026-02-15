#!/usr/bin/env node
'use strict';

/**
 * Test for BUG-2: subagent streaming
 * Sends a question that requires Task(analyst), checks if response is streamed
 */

const WebSocket = require('ws');

const PORT = 3003;
let ws = null;
let streamedChunks = [];
let hasSubagentStream = false;

function log(msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function wsSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

async function main() {
  log('Connecting to bridge...');
  ws = new WebSocket(`ws://localhost:${PORT}/`);

  ws.on('open', () => {
    log('Connected');
  });

  ws.on('error', (e) => {
    log(`WebSocket error: ${e.message}`);
  });

  ws.on('close', (code, reason) => {
    log(`WebSocket closed: code=${code}, reason=${reason || 'none'}`);
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);

    if (msg.type === 'session') {
      log('<- session');
      wsSend({
        type: 'hello',
        config: '1C:Test',
        userName: 'Test User',
        baseId: 'test-base-id'
      });
    }

    if (msg.type === 'hello_ack') {
      log('<- hello_ack');
    }

    if (msg.type === 'stream_event') {
      const event = msg.event;
      if (event && event.type === 'content_block_delta' && event.delta && event.delta.text) {
        const text = event.delta.text;
        streamedChunks.push(text);
        process.stdout.write(text); // Live streaming output
      }
    }

    if (msg.type === 'result') {
      log(`\n<- result: ${(msg.result || '').length} chars`);

      if (!questionAsked) {
        questionAsked = true;
        log('Sending question that requires analyst subagent...');
        wsSend({ type: 'chat', content: 'Какая текущая дата в базе?' });
      } else {
        // Answer received
        log(`Total streamed chunks: ${streamedChunks.length}`);
        log(`Total streamed text length: ${streamedChunks.join('').length}`);
        log(`Result length: ${(msg.result || '').length}`);

        if (streamedChunks.length > 0) {
          log('PASS: Text was streamed from subagent');
        } else {
          log('FAIL: No stream_event received (BUG-2 not fixed)');
        }

        ws.close();
        process.exit(streamedChunks.length > 0 ? 0 : 1);
      }
    }
  });
}

let questionAsked = false;
main().catch(e => {
  console.error(`Fatal error: ${e.message}`);
  process.exit(1);
});
