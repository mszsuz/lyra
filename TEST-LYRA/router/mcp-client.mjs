// MCP HTTP client — calls tools on MCP servers (Vega, mcp-1c-docs)
// Protocol: JSON-RPC 2.0 over HTTP POST

import * as log from './log.mjs';
const TAG = 'mcp-client';

let nextId = 1;

/**
 * Call a tool on an MCP server.
 * @param {string} url - MCP server URL (e.g. http://localhost:60010/mcp)
 * @param {string} toolName - Tool name (e.g. search_code)
 * @param {object} args - Tool arguments
 * @param {object} [headers] - Optional headers (e.g. X-API-Key)
 * @returns {Promise<object>} - Tool result { content: [...] } or { error: string }
 */
export async function callTool(url, toolName, args, headers = {}) {
  const id = nextId++;
  const body = {
    jsonrpc: '2.0',
    method: 'tools/call',
    params: { name: toolName, arguments: args },
    id,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error(TAG, `HTTP ${res.status} from ${url}: ${text.substring(0, 200)}`);
      return { error: `MCP server error: ${res.status}` };
    }

    const data = await res.json();

    if (data.error) {
      log.error(TAG, `JSON-RPC error: ${JSON.stringify(data.error).substring(0, 200)}`);
      return { error: data.error.message || 'MCP tool error' };
    }

    return data.result || { content: [] };
  } catch (err) {
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
  const id = nextId++;
  const body = {
    jsonrpc: '2.0',
    method: 'tools/list',
    id,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    });

    if (!res.ok) return [];
    const data = await res.json();
    return data.result?.tools || [];
  } catch {
    return [];
  }
}
