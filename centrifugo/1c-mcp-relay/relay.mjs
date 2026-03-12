#!/usr/bin/env node
// 1c-mcp-relay — MCP sidecar для клиентских инструментов 1С.
//
// Standalone MCP-сервер (stdio JSON-RPC). Запускается Claude CLI как дочерний процесс
// через --mcp-config. Сам отвечает на initialize/tools/list, проксирует tools/call
// через Centrifugo в канал сессии (tool_call → tool_result).
//
// Использование:
//   node relay.mjs --url ws://localhost:11000/connection/websocket \
//                  --token <JWT> --channel session:<id> --tools tools.json
//
// Зависимости: Node.js 22+ (встроенный WebSocket, без npm-пакетов)

import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

const WS_URL   = getArg('--url')     || die('--url required');
const TOKEN    = getArg('--token')   || die('--token required');
const CHANNEL  = getArg('--channel') || die('--channel required');
const TOOLS_PATH = getArg('--tools') || die('--tools required');

const TOOL_CALL_TIMEOUT = 60_000; // 60 сек — v8_query может быть долгим

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

let tools = [];
if (existsSync(TOOLS_PATH)) {
  const raw = readFileSync(TOOLS_PATH, 'utf-8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);
  tools = parsed.tools || parsed;
} else {
  die(`tools file not found: ${TOOLS_PATH}`);
}

// Конвертация Anthropic API format → MCP format (input_schema → inputSchema)
const mcpTools = tools.map(t => ({
  name: t.name,
  description: t.description,
  inputSchema: t.input_schema || t.inputSchema,
}));

log(`Loaded ${mcpTools.length} tools: ${mcpTools.map(t => t.name).join(', ')}`);

// ---------------------------------------------------------------------------
// Pending tool calls (request_id → {resolve, reject, timer})
// ---------------------------------------------------------------------------

const pending = new Map();

// ---------------------------------------------------------------------------
// Centrifugo WebSocket
// ---------------------------------------------------------------------------

let ws;
let wsReady = false;
let cmdId = 1;

function connectCentrifugo() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
      // Connect command
      ws.send(JSON.stringify({ id: cmdId++, connect: { token: TOKEN, name: '1c-mcp-relay' } }));
    });

    ws.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : event.data.toString();
      for (const line of text.split('\n')) {
        if (!line.trim() || line.trim() === '{}') {
          // Centrifugo ping — pong
          if (line.trim() === '{}') ws.send('{}');
          continue;
        }
        try {
          const msg = JSON.parse(line);
          handleCentrifugoMessage(msg, resolve, reject);
        } catch { /* ignore non-JSON */ }
      }
    });

    ws.addEventListener('close', () => {
      log('WS closed');
      // Если relay потерял связь — завершаемся, Claude CLI перезапустит при следующем вызове
      if (wsReady) process.exit(1);
    });

    ws.addEventListener('error', (e) => {
      log(`WS error: ${e.message || e}`);
      reject(new Error('WS connection failed'));
    });
  });
}

function handleCentrifugoMessage(msg, resolveConnect, rejectConnect) {
  // Connect response
  if (msg.id && msg.connect) {
    const autoSubs = msg.connect.subs ? Object.keys(msg.connect.subs) : [];
    log(`Connected, client=${msg.connect.client}`);

    if (autoSubs.includes(CHANNEL)) {
      log(`Auto-subscribed to ${CHANNEL}`);
      wsReady = true;
      resolveConnect();
    } else {
      // Manual subscribe
      const subId = cmdId++;
      ws.send(JSON.stringify({ id: subId, subscribe: { channel: CHANNEL } }));
      // Will be resolved when subscribe response comes
    }
    return;
  }

  // Connect error
  if (msg.id && msg.error && !wsReady) {
    rejectConnect(new Error(`Connect error: ${JSON.stringify(msg.error)}`));
    return;
  }

  // Subscribe response
  if (msg.id && msg.subscribe !== undefined) {
    log(`Subscribed to ${CHANNEL}`);
    wsReady = true;
    resolveConnect();
    return;
  }

  // Push — publication on channel
  const data = msg?.push?.pub?.data;
  if (data && data.type === 'tool_result' && data.request_id) {
    const p = pending.get(data.request_id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(data.request_id);
      p.resolve(data);
    }
    return;
  }

  // Ignore other messages (text_delta, thinking, etc.)
}

function publishToolCall(toolName, toolArgs) {
  const requestId = randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Timeout waiting for tool_result (${TOOL_CALL_TIMEOUT}ms)`));
    }, TOOL_CALL_TIMEOUT);

    pending.set(requestId, { resolve, reject, timer });

    const payload = {
      type: 'tool_call',
      request_id: requestId,
      tool: toolName,
      params: toolArgs || {},
    };

    ws.send(JSON.stringify({
      id: cmdId++,
      publish: { channel: CHANNEL, data: payload },
    }));
  });
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC over stdio
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore non-JSON
  }

  const { id, method, params } = msg;

  // Notifications (no id) — ignore
  if (id === undefined || id === null) return;

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: '1c-mcp-relay', version: '1.0.0' },
    });
    return;
  }

  if (method === 'tools/list') {
    respond(id, { tools: mcpTools });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    if (!toolName) {
      respondError(id, -32602, 'Missing tool name');
      return;
    }

    if (!wsReady) {
      respondError(id, -32603, 'Centrifugo not connected');
      return;
    }

    try {
      const result = await publishToolCall(toolName, toolArgs);

      // result = {type:"tool_result", request_id, result/error}
      if (result.error) {
        respond(id, {
          content: [{ type: 'text', text: String(result.error) }],
          isError: true,
        });
      } else {
        const text = typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
        respond(id, {
          content: [{ type: 'text', text }],
        });
      }
    } catch (err) {
      respond(id, {
        content: [{ type: 'text', text: err.message }],
        isError: true,
      });
    }
    return;
  }

  // Unknown method
  respondError(id, -32601, `Method not found: ${method}`);
});

rl.on('close', () => {
  log('stdin closed, exiting');
  process.exit(0);
});

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function log(msg) {
  process.stderr.write(`[1c-mcp-relay] ${msg}\n`);
}

function die(msg) {
  process.stderr.write(`[1c-mcp-relay] FATAL: ${msg}\n`);
  process.exit(1);
}

// Connect to Centrifugo, then wait for MCP commands on stdin
try {
  await connectCentrifugo();
  log('Ready — waiting for MCP commands on stdin');
} catch (err) {
  die(`Failed to connect: ${err.message}`);
}
