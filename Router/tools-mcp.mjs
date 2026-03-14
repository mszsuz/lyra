#!/usr/bin/env node
// MCP server for lyra_* tools — spawned by Claude CLI via --mcp-config
//
// Reads JSON-RPC from stdin, sends tool calls to Router via HTTP,
// returns results to Claude via stdout.
// Zero dependencies — Node.js 22+

import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROUTER_URL = process.env.LYRA_TOOLS_URL;
const SESSION_ID = process.env.LYRA_SESSION_ID;
const CONFIG_NAME = process.env.LYRA_CONFIG_NAME || '';
const USER_ID = process.env.LYRA_USER_ID || '';
const NAPARNIK_TOKEN = process.env.LYRA_NAPARNIK_TOKEN || '';
const NAPARNIK_BASE_URL = 'https://code.1c.ai';
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

    // Напарник — handle locally (direct API call to code.1c.ai)
    if (toolName === 'lyra_ask_naparnik') {
      try {
        const result = await askNaparnik(toolArgs.question);
        respond(id, { content: [{ type: 'text', text: result }] });
      } catch (err) {
        respond(id, { content: [{ type: 'text', text: err.message }], isError: true });
      }
      return;
    }

    // Memory tools — handle locally (no HTTP roundtrip)
    if (toolName.startsWith('lyra_memory_')) {
      try {
        const result = handleMemoryTool(toolName, toolArgs);
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

// --- Memory tools (local filesystem) ---
// Общая память: Router/memory/<config>/  (read-only для пользователей)
// Личная память: Router/.users/<user_id>/memory/<config>/  (read-write)

function globalMemoryDir() {
  if (!CONFIG_NAME) throw new Error('Конфигурация не определена — память недоступна');
  return resolve(__dirname, 'memory', CONFIG_NAME);
}

function userMemoryDir() {
  if (!CONFIG_NAME) throw new Error('Конфигурация не определена — память недоступна');
  if (!USER_ID) throw new Error('Пользователь не определён — память недоступна');
  const dir = resolve(__dirname, '.users', USER_ID, 'memory', CONFIG_NAME);
  mkdirSync(resolve(dir, 'skills'), { recursive: true });
  return dir;
}

function readRegistry(dir) {
  const p = resolve(dir, 'registry.md');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8').trim();
}

function handleMemoryTool(toolName, args) {
  if (toolName === 'lyra_memory_list') {
    const globalReg = readRegistry(globalMemoryDir());
    let userReg = '';
    try { userReg = readRegistry(userMemoryDir()); } catch {}

    const parts = [];
    if (globalReg) parts.push('## Общая база знаний\n' + globalReg);
    if (userReg) parts.push('## Мои знания\n' + userReg);
    if (!parts.length) return 'Память пуста — знаний по этой конфигурации ещё нет.';
    return parts.join('\n\n');
  }

  if (toolName === 'lyra_memory_read') {
    const name = args.name;
    if (!name) throw new Error('Не указано имя знания');

    // Общее + пользовательское (пользовательское переопределяет общее)
    const parts = [];

    const globalPath = resolve(globalMemoryDir(), 'skills', `${name}.md`);
    if (existsSync(globalPath)) parts.push(readFileSync(globalPath, 'utf-8'));

    try {
      const userPath = resolve(userMemoryDir(), 'skills', `${name}.md`);
      if (existsSync(userPath)) parts.push('---\n## Пользовательские дополнения\n' + readFileSync(userPath, 'utf-8'));
    } catch {}

    if (!parts.length) throw new Error(`Знание "${name}" не найдено`);
    return parts.join('\n\n');
  }

  if (toolName === 'lyra_memory_save') {
    const { name, description, content } = args;
    if (!name || !description || !content) throw new Error('Необходимы name, description и content');
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && !/^[a-z0-9]$/.test(name)) {
      throw new Error('Имя должно содержать только латинские буквы, цифры и дефисы (например: debitorka-query)');
    }

    // Сохраняем только в личную папку
    const dir = userMemoryDir();
    const skillPath = resolve(dir, 'skills', `${name}.md`);
    writeFileSync(skillPath, content, 'utf-8');
    updateRegistry(dir, name, description);

    log(`memory saved: ${USER_ID}/${CONFIG_NAME}/${name} (${content.length} chars)`);
    return `Знание "${name}" сохранено в вашу личную базу. Доступно в будущих сессиях для конфигурации ${CONFIG_NAME}.`;
  }

  throw new Error(`Неизвестный инструмент памяти: ${toolName}`);
}

function updateRegistry(dir, name, description) {
  const registryPath = resolve(dir, 'registry.md');
  let lines = [];

  if (existsSync(registryPath)) {
    lines = readFileSync(registryPath, 'utf-8').split('\n').filter(l => l.trim() !== '');
  }

  const prefix = `- **${name}** — `;
  const newLine = `${prefix}${description}`;
  const idx = lines.findIndex(l => l.startsWith(prefix));

  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    lines.push(newLine);
  }

  writeFileSync(registryPath, lines.join('\n') + '\n', 'utf-8');
}

// --- Напарник (code.1c.ai) ---

async function askNaparnik(question) {
  if (!NAPARNIK_TOKEN) throw new Error('Токен Напарника не настроен (LYRA_NAPARNIK_TOKEN)');
  if (!question) throw new Error('Не указан вопрос');

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': NAPARNIK_TOKEN,
  };

  // 1. Создать сессию
  const sessionRes = await fetch(`${NAPARNIK_BASE_URL}/chat_api/v1/conversations/`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ skill_name: 'raw', is_chat: true }),
  });
  if (!sessionRes.ok) {
    const text = await sessionRes.text();
    throw new Error(`Напарник: ошибка создания сессии (${sessionRes.status}): ${text}`);
  }
  const session = await sessionRes.json();
  const sessionId = session.uuid;
  log(`naparnik session: ${sessionId}`);

  // 2. Отправить вопрос (SSE response)
  const msgRes = await fetch(`${NAPARNIK_BASE_URL}/chat_api/v1/conversations/${sessionId}/messages`, {
    method: 'POST',
    headers: { ...headers, 'Accept': 'text/event-stream' },
    body: JSON.stringify({
      role: 'user',
      content: { content: { instruction: question } },
      parent_uuid: null,
    }),
  });
  if (!msgRes.ok) {
    const text = await msgRes.text();
    throw new Error(`Напарник: ошибка отправки (${msgRes.status}): ${text}`);
  }

  // 3. Парсить SSE
  const sseText = await msgRes.text();
  const result = parseSseResponse(sseText);
  log(`naparnik response: ${result.length} chars`);
  return result;
}

function parseSseResponse(sseText) {
  const chunks = [];
  for (const line of sseText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const dataStr = trimmed.slice(5).trim();
    if (dataStr === '[DONE]') break;
    try {
      const data = JSON.parse(dataStr);
      // content_delta format
      if (data.content_delta?.content) {
        chunks.push(data.content_delta.content);
      }
      // OpenAI-like choices format
      else if (data.choices?.[0]?.delta?.content) {
        chunks.push(data.choices[0].delta.content);
      }
    } catch { /* skip non-JSON lines */ }
  }
  const text = chunks.join('');
  // Удалить <thinking>/<think> теги
  return text.replace(/<\/?thinking>/g, '').replace(/<\/?think>/g, '').trim();
}

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
