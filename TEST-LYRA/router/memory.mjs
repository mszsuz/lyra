// Memory tools — local filesystem, shared between CLI (tools-mcp.mjs) and API adapter (server.mjs)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DATA_DIR = process.env.LYRA_DATA_DIR || import.meta.dirname;

function globalMemoryDir(configName) {
  if (!configName) throw new Error('Конфигурация не определена — память недоступна');
  return resolve(DATA_DIR, 'memory', configName);
}

function userMemoryDir(configName, userId) {
  if (!configName) throw new Error('Конфигурация не определена — память недоступна');
  if (!userId) throw new Error('Пользователь не определён — память недоступна');
  const dir = resolve(DATA_DIR, 'users', userId, 'memory', configName);
  mkdirSync(resolve(dir, 'skills'), { recursive: true });
  return dir;
}

function readRegistry(dir) {
  const p = resolve(dir, 'registry.md');
  if (!existsSync(p)) return '';
  return readFileSync(p, 'utf-8').trim();
}

function validateName(name) {
  if (!name) throw new Error('Не указано имя знания');
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) && !/^[a-z0-9]$/.test(name)) {
    throw new Error('Имя знания должно содержать только латинские буквы, цифры и дефисы');
  }
}

function updateRegistry(dir, name, description, dbName) {
  const registryPath = resolve(dir, 'registry.md');
  let lines = [];
  if (existsSync(registryPath)) {
    lines = readFileSync(registryPath, 'utf-8').split('\n').filter(l => l.trim() !== '');
  }
  const prefix = `- **${name}** — `;
  const dbSuffix = dbName ? ` [${dbName}]` : '';
  const newLine = `${prefix}${description}${dbSuffix}`;
  const idx = lines.findIndex(l => l.startsWith(prefix));
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    lines.push(newLine);
  }
  writeFileSync(registryPath, lines.join('\n') + '\n', 'utf-8');
}

export function handleMemoryTool(toolName, args, ctx) {
  const { configName, userId, dbId, dbName } = ctx;

  if (toolName === 'lyra_memory_list') {
    const globalReg = readRegistry(globalMemoryDir(configName));
    let userReg = '';
    try { userReg = readRegistry(userMemoryDir(configName, userId)); } catch {}
    const parts = [];
    if (globalReg) parts.push('## Общая база знаний\n' + globalReg);
    if (userReg) parts.push('## Мои знания\n' + userReg);
    if (!parts.length) return 'Память пуста — знаний по этой конфигурации ещё нет.';
    return parts.join('\n\n');
  }

  if (toolName === 'lyra_memory_read') {
    const name = args.name;
    validateName(name);
    const parts = [];
    const globalPath = resolve(globalMemoryDir(configName), 'skills', `${name}.md`);
    if (existsSync(globalPath)) parts.push(readFileSync(globalPath, 'utf-8'));
    try {
      const userPath = resolve(userMemoryDir(configName, userId), 'skills', `${name}.md`);
      if (existsSync(userPath)) parts.push('---\n## Пользовательские дополнения\n' + readFileSync(userPath, 'utf-8'));
    } catch {}
    if (!parts.length) throw new Error(`Знание "${name}" не найдено`);
    return parts.join('\n\n');
  }

  if (toolName === 'lyra_memory_save') {
    const { name, description, content } = args;
    if (!name || !description || !content) throw new Error('Необходимы name, description и content');
    validateName(name);
    const dir = userMemoryDir(configName, userId);
    const skillPath = resolve(dir, 'skills', `${name}.md`);
    const meta = `---\ndb_id: ${dbId || 'unknown'}\ndb_name: ${dbName || 'unknown'}\nsaved: ${new Date().toISOString()}\n---\n\n`;
    writeFileSync(skillPath, meta + content, 'utf-8');
    updateRegistry(dir, name, description, dbName);
    return `Знание "${name}" сохранено.`;
  }

  throw new Error(`Неизвестный инструмент памяти: ${toolName}`);
}
