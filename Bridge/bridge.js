#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');

// ─── Аргументы командной строки ─────────────────────────────
const args = process.argv.slice(2);
const isMcpMode = args.includes('--mcp');
const PORT = Number(argVal('--port')) || 3003;

if (isMcpMode) {
  const sessionId = argVal('--session');
  if (!sessionId) {
    process.stderr.write('--session <id> required in MCP mode\n');
    process.exit(1);
  }
  runMcpMode(sessionId);
} else {
  runMainMode();
}

function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}


// ═════════════════════════════════════════════════════════════
//  ОСНОВНОЙ РЕЖИМ
//  WebSocket-сервер (:3001), управление сессиями и Claude
// ═════════════════════════════════════════════════════════════

function runMainMode() {
  const sessions = new Map();   // sessionId → Session
  const logDir = path.join(__dirname, 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  const wss = new WebSocket.Server({ port: PORT });
  console.log(`[bridge] WebSocket :${PORT}`);

  wss.on('connection', (ws, req) => {
    const p = new URL(req.url, 'http://x').searchParams;
    const type = p.get('type');     // 'mcp' или null (=1С)
    const sid  = p.get('session');  // session ID (для mcp и reconnect)

    if (type === 'mcp' && sid) {
      onMcpConnect(ws, sid, sessions);
    } else {
      on1cConnect(ws, sid, sessions, logDir);
    }
  });

  // Graceful shutdown
  process.on('SIGINT',  () => shutdown(sessions, wss));
  process.on('SIGTERM', () => shutdown(sessions, wss));
}

function shutdown(sessions, wss) {
  console.log('[bridge] shutting down...');
  for (const s of sessions.values()) {
    if (s.claude) s.claude.kill();
  }
  wss.close();
  process.exit(0);
}


// ─── 1С подключается ────────────────────────────────────────

function on1cConnect(ws, resumeId, sessions, logDir) {
  const sid = resumeId || randomUUID();
  let s = sessions.get(sid);

  if (s) {
    // Переподключение к существующей сессии
    s.ws1c = ws;
    s.log('1С reconnected');
  } else {
    // Новая сессия
    const logFile = path.join(logDir, `${sid}.log`);
    s = {
      id: sid,
      ws1c: ws,
      wsMcp: null,
      claude: null,
      log(msg) {
        const line = `[${ts()}] ${msg}`;
        console.log(line);
        fs.appendFileSync(logFile, line + '\n');
      }
    };
    sessions.set(sid, s);
    s.log('new session');
  }

  // Отправляем 1С её session ID
  wsSend(ws, { type: 'session', sessionId: sid });

  // Запускаем Claude если ещё не запущен
  if (!s.claude) spawnClaude(s);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      s.log(`1С → ${String(raw).slice(0, 500)}`);

      if (msg.type === 'chat') {
        // Сообщение пользователя → Claude stdin
        writeToClaudeStdin(s, {
          type: 'user',
          message: { role: 'user', content: msg.content }
        });
      } else if (msg.type === 'mcp_response') {
        // Ответ на MCP-запрос → MCP-клиент
        if (s.wsMcp) wsSend(s.wsMcp, msg);
      }
    } catch (e) {
      s.log(`1С parse error: ${e.message}`);
    }
  });

  ws.on('close', () => {
    s.log('1С disconnected');
    s.ws1c = null;
    // Claude не убиваем — 1С может переподключиться
  });
}


// ─── MCP-клиент (bridge --mcp) подключается ────────────────

function onMcpConnect(ws, sid, sessions) {
  const s = sessions.get(sid);
  if (!s) {
    console.log(`[bridge] MCP for unknown session: ${sid}`);
    ws.close(4004, 'unknown session');
    return;
  }

  s.wsMcp = ws;
  s.log('MCP client connected');

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      s.log(`MCP → ${String(raw).slice(0, 300)}`);

      // MCP-запрос инструмента → пересылаем 1С
      if (msg.type === 'mcp_request' && s.ws1c) {
        wsSend(s.ws1c, msg);
      }
    } catch (e) {
      s.log(`MCP parse error: ${e.message}`);
    }
  });

  ws.on('close', () => {
    s.log('MCP client disconnected');
    s.wsMcp = null;
  });
}


// ─── Запуск Claude Code ─────────────────────────────────────

