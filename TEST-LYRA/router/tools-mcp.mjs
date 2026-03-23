#!/usr/bin/env node
// MCP server for lyra_* tools — spawned by Claude CLI via --mcp-config
//
// Reads JSON-RPC from stdin, sends tool calls to Router via HTTP,
// returns results to Claude via stdout.
// Zero dependencies — Node.js 22+

import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMemoryTool as _handleMemoryTool } from './memory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROUTER_URL = process.env.LYRA_TOOLS_URL;
const SESSION_ID = process.env.LYRA_SESSION_ID;
const CONFIG_NAME = (process.env.LYRA_CONFIG_NAME || '').replace(/[/\\]/g, '').replace(/^\.+/, '_');
const USER_ID = (process.env.LYRA_USER_ID || '').replace(/[/\\]/g, '').replace(/^\.+/, '_');
const DB_NAME = process.env.LYRA_DB_NAME || '';
const DB_ID = process.env.LYRA_DB_ID || '';
const TOOL_CALL_TIMEOUTS = (() => {
  try { return JSON.parse(process.env.LYRA_TOOL_CALL_TIMEOUT || '{}'); } catch { return {}; }
})();
function getToolTimeout(toolName) {
  return TOOL_CALL_TIMEOUTS[toolName] || TOOL_CALL_TIMEOUTS.default || 30_000;
}

if (!ROUTER_URL) die('LYRA_TOOLS_URL env not set');
if (!SESSION_ID) die('LYRA_SESSION_ID env not set');

// Load tools definition from Router (lazy — on tools/list)
let toolsDef = null;

// --- MCP JSON-RPC over stdio ---

const rl = createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification — ignore

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'lyra-1c-tools', version: '1.0.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    // Client acknowledgement — no response needed
    return;
  }

  if (method === 'tools/list') {
    if (!toolsDef) {
      try {
        toolsDef = await fetchTools();
      } catch (err) {
        respondError(id, -32603, `Failed to load tools: ${err.message}`);
        return;
      }
    }
    respond(id, { tools: toolsDef });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    if (!toolName) {
      respondError(id, -32602, 'Missing tool name');
      return;
    }

    // Напарник — goes through Centrifugo → Chat EPF (HTML/JS fetch to code.1c.ai)
    // Token is per-user, stored in Chat after auth

    // Memory tools — handle locally via shared memory.mjs (no HTTP roundtrip)
    if (toolName.startsWith('lyra_memory_')) {
      try {
        const result = _handleMemoryTool(toolName, toolArgs, {
          configName: CONFIG_NAME,
          userId: USER_ID,
          dbId: DB_ID,
          dbName: DB_NAME,
        });
        respond(id, { content: [{ type: 'text', text: result }] });
      } catch (err) {
        respond(id, { content: [{ type: 'text', text: err.message }], isError: true });
      }
      return;
    }

    try {
      const result = await callTool(toolName, toolArgs);

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

  respondError(id, -32601, `Method not found: ${method}`);
});

rl.on('close', () => process.exit(0));

// --- HTTP communication with Router ---

async function fetchTools() {
  const res = await fetch(`${ROUTER_URL.replace('/tool-call', '/tools')}?session_id=${SESSION_ID}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // Convert input_schema → inputSchema for MCP
  return (data.tools || []).map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema || t.inputSchema,
  }));
}

async function callTool(toolName, toolArgs) {
  const controller = new AbortController();
  const timeout = getToolTimeout(toolName);
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(ROUTER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: toolName,
        params: toolArgs,
        session_id: SESSION_ID,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Router HTTP ${res.status}: ${text}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// --- Helpers ---

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function log(msg) {
  process.stderr.write(`[lyra-1c-tools] ${msg}\n`);
}

function die(msg) {
  process.stderr.write(`[lyra-1c-tools] FATAL: ${msg}\n`);
  process.exit(1);
}
