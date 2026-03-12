#!/usr/bin/env node
// MCP server for lyra_* tools — spawned by Claude CLI via --mcp-config
//
// Reads JSON-RPC from stdin, sends tool calls to Router via HTTP,
// returns results to Claude via stdout.
// Zero dependencies — Node.js 22+

import { createInterface } from 'node:readline';

const ROUTER_URL = process.env.LYRA_TOOLS_URL;
const SESSION_ID = process.env.LYRA_SESSION_ID;
const TOOL_CALL_TIMEOUT = 60_000;

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
  const timer = setTimeout(() => controller.abort(), TOOL_CALL_TIMEOUT);

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