function spawnClaude(s) {
  // MCP-конфиг: Claude запустит bridge.js --mcp как свой MCP-сервер
  const mcpConfig = JSON.stringify({
    mcpServers: {
      '1c': {
        command: 'node',
        args: [
          path.resolve(__dirname, 'bridge.js'),
          '--mcp', '--session', s.id,
          '--port', String(PORT)
        ]
      }
    }
  });

  const systemPrompt =
    'Ты AI-помощник, подключённый к базе 1С:Предприятие. ' +
    'Используй MCP-инструменты 1c_query, 1c_eval, 1c_metadata, 1c_exec для работы с базой. ' +
    'Язык запросов 1С это НЕ SQL (ВЫБРАТЬ, ИЗ, ГДЕ, а не SELECT FROM WHERE). ' +
    'Даты в запросах: ДАТАВРЕМЯ(2025,1,1). Отвечай на русском.';

  const claudeArgs = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--disable-slash-commands',
    '--session-id', s.id,
    '--mcp-config', mcpConfig,
    '--system-prompt', systemPrompt,
    '--allowedTools', 'mcp__1c__1c_query', 'mcp__1c__1c_eval',
      'mcp__1c__1c_metadata', 'mcp__1c__1c_exec', 'ToolSearch',
    '--strict-mcp-config',
    '--settings', JSON.stringify({ disableAllHooks: true }),
  ];

  s.log(`spawn claude`);

  const cp = spawn('claude', claudeArgs, {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  s.claude = cp;
  s.log(`claude pid=${cp.pid}`);

  // Claude stdout → NDJSON → пересылаем 1С
  let buf = '';
  cp.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();   // неполная последняя строка остаётся в буфере

    for (const line of lines) {
      if (!line) continue;
      s.log(`claude → ${line.slice(0, 300)}`);
      if (s.ws1c) wsSend(s.ws1c, line, true);   // raw JSON string
    }
  });

  cp.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) s.log(`claude stderr: ${text.slice(0, 300)}`);
  });

  cp.on('exit', (code) => {
    s.log(`claude exit code=${code}`);
    s.claude = null;
    if (s.ws1c) wsSend(s.ws1c, { type: 'claude_exit', code });
  });
}


// ─── Утилиты основного режима ───────────────────────────────

function writeToClaudeStdin(s, obj) {
  if (s.claude && s.claude.stdin.writable) {
    s.claude.stdin.write(JSON.stringify(obj) + '\n');
  }
}

function wsSend(ws, data, raw = false) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(raw ? data : JSON.stringify(data));
  }
}

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}


// ═════════════════════════════════════════════════════════════
//  MCP РЕЖИМ
//  stdio MCP-сервер (для Claude) ↔ WebSocket-клиент (к bridge)
//  Запускается как: node bridge.js --mcp --session <id>
// ═════════════════════════════════════════════════════════════

async function runMcpMode(sessionId) {
  const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
  const {
    ListToolsRequestSchema,
    CallToolRequestSchema
  } = require('@modelcontextprotocol/sdk/types.js');

  // Подключаемся к основному bridge через WebSocket
  const ws = new WebSocket(
    `ws://localhost:${PORT}/?type=mcp&session=${sessionId}`
  );

  const pending = new Map();  // requestId → { resolve, reject, timer }

  await new Promise((ok, fail) => {
    ws.on('open', ok);
    ws.on('error', fail);
  });

  // Ответы от 1С приходят через bridge
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'mcp_response' && pending.has(msg.requestId)) {
        const p = pending.get(msg.requestId);
        pending.delete(msg.requestId);
        clearTimeout(p.timer);
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
      }
    } catch (e) { /* ignore */ }
  });

  // Вызов инструмента 1С через bridge → WebSocket → 1С
  function call1c(tool, params) {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Таймаут запроса к 1С (30с)'));
      }, 30000);
      pending.set(requestId, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: 'mcp_request', requestId, tool, params }));
    });
  }

  // ─── MCP-сервер ─────────────────────────────────────────

  const server = new Server(
    { name: '1c-bridge', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  // Список инструментов
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      mcpTool('1c_query',
        'Выполнить запрос на языке запросов 1С (ВЫБРАТЬ ... ИЗ ...). Это НЕ SQL!',
        { query:  { type: 'string', description: 'Текст запроса 1С' },
          params: { type: 'object', description: 'Параметры запроса (необязательно)' } },
        ['query']),

      mcpTool('1c_eval',
        'Вычислить выражение 1С. Только выражения, НЕ процедуры. Пример: Строка(ТекущаяДата())',
        { expression: { type: 'string', description: 'Выражение на языке 1С' } },
        ['expression']),

      mcpTool('1c_metadata',
        'Получить дерево/ветку метаданных конфигурации 1С',
        { path: { type: 'string', description: 'Путь в дереве метаданных (пусто = корень)' } },
        []),

      mcpTool('1c_exec',
        'Выполнить блок кода на языке 1С (процедуры, циклы, условия, присваивания)',
        { code: { type: 'string', description: 'Код на встроенном языке 1С' } },
        ['code']),
    ]
  }));

  // Вызов инструмента
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: params } = req.params;
    try {
      const result = await call1c(name, params);
      return {
        content: [{
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        }]
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: `Ошибка: ${e.message}` }],
        isError: true
      };
    }
  });

  // Запуск на stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function mcpTool(name, description, properties, required) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {})
    }
  };
}
