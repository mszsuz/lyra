// Tool execution — routes tool calls to the right handler
// Memory tools → memory.mjs (local), MCP tools → mcp-client.mjs, client tools → Centrifugo

import { handleMemoryTool } from './memory.mjs';
import { callTool as mcpCallTool } from './mcp-client.mjs';
import { randomUUID } from 'node:crypto';
import * as log from './log.mjs';

const TAG = 'tool-exec';

const VEGA_TOOLS = ['search_code', 'search_metadata', 'search_metadata_by_description'];
const DOCS_TOOLS = ['search_docs', 'fetch_url', 'list_libraries'];

/**
 * Vega expects `query` as a JSON string with `op` field.
 * Models often send plain text — wrap it into the correct JSON format.
 */
function normalizeVegaArgs(toolName, input) {
  const query = input?.query;
  if (!query) return input;

  // Already valid JSON with op — pass through
  try {
    const parsed = JSON.parse(query);
    if (parsed.op) return input;
  } catch {}

  // Plain text → wrap into default op
  let wrapped;
  if (toolName === 'search_metadata') {
    wrapped = JSON.stringify({ op: 'list_objects_by_name', name: query, match: 'contains' });
  } else if (toolName === 'search_metadata_by_description') {
    wrapped = JSON.stringify({ op: 'search_metadata_by_description', text: query });
  } else if (toolName === 'search_code') {
    wrapped = JSON.stringify({ op: 'find_routines_by_description', text: query });
  } else {
    return input;
  }

  log.info(TAG, `Vega query normalized: "${query}" → ${wrapped}`);
  return { ...input, query: wrapped };
}

function extractMcpText(mcpResult) {
  if (!mcpResult?.content) return JSON.stringify(mcpResult);
  return mcpResult.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n') || JSON.stringify(mcpResult);
}

/**
 * Execute a tool call and return normalized result.
 * @param {object} session - Session object
 * @param {object} toolUse - { name, input, id }
 * @param {object} opts - { centrifugo, toolCallTimeout }
 * @returns {Promise<{ content: string, isError: boolean }>}
 */
export async function executeTool(session, toolUse, { centrifugo, toolCallTimeout }) {
  log.info(TAG, `Tool call: ${toolUse.name} (session ${session.sessionId})`);

  // Memory tools — execute locally
  if (toolUse.name.startsWith('lyra_memory_')) {
    try {
      const result = handleMemoryTool(toolUse.name, toolUse.input, {
        configName: session.configName,
        userId: session.userId,
        dbId: session.dbId,
        dbName: session.dbName,
      });
      return { content: typeof result === 'string' ? result : JSON.stringify(result), isError: false };
    } catch (err) {
      return { content: err.message, isError: true };
    }
  }

  // MCP tools — Vega
  if (VEGA_TOOLS.includes(toolUse.name) && session.mcpServers?.vega) {
    const { url, headers } = session.mcpServers.vega;
    log.info(TAG, `MCP→Vega: ${toolUse.name}`);
    const vegaInput = normalizeVegaArgs(toolUse.name, toolUse.input);
    const result = await mcpCallTool(url, toolUse.name, vegaInput, headers);
    if (result.error) return { content: String(result.error), isError: true };
    return { content: extractMcpText(result), isError: false };
  }

  // MCP tools — mcp-1c-docs
  if (DOCS_TOOLS.includes(toolUse.name) && session.mcpServers?.docs) {
    const { url, headers } = session.mcpServers.docs;
    log.info(TAG, `MCP→docs: ${toolUse.name}`);
    const result = await mcpCallTool(url, toolUse.name, toolUse.input, headers);
    if (result.error) return { content: String(result.error), isError: true };
    return { content: extractMcpText(result), isError: false };
  }

  // Client tools — via Centrifugo → Chat 1С
  const requestId = randomUUID();
  const timeout = toolCallTimeout?.[toolUse.name] || toolCallTimeout?.default || 30000;

  centrifugo.apiPublish(session.channel, {
    type: 'tool_call',
    request_id: requestId,
    tool: toolUse.name,
    params: toolUse.input,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.pendingToolCalls?.delete(requestId);
      reject(new Error(`Tool timeout: ${toolUse.name}`));
    }, timeout);

    if (!session.pendingToolCalls) session.pendingToolCalls = new Map();
    session.pendingToolCalls.set(requestId, {
      resolve: (data) => {
        clearTimeout(timer);
        const content = typeof data.result === 'string' ? data.result : JSON.stringify(data.result ?? data);
        resolve({ content, isError: !!data.error });
      },
      reject: (err) => { clearTimeout(timer); reject(err); },
      timer,
    });
  });
}
