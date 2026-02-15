#!/usr/bin/env node
'use strict';

/**
 * Simple test for BUG-1: busy rejection crash
 * Sends hello, then two chat messages quickly to trigger busy error
 */

const WebSocket = require('ws');

const PORT = 3003;
let ws = null;
let busy = false;

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
    if (code === 1006) {
      log('FAIL: Bridge crashed (code 1006)');
      process.exit(1);
    }
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    log(`<- ${msg.type}`);

    if (msg.type === 'session') {
      // Send hello
      wsSend({
        type: 'hello',
        config: '1C:Test',
        userName: 'Test User',
        baseId: 'test-base-id'
      });
    }

    if (msg.type === 'hello_ack') {
      log('Waiting 1 sec for greeting to complete...');
    }

    if (msg.type === 'result') {
      busy = false;
      log(`Result received: ${(msg.result || '').length} chars`);

      if (!testStarted) {
        testStarted = true;
        // Now send 2 messages quickly to trigger busy
        log('Sending first message...');
        wsSend({ type: 'chat', content: 'Test message 1' });
        busy = true;

        setTimeout(() => {
          log('Sending second message (should get busy error)...');
          wsSend({ type: 'chat', content: 'Test message 2' });
        }, 100);

        // Wait 30 seconds — if bridge doesn't crash, test passes
        setTimeout(() => {
          log('PASS: Bridge did not crash after 30 seconds');
          ws.close();
          process.exit(0);
        }, 30000);
      }
    }

    if (msg.type === 'error') {
      log(`Error: ${msg.reason} - ${msg.message}`);
      if (msg.reason === 'busy') {
        log('Got busy rejection (expected)');
      }
    }
  });
}

let testStarted = false;
main().catch(e => {
  console.error(`Fatal error: ${e.message}`);
  process.exit(1);
});
