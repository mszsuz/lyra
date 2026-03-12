// HTTP endpoint for tool calls from tools-mcp.mjs
// Publishes tool_call to Centrifugo, waits for tool_result from Chat EPF

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import * as log from './log.mjs';

const TAG = 'tools';
const TOOL_CALL_TIMEOUT = 60_000;

export function createToolServer(sessionManager, centrifugo, profile) {
  const server = createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost`);

    // GET /tools — return tool definitions
    if (req.method === 'GET' && url.pathname === '/tools') {
      const tools = profile.clientTools || [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tools }));
      return;
    }

    // POST /tool-call — execute tool via Centrifugo → Chat EPF
    if (req.method === 'POST' && url.pathname === '/tool-call') {
      let body = '';
      for await (const chunk of req) body += chunk;

      let data;
      try {
        data = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const { tool, params, session_id } = data;
      if (!tool || !session_id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing tool or session_id' }));
        return;
      }

      const session = sessionManager.get(session_id);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      const requestId = randomUUID();
      log.info(TAG, `tool_call: ${tool} (${requestId}) → ${session.channel}`);

      // Publish tool_call to session channel
      try {
        await centrifugo.apiPublish(session.channel, {
          type: 'tool_call',
          request_id: requestId,
          tool,
          params: params || {},
        });
      } catch (err) {
        log.error(TAG, `Failed to publish tool_call: ${err.message}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to publish tool_call' }));
        return;
      }

      // Wait for tool_result from Chat EPF
      try {
        const result = await waitForToolResult(session, requestId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        log.error(TAG, `tool_call timeout/error: ${err.message}`);
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return server;
}

function waitForToolResult(session, requestId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pendingToolCalls.delete(requestId);
      reject(new Error(`Timeout waiting for tool_result (${TOOL_CALL_TIMEOUT}ms)`));
    }, TOOL_CALL_TIMEOUT);

    session.pendingToolCalls.set(requestId, { resolve, reject, timer });
  });
}

export function handleToolResult(session, data) {
  if (!data.request_id) return false;

  const pending = session.pendingToolCalls.get(data.request_id);
  if (!pending) return false;

  clearTimeout(pending.timer);
  session.pendingToolCalls.delete(data.request_id);

  log.info(TAG, `tool_result received: ${data.request_id}`);
  pending.resolve(data);
  return true;
}
