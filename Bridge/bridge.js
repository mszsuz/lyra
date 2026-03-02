#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  runMcpRelay(sessionId);
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
    const type   = p.get('type');                      // 'mcp' или null (=1С)
    const sid    = p.get('session');                    // session ID (для mcp)
    const resume = req.headers['claude-resume'];       // resume существующей сессии Claude
    const newSid = req.headers['claude-session-id'];   // новая сессия с заданным ID
    const model  = req.headers['claude-model'];         // модель (sonnet, opus, haiku)

    if (type === 'mcp' && sid) {
      onMcpConnect(ws, sid, sessions);
    } else {
      on1cConnect(ws, resume || newSid || null, !!resume, model, sessions, logDir);
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

function on1cConnect(ws, sid, isResume, model, sessions, logDir) {
  sid = sid || randomUUID();
  let s = sessions.get(sid);

  if (s) {
    // Переподключение к существующей сессии bridge
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
      resume: isResume,
      model: model || null,
      streaming: false,
      pendingMessage: null,
      log(msg) {
        const line = `[${ts()}] ${msg}`;
        console.log(line);
        fs.appendFileSync(logFile, line + '\n');
      }
    };
    sessions.set(sid, s);
    s.log(isResume ? 'resume session' : 'new session');
  }

  // Отправляем 1С её session ID
  wsSend(ws, { type: 'session', sessionId: sid });

  // Claude запускается только после получения hello от 1С

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      s.log(`1С → ${String(raw).slice(0, 500)}`);

      if (msg.type === 'hello') {
        // 1С передаёт свои инструменты и внешние MCP-серверы
        s.tools = msg.tools || [];
        s.mcpServers = msg.mcpServers || {};
        s.systemPrompt = msg.systemPrompt || null;
        s.log(`hello: tools=[${s.tools.join(',')}] mcpServers=[${Object.keys(s.mcpServers).join(',')}]`);
        wsSend(ws, { type: 'hello_ack' });
        if (!s.claude) spawnClaude(s);
      } else if (msg.type === 'chat') {
        if (s.streaming) {
          // Прерываем текущий стрим: SIGINT + ставим сообщение в очередь
          s.pendingMessage = msg.content;
          s.log('interrupting stream, sending SIGINT');
          if (s.claude) s.claude.kill('SIGINT');
        } else {
          // Обычная отправка
          s.streaming = true;
          writeToClaudeStdin(s, {
            type: 'user',
            message: { role: 'user', content: msg.content }
          });
        }
      } else if (msg.type === 'mcp_jsonrpc') {
        // JSON-RPC ответ 1С → MCP relay → stdout → Claude
        if (s.wsMcp) wsSend(s.wsMcp, msg.data, true);
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
    const line = String(raw);
    s.log(`MCP → ${line.slice(0, 300)}`);

    // Оборачиваем JSON-RPC в конверт и пересылаем 1С
    if (s.ws1c) {
      wsSend(s.ws1c, { type: 'mcp_jsonrpc', data: line });
    }
  });

  ws.on('close', () => {
    s.log('MCP client disconnected');
    s.wsMcp = null;
  });
}


// ─── Поиск папки проекта по session ID ──────────────────────

function findProjectDir(sessionId) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  for (const dir of fs.readdirSync(projectsDir)) {
    const sessionFile = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(sessionFile)) {
      // C--WORKS-2026-01-31-Lyra-Bridge → C:\WORKS\2026-01-31 Lyra\Bridge
      const projectPath = dir.replace(/^([A-Z])-/, '$1:').replace(/-/g, path.sep);
      // Проверяем что папка существует — берём с учётом что дефисы могли быть пробелами
      if (fs.existsSync(projectPath)) return projectPath;
      // Пробуем с пробелами вместо разделителей (Claude кодирует пробелы как -)
      // Перебираем варианты восстановления пути
      const parts = dir.split('-');
      // Первая часть — диск (C)
      const drive = parts[0] + ':';
      const rest = parts.slice(1).join('-');
      // Ищем реальную папку по частичному совпадению
      const candidate = findRealPath(drive, rest);
      if (candidate) return candidate;
    }
  }
  return null;
}

function findRealPath(drive, encodedRest) {
  // encoded dir = "C--WORKS-2026-01-31-Lyra-Bridge" → drive="C:", rest="-WORKS-..."
  // Убираем ведущие дефисы (от двойного -- после буквы диска)
  const clean = encodedRest.replace(/^-+/, '');
  return matchPath(drive + path.sep, clean);
}

function matchPath(base, remaining) {
  if (!remaining) return fs.existsSync(base) ? base : null;
  if (!fs.existsSync(base)) return null;

  let entries;
  try { entries = fs.readdirSync(base); } catch { return null; }

  for (const entry of entries) {
    // Кодируем имя записи так же, как Claude: спецсимволы → дефис
    const encoded = entry.replace(/[^a-zA-Z0-9._-]/g, '-');
    if (remaining.startsWith(encoded)) {
      const rest = remaining.slice(encoded.length);
      if (rest === '') {
        return path.join(base, entry);
      }
      if (rest.startsWith('-')) {
        const result = matchPath(path.join(base, entry), rest.slice(1));
        if (result) return result;
      }
    }
  }
  return null;
}


