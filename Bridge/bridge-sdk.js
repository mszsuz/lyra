#!/usr/bin/env node
'use strict';

/**
 * Lyra Bridge SDK v3 — Agent SDK edition
 *
 * Replaces CLI subprocess (spawn('claude')) with @anthropic-ai/claude-agent-sdk.
 * - Haiku: long-lived router session per user
 *     - respond_to_user(response) — custom MCP tool for direct response (streamed)
 *     - Task(analyst) — built-in Agent SDK tool for subagent invocation
 * - Sonnet: analyst subagent invoked by Haiku via Task tool
 * - MCP tools for 1C created in-process via createSdkMcpServer
 * - Streaming: StreamEvent -> WebSocket -> 1C
 *
 * Usage:  node bridge-sdk.js [--port 3003]
 */

const WebSocket = require('ws');
const { randomUUID, createHmac } = require('crypto');
const path = require('path');
const fs = require('fs');

// ─── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
const PORT = Number(argVal('--port')) || 3003;

function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

// ─── JWT configuration ───────────────────────────────────────
const JWT_SECRET = process.env.LYRA_JWT_SECRET || null;

if (JWT_SECRET) {
  console.log('[bridge-sdk] JWT authentication enabled');
} else {
  console.log('[bridge-sdk] WARNING: JWT authentication disabled (LYRA_JWT_SECRET not set)');
}

/**
 * Verify HS256 JWT token
 * @param {string} token - JWT token
 * @param {string} secret - Secret key
 * @returns {object|null} - Decoded payload or null if invalid
 */
function verifyJwt(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // Verify signature
    const signatureInput = `${headerB64}.${payloadB64}`;
    const expectedSignature = createHmac('sha256', secret)
      .update(signatureInput)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    if (signatureB64 !== expectedSignature) return null;

    // Decode payload
    const payloadJson = Buffer.from(payloadB64, 'base64').toString('utf-8');
    const payload = JSON.parse(payloadJson);

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;

    return payload;
  } catch (e) {
    return null;
  }
}

// ─── Prompts ─────────────────────────────────────────────────
const ROUTER_PROMPT_PATH = path.resolve(__dirname, '..', 'lyra-router-prompt.md');
const ANALYST_PROMPT_PATH = path.resolve(__dirname, '..', 'lyra-analyst-prompt.md');

/**
 * Load a prompt file, replacing {variable} placeholders with values.
 * Uses the entire file content as the prompt.
 */
