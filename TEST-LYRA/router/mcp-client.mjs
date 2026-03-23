// MCP HTTP client — calls tools on MCP servers (Vega, mcp-1c-docs)
// Protocol: MCP Streamable HTTP (JSON-RPC 2.0 over HTTP POST)
// Handles: initialize handshake, Mcp-Session-Id, SSE responses

import * as log from './log.mjs';
const TAG = 'mcp-client';

let nextId = 1;

// Track initialized sessions: url → { sessionId, initialized }
const sessions = new Map();

/**
 * Parse SSE response body into JSON-RPC result.
 * SSE format: "event: message\ndata: {json}\n\n"
 */
async function parseSSE(res) {
  const text = await res.text();
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const json = line.slice(6).trim();
      if (json) {
        try { return JSON.parse(json); } catch {}
      }
    }
  }
  // Fallback: try parsing the whole body as JSON
  try { return JSON.parse(text); } catch {}
  return null;
}

/**
 * Send a JSON-RPC request and parse the response (JSON or SSE).
 */
async function rpcRequest(url, body, headers = {}) {
  const session = sessions.get(url);
  const reqHeaders = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...headers,
  };
  if (session?.sessionId) {
    reqHeaders['Mcp-Session-Id'] = session.sessionId;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify(body),
  });

  // Save session ID from response
  const respSessionId = res.headers.get('mcp-session-id');
  if (respSessionId) {
    const s = sessions.get(url) || {};
    s.sessionId = respSessionId;
    sessions.set(url, s);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.substring(0, 200)}`);
  }

  // Handle SSE or JSON based on Content-Type
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    return await parseSSE(res);
  }
  return await res.json();
}

/**
 * Initialize MCP session (handshake).
 * Sends initialize + notifications/initialized.
 */
async function ensureInitialized(url, headers = {}) {
  const session = sessions.get(url);
  if (session?.initialized) return;

  log.info(TAG, `Initializing MCP session: ${url}`);

  const initBody = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'lyra-router', version: '1.0.0' },
    },
    id: nextId++,
  };

  const data = await rpcRequest(url, initBody, headers);
  if (data?.error) {
    throw new Error(`MCP initialize error: ${data.error.message || JSON.stringify(data.error)}`);
  }

  log.info(TAG, `MCP initialized: ${url} (protocol=${data?.result?.protocolVersion || '?'})`);

  // Send notifications/initialized (no id — it's a notification)
  const notifBody = {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  };
  // Fire and forget — some servers may not respond to notifications
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...headers,
        ...(sessions.get(url)?.sessionId ? { 'Mcp-Session-Id': sessions.get(url).sessionId } : {}),
      },
      body: JSON.stringify(notifBody),
    });
  } catch {}

  const s = sessions.get(url) || {};
  s.initialized = true;
  sessions.set(url, s);
}

/**
 * Call a tool on an MCP server.
 * Auto-initializes the session on first call.
 * @param {string} url - MCP server URL (e.g. http://localhost:60010/mcp)
 * @param {string} toolName - Tool name (e.g. search_code)
 * @param {object} args - Tool arguments
 * @param {object} [headers] - Optional headers (e.g. X-API-Key)
 * @returns {Promise<object>} - Tool result { content: [...] } or { error: string }
 */
export async function callTool(url, toolName, args, headers = {}) {
  try {
    await ensureInitialized(url, headers);
  } catch (err) {
    log.error(TAG, `Failed to initialize ${url}: ${err.message}`);
    // Reset session so next call retries
    sessions.delete(url);
    return { error: `MCP init failed: ${err.message}` };
  }

  const id = nextId++;
  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id,
  };

  try {
    const data = await rpcRequest(url, body, headers);

    if (!data) {
      return { error: 'Empty response from MCP server' };
    }

    if (data.error) {
      log.error(TAG, `JSON-RPC error: ${JSON.stringify(data.error).substring(0, 200)}`);
      return { error: data.error.message || 'MCP tool error' };
    }

    return data.result || { content: [] };
  } catch (err) {
    // If session expired, reset and let next call re-initialize
    if (err.message.includes('422') || err.message.includes('session')) {
      sessions.delete(url);
    }
    log.error(TAG, `Failed to call ${toolName} on ${url}: ${err.message}`);
    return { error: `MCP unavailable: ${err.message}` };
  }
}

/**
 * List available tools from an MCP server.
 * @param {string} url - MCP server URL
 * @param {object} [headers] - Optional headers
 * @returns {Promise<Array>} - Array of tool definitions
 */
export async function listTools(url, headers = {}) {
  try {
    await ensureInitialized(url, headers);
  } catch {
    return [];
  }

  const id = nextId++;
  const body = {
    jsonrpc: '2.0',
    method: 'tools/list',
    id,
  };

  try {
    const data = await rpcRequest(url, body, headers);
    return data?.result?.tools || [];
  } catch {
    return [];
  }
}