// ─── Запуск Claude Code ─────────────────────────────────────

function spawnClaude(s) {
  // MCP-конфиг: 1c relay + внешние серверы из hello
  const mcpServers = {
    '1c': {
      command: 'node',
      args: [
        path.resolve(__dirname, 'bridge.js'),
        '--mcp', '--session', s.id,
        '--port', String(PORT)
      ]
    }
  };

  // Внешние MCP-серверы от 1С (vega и др.)
  const externalServers = s.mcpServers || {};
  for (const [name, config] of Object.entries(externalServers)) {
    mcpServers[name] = config;
  }

  const mcpConfig = JSON.stringify({ mcpServers });

  // Все инструменты разрешены (pipe-режим, нет терминала для подтверждений)

  const defaultPrompt =
    'Ты AI-помощник, подключённый к базе 1С:Предприятие. ' +
    'Используй MCP-инструменты для работы с базой. ' +
    'Язык запросов 1С это НЕ SQL (ВЫБРАТЬ, ИЗ, ГДЕ, а не SELECT FROM WHERE). ' +
    'Даты в запросах: ДАТАВРЕМЯ(2025,1,1). Отвечай на русском.';

  const systemPrompt = s.systemPrompt || defaultPrompt;

  // Для resume — ищем папку проекта по session ID
  let projectDir = null;
  if (s.resume) {
    projectDir = findProjectDir(s.id);
    if (projectDir) s.log(`resume: project dir: ${projectDir}`);
    else s.log(`resume: project dir not found for ${s.id}, starting new`);
  }

  const claudeArgs = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--disable-slash-commands',
    s.resume && projectDir ? '--resume' : '--session-id', s.id,
    ...(s.model ? ['--model', s.model] : []),
    '--mcp-config', mcpConfig,
    '--system-prompt', systemPrompt,
    '--dangerously-skip-permissions',
    '--settings', JSON.stringify({ disableAllHooks: true }),
  ];

  s.log(`spawn claude`);

  // Убираем CLAUDECODE из окружения, чтобы вложенный Claude не отказался запускаться
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const cp = spawn('claude', claudeArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: projectDir || undefined
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

      // Отслеживаем конец стрима для отправки отложенного сообщения
      try {
        const ev = JSON.parse(line);
        if (ev.type === 'result') {
          s.streaming = false;
          if (s.pendingMessage) {
            const content = s.pendingMessage;
            s.pendingMessage = null;
            s.log(`sending pending message: ${content.slice(0, 100)}`);
            s.streaming = true;
            writeToClaudeStdin(s, {
              type: 'user',
              message: { role: 'user', content: content }
            });
          }
        }
      } catch (_) { /* не JSON — пропускаем */ }
    }
  });

  cp.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) s.log(`claude stderr: ${text.slice(0, 300)}`);
  });

  cp.on('exit', (code) => {
    s.log(`claude exit code=${code}`);
    s.claude = null;
    s.streaming = false;

    if (s.pendingMessage) {
      // SIGINT убил процесс (Windows) — перезапускаем с --resume
      const content = s.pendingMessage;
      s.pendingMessage = null;
      s.log(`respawning claude for pending message: ${content.slice(0, 100)}`);
      s.resume = true;  // следующий spawn будет с --resume
      spawnClaude(s);
      // Отправляем отложенное сообщение после небольшой задержки (ждём готовности stdin)
      setTimeout(() => {
        s.streaming = true;
        writeToClaudeStdin(s, {
          type: 'user',
          message: { role: 'user', content: content }
        });
      }, 500);
    } else {
      if (s.ws1c) wsSend(s.ws1c, { type: 'claude_exit', code });
    }
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
//  MCP РЕЖИМ (relay)
//  stdin ↔ WebSocket relay (для Claude)
//  Запускается как: node bridge.js --mcp --session <id>
//  JSON-RPC обрабатывается в 1С, bridge только пересылает
// ═════════════════════════════════════════════════════════════

function runMcpRelay(sessionId) {
  const ws = new WebSocket(`ws://localhost:${PORT}/?type=mcp&session=${sessionId}`);

  ws.on('open', () => {
    // stdin → WebSocket (построчно)
    let buf = '';
    process.stdin.on('data', chunk => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.trim()) ws.send(line);
      }
    });
  });

  // WebSocket → stdout
  // 1С возвращает pretty-printed JSON (с \r\n) — компактируем до одной строки (NDJSON)
  ws.on('message', raw => {
    const compact = String(raw).replace(/\r?\n/g, '');
    process.stdout.write(compact + '\n');
  });

  ws.on('close', () => process.exit(0));
  ws.on('error', () => process.exit(1));
}