function loadPrompt(filePath, vars) {
  let text = fs.readFileSync(filePath, 'utf-8');
  for (const [k, v] of Object.entries(vars || {})) {
    text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return text.trim();
}

// ─── Logging ─────────────────────────────────────────────────
const logDir = path.join(__dirname, 'logs');
fs.mkdirSync(logDir, { recursive: true });

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ═════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════

const sessions = new Map();   // sessionId -> Session

const wss = new WebSocket.Server({ port: PORT });
console.log(`[bridge-sdk] WebSocket :${PORT}`);

wss.on('connection', (ws, req) => {
  on1cConnect(ws, req);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// BUG-3 FIX: Prevent crash on uncaught Agent SDK ProcessTransport errors
process.on('uncaughtException', (err) => {
  // Agent SDK ProcessTransport throws "ProcessTransport is not ready for writing"
  // when trying to send control_response after the process has closed.
  // This is a known race condition when busy rejection is sent while a query is running.
  // Log the error but don't crash the bridge.
  if (err.message && err.message.includes('ProcessTransport is not ready')) {
    console.log(`[bridge-sdk] Caught ProcessTransport error (non-fatal): ${err.message}`);
    return;
  }
  // For other errors, log and crash
  console.error('[bridge-sdk] Uncaught exception:', err);
  shutdown();
});

function shutdown() {
  console.log('[bridge-sdk] shutting down...');
  for (const s of sessions.values()) {
    if (s.abortController) s.abortController.abort();
  }
  wss.close();
  process.exit(0);
}

// ─── 1C connects ─────────────────────────────────────────────

function on1cConnect(ws, req) {
  const p = new URL(req.url, 'http://x').searchParams;
  const resumeId = p.get('session');
  const token = p.get('token');

  // JWT authentication (if enabled)
  if (JWT_SECRET) {
    if (!token) {
      console.log('[auth] Connection rejected: no token');
      ws.close(4001, 'Authentication required');
      return;
    }

    const payload = verifyJwt(token, JWT_SECRET);
    if (!payload) {
      console.log('[auth] Connection rejected: invalid token');
      ws.close(4001, 'Invalid token');
      return;
    }

    console.log(`[auth] Authenticated: ${payload.sub} (${payload.role})`);
  }

  const sid = resumeId || randomUUID();
  let s = sessions.get(sid);

  if (s) {
    s.ws = ws;
    s.log('1C reconnected');
  } else {
    const logFile = path.join(logDir, `${sid}.log`);
    s = {
      id: sid,
      ws,
      config: null,            // session context from hello
      busy: false,             // true while agent is processing
      abortController: null,   // AbortController for running query
      agentSessionId: null,    // Agent SDK session ID for resume
      tokenUsage: {},          // model -> { inputTokens, outputTokens }
      messageQueue: [],        // BUG-1 FIX: Queue for messages received while busy
      log(msg) {
        const line = `[${ts()}] ${msg}`;
        console.log(`[${sid.slice(0, 8)}] ${msg}`);
        try { fs.appendFileSync(logFile, line + '\n'); } catch {}
      }
    };
    sessions.set(sid, s);
    s.log('new session');
  }

  wsSend(ws, { type: 'session', sessionId: sid });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      s.log(`1C -> ${String(raw).slice(0, 500)}`);

      if (msg.type === 'hello') {
        s.config = {
          configuration: msg.config || 'Unknown',
          version: msg.version || '',
          processingVersion: msg.processingVersion || '',
          userName: msg.userName || 'User',
          userRole: msg.userRole || 'user',
          baseId: msg.baseId || randomUUID()
        };
        wsSend(ws, {
          type: 'hello_ack',
          sessionId: sid,
          baseId: s.config.baseId
        });
        s.log(`hello_ack: ${s.config.configuration} / ${s.config.userName}`);

        // Send initial greeting via Haiku
        // BUG-1 FIX: Catch unhandled errors from handleChat
        handleChat(s, null).catch(err => {
          s.log(`Uncaught error in handleChat (greeting): ${err.message}\n${err.stack || ''}`);
        });
      }
      else if (msg.type === 'chat') {
        // BUG-1 FIX: Simple busy rejection (no resume = no queue makes sense)
        if (s.busy) {
          s.log('Rejected chat (busy)');
          wsSend(ws, {
            type: 'error',
            reason: 'busy',
            message: 'Подождите, обрабатываю предыдущий запрос.'
          });
          return;
        }
        // Start processing (no await to avoid blocking WS message handler)
        handleChat(s, msg.content).catch(err => {
          s.log(`Uncaught error in handleChat: ${err.message}\n${err.stack || ''}`);
        });
      }
      else if (msg.type === 'mcp_response') {
        handleMcpResponse(msg);
      }
    } catch (e) {
      s.log(`1C parse error: ${e.message}`);
    }
  });

  ws.on('close', () => {
    s.log('1C disconnected');
    s.ws = null;
  });
}

// ─── MCP response handling (1C -> Bridge -> Agent SDK) ───────

const pendingMcp = new Map();  // requestId -> { resolve, reject, timer }

function handleMcpResponse(msg) {
  const p = pendingMcp.get(msg.requestId);
  if (!p) return;
  pendingMcp.delete(msg.requestId);
  clearTimeout(p.timer);
  if (msg.error) {
    p.reject(new Error(msg.error));
  } else {
    p.resolve(msg.result);
  }
}

function call1c(session, tool, params) {
  return new Promise((resolve, reject) => {
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      reject(new Error('1C disconnected'));
      return;
    }
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      pendingMcp.delete(requestId);
      reject(new Error('Таймаут запроса к 1С (30с)'));
    }, 30000);
    pendingMcp.set(requestId, { resolve, reject, timer });
    wsSend(session.ws, { type: 'mcp_request', requestId, tool, params });
  });
}

// ─── MCP Servers (in-process) ────────────────────────────────

