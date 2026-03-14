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

function memoryDir() {
  if (!CONFIG_NAME) throw new Error('Конфигурация не определена — память недоступна');
  const dir = resolve(__dirname, 'memory', CONFIG_NAME);
  mkdirSync(resolve(dir, 'skills'), { recursive: true });
  return dir;
}

function handleMemoryTool(toolName, args) {
  if (toolName === 'lyra_memory_list') {
    const dir = memoryDir();
    const registryPath = resolve(dir, 'registry.md');
    if (!existsSync(registryPath)) return 'Память пуста — знаний по этой конфигурации ещё нет.';
    return readFileSync(registryPath, 'utf-8');
  }

  if (toolName === 'lyra_memory_read') {
    const name = args.name;
    if (!name) throw new Error('Не указано имя знания');
    const dir = memoryDir();
    const skillPath = resolve(dir, 'skills', `${name}.md`);
    if (!existsSync(skillPath)) throw new Error(`Знание "${name}" не найдено`);
    return readFileSync(skillPath, 'utf-8');
  }

  if (toolName === 'lyra_memory_save') {
    const { name, description, content } = args;
    if (!name || !description || !content) throw new Error('Необходимы name, description и content');
    // Validate name (latin, digits, hyphens only)
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && !/^[a-z0-9]$/.test(name)) {
      throw new Error('Имя должно содержать только латинские буквы, цифры и дефисы (например: debitorka-query)');
    }

    const dir = memoryDir();
    const skillPath = resolve(dir, 'skills', `${name}.md`);
    writeFileSync(skillPath, content, 'utf-8');

    // Update registry
    updateRegistry(dir, name, description);

    log(`memory saved: ${name} (${content.length} chars)`);
    return `Знание "${name}" сохранено. Будет доступно во всех будущих сессиях для конфигурации ${CONFIG_NAME}.`;
  }

  throw new Error(`Неизвестный инструмент памяти: ${toolName}`);
}

function updateRegistry(dir, name, description) {
  const registryPath = resolve(dir, 'registry.md');
  let lines = [];

  if (existsSync(registryPath)) {
    lines = readFileSync(registryPath, 'utf-8').split('\n').filter(l => l.trim() !== '');
  }

  // Find existing entry and replace, or append
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