// Session routing: which session is currently running the agent.
// Safe because busy flag prevents concurrent agent processing per session,
// and we only run one agent at a time per bridge instance (for now).
let _activeSession = null;

let _mcpServersReady = false;
let _lyraToolsServer = null;
let _1cToolsServer = null;

async function ensureMcpServers() {
  if (_mcpServersReady) return;

  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const { z } = await import('zod');

  // ── Lyra custom tools (respond_to_user) ──
  _lyraToolsServer = createSdkMcpServer({
    name: 'lyra',
    version: '1.0.0',
    tools: [
      tool(
        'respond_to_user',
        'Send a direct response to the user. Use for simple questions, greetings, clarifications, and restricted topics. The response text is streamed to the user in real-time.',
        {
          response: z.string().describe('The response text to send to the user')
        },
        async (args) => {
          // The actual streaming happens via StreamEvent (input_json_delta).
          // This handler is called AFTER streaming is complete.
          // We just confirm delivery.
          return {
            content: [{
              type: 'text',
              text: 'Response delivered to user.'
            }]
          };
        }
      )
    ]
  });

  // ── 1C tools ──
  _1cToolsServer = createSdkMcpServer({
    name: '1c',
    version: '3.0.0',
    tools: [
      tool(
        '1c_query',
        'Выполнить запрос на языке запросов 1С (ВЫБРАТЬ...ИЗ...). Это НЕ SQL! Возвращает данные в JSON.',
        {
          query: z.string().describe('Текст запроса на языке 1С'),
          params: z.record(z.any()).optional().describe('Параметры запроса (необязательно)')
        },
        async (args) => {
          if (!_activeSession) return mcpError('Нет подключения к 1С');
          try {
            const result = await call1c(_activeSession, '1c_query', args);
            return mcpOk(result);
          } catch (e) {
            return mcpError(e.message);
          }
        }
      ),
      tool(
        '1c_eval',
        'Вычислить выражение на языке 1С. Только выражения, НЕ процедуры. Пример: Строка(ТекущаяДата())',
        {
          expression: z.string().describe('Выражение на языке 1С')
        },
        async (args) => {
          if (!_activeSession) return mcpError('Нет подключения к 1С');
          try {
            const result = await call1c(_activeSession, '1c_eval', args);
            return mcpOk(result);
          } catch (e) {
            return mcpError(e.message);
          }
        }
      ),
      tool(
        '1c_metadata',
        'Получить дерево/ветку метаданных конфигурации 1С',
        {
          path: z.string().optional().describe('Путь в дереве метаданных (пусто = корень)')
        },
        async (args) => {
          if (!_activeSession) return mcpError('Нет подключения к 1С');
          try {
            const result = await call1c(_activeSession, '1c_metadata', args);
            return mcpOk(result);
          } catch (e) {
            return mcpError(e.message);
          }
        }
      ),
      tool(
        '1c_exec',
        'Выполнить блок кода на языке 1С (процедуры, циклы, условия, присваивания)',
        {
          code: z.string().describe('Код на встроенном языке 1С')
        },
        async (args) => {
          if (!_activeSession) return mcpError('Нет подключения к 1С');
          try {
            const result = await call1c(_activeSession, '1c_exec', args);
            return mcpOk(result);
          } catch (e) {
            return mcpError(e.message);
          }
        }
      )
    ]
  });

  _mcpServersReady = true;
}

function mcpOk(result) {
  return {
    content: [{
      type: 'text',
      text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
    }]
  };
}

function mcpError(msg) {
  return {
    content: [{ type: 'text', text: `Ошибка: ${msg}` }],
    isError: true
  };
}

// ─── Chat handler (Agent SDK) ────────────────────────────────

async function handleChat(session, userMessage) {
  // BUG-1 FIX: Wrap entire function in try/catch to prevent unhandled errors
  // from crashing the bridge when busy rejection is sent
  try {
    session.busy = true;
    session.abortController = new AbortController();
    _activeSession = session;

    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    await ensureMcpServers();

    // Template variables for prompts
    const vars = {
      configuration: session.config?.configuration || 'Unknown',
      release: session.config?.version || '',
      userName: session.config?.userName || 'User',
      userRole: session.config?.userRole || 'user'
    };

    const routerPrompt = loadPrompt(ROUTER_PROMPT_PATH, vars);
    const analystPrompt = loadPrompt(ANALYST_PROMPT_PATH, vars);

    // Streaming input (async generator) — required for MCP servers
    const promptText = userMessage || 'Поприветствуй пользователя.';

    async function* generateMessages() {
      yield {
        type: 'user',
        message: { role: 'user', content: promptText }
      };
    }

    const options = {
      model: 'haiku',
      systemPrompt: routerPrompt,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      maxTurns: 30,
      mcpServers: {
        lyra: _lyraToolsServer,
        '1c': _1cToolsServer
      },
      allowedTools: [
        'Task',
        'mcp__lyra__respond_to_user',
        'mcp__1c__1c_query',
        'mcp__1c__1c_eval',
        'mcp__1c__1c_metadata',
        'mcp__1c__1c_exec'
      ],
      agents: {
        analyst: {
          description: 'Аналитик 1С. Вызывай для вопросов, требующих анализа данных, конфигурации или запросов к базе.',
          prompt: analystPrompt,
          model: 'sonnet',
          tools: [
            'mcp__1c__1c_query',
            'mcp__1c__1c_eval',
            'mcp__1c__1c_metadata',
            'mcp__1c__1c_exec'
          ]
        }
      }
    };

    // BUG-1 FIX: Do NOT resume session - creates ProcessTransport issues
    // Each query() call creates a new ProcessTransport, fresh session
    // if (session.agentSessionId) {
    //   options.resume = session.agentSessionId;
    // }

    session.log(`query: ${promptText.slice(0, 100)}`);

    // ── Streaming state ──
    let currentToolName = null;
    let respondBuffer = '';
    let respondSentLen = 0;       // how many chars of response already sent
    let fullResult = '';

    for await (const message of query({
      prompt: generateMessages(),
      options
    })) {

      // ── System init: capture session ID (DISABLED for BUG-1 fix) ──
      if (message.type === 'system' && message.subtype === 'init') {
        // BUG-1 FIX: No longer capturing/resuming session IDs
        // to avoid ProcessTransport issues with concurrent queries
        session.log(`agent session init: ${message.session_id}`);
        continue;
      }

      // ── Stream events (partial messages) ──
      if (message.type === 'stream_event') {
        const event = message.event;
        const fromSubagent = !!message.parent_tool_use_id;

        // --- content_block_start ---
        if (event.type === 'content_block_start') {
          const cb = event.content_block || {};

          if (cb.type === 'tool_use') {
            currentToolName = cb.name;
            respondBuffer = '';
            respondSentLen = 0;

            if (cb.name === 'mcp__lyra__respond_to_user') {
              session.log('-> respond_to_user');
            } else if (cb.name === 'Task') {
              session.log('-> Task (subagent)');
            } else {
              session.log(`-> tool: ${cb.name}`);
            }
          }
          else if (cb.type === 'text') {
            currentToolName = '__text__';
          }
        }

        // --- content_block_delta ---
        else if (event.type === 'content_block_delta') {
          const delta = event.delta || {};

          // BUG-2 FIX: Enhanced subagent text streaming
          // Text from subagent (Sonnet) -> stream to 1C
          if (fromSubagent && delta.type === 'text_delta') {
            const text = delta.text || '';
            if (text) {
              session.log(`[subagent stream] ${text.slice(0, 50)}...`);
              streamTo1c(session, text);
              fullResult += text;
            }
          }

          // BUG-2 FIX: Also stream regular text deltas (not from subagent, not from respond_to_user)
          // This handles cases where text comes from Task tool result or other sources
          if (!fromSubagent && delta.type === 'text_delta' && currentToolName === '__text__') {
            const text = delta.text || '';
            if (text) {
              session.log(`[main stream] ${text.slice(0, 50)}...`);
              streamTo1c(session, text);
              fullResult += text;
            }
          }

          // respond_to_user input_json_delta -> extract and stream response text
          if (delta.type === 'input_json_delta'
              && currentToolName === 'mcp__lyra__respond_to_user') {
            const chunk = delta.partial_json || '';
            respondBuffer += chunk;

            const textDelta = extractRespondDelta(respondBuffer, respondSentLen);
            if (textDelta) {
              respondSentLen += textDelta.length;
              streamTo1c(session, textDelta);
              fullResult += textDelta;
            }
          }

          // BUG-2 FIX: Log unknown delta types for debugging
          if (delta.type && delta.type !== 'text_delta' && delta.type !== 'input_json_delta') {
            session.log(`[stream debug] Unknown delta type: ${delta.type}, fromSubagent=${fromSubagent}, currentTool=${currentToolName}`);
          }
        }

        // --- content_block_stop ---
        else if (event.type === 'content_block_stop') {
          if (currentToolName === 'mcp__lyra__respond_to_user') {
            // Final: try to extract complete response and reconcile
            try {
              const parsed = JSON.parse(respondBuffer);
              if (parsed.response) {
                // If we missed any trailing text during streaming, send it now
                const remaining = parsed.response.slice(respondSentLen);
                if (remaining) {
                  streamTo1c(session, remaining);
                }
                fullResult = parsed.response;
              }
            } catch {}
            session.log('respond_to_user done');
          }
          currentToolName = null;
        }

        continue;
      }

      // ── Complete assistant message ──
      if (message.type === 'assistant') {
        continue;
      }

      // ── Result message (final) ──
      if (message.type === 'result') {
        session.log(`result: ${message.subtype}, turns=${message.num_turns || '?'}`);

        if (message.modelUsage) {
          session.tokenUsage = message.modelUsage;
          session.log(`tokens: ${JSON.stringify(message.modelUsage)}`);
        }
        if (message.total_cost_usd !== undefined) {
          session.log(`cost: $${message.total_cost_usd.toFixed(4)}`);
        }

        // Send final result to 1C
        if (session.ws) {
          wsSend(session.ws, {
            type: 'result',
            result: fullResult || message.result || '',
            usage: message.modelUsage || {},
            costUsd: message.total_cost_usd || 0,
            durationMs: message.duration_ms || 0
          });
        }
        break;
      }
    }
  } catch (err) {
    // BUG-1 FIX: Enhanced error logging with full stacktrace
    session.log(`ERROR in handleChat: ${err.message}\nStack: ${err.stack || 'no stack'}`);

    // Check if WebSocket is still alive before sending error
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      wsSend(session.ws, {
        type: 'error',
        reason: 'agent_error',
        message: err.message
      });
    } else {
      session.log(`Cannot send error to 1C: WebSocket not connected (readyState=${session.ws?.readyState})`);
    }
  } finally {
    session.busy = false;
    session.abortController = null;
    // BUG-3 FIX: Do NOT clear _activeSession here - it will be cleared at the start
    // of the next handleChat. Clearing it here causes race conditions where Agent SDK
    // ProcessTransport tries to send control_response after cleanup, resulting in
    // "ProcessTransport is not ready for writing" error (caught by uncaughtException handler).
  }
}

// ─── Stream text to 1C ───────────────────────────────────────

function streamTo1c(session, text) {
  if (session.ws) {
    wsSend(session.ws, {
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { text } }
    });
  }
}

// ─── Incremental JSON parser for respond_to_user ─────────────
//
// respond_to_user streams JSON like:  {"response":"Привет, Иванов!"}
// via input_json_delta chunks. We incrementally parse the growing
// JSON buffer to extract new text as it arrives.

function extractRespondDelta(buffer, alreadySent) {
  const prefix = '"response":"';
  const idx = buffer.indexOf(prefix);
  if (idx === -1) return null;

  const start = idx + prefix.length;
  let raw = buffer.slice(start);

  // Remove closing quote if present (means value is complete)
  if (raw.endsWith('"}') || raw.endsWith('"')) {
    raw = raw.replace(/"}\s*$/, '').replace(/"$/, '');
  }

  // Try to unescape JSON string
  let text;
  try {
    text = JSON.parse('"' + raw + '"');
  } catch {
    // Might have incomplete escape at end — try without last char
    if (raw.length > 0) {
      try {
        text = JSON.parse('"' + raw.slice(0, -1) + '"');
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  if (text.length > alreadySent) {
    return text.slice(alreadySent);
  }
  return null;
}

// ─── WebSocket utility ───────────────────────────────────────

function wsSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

console.log('[bridge-sdk] ready');
