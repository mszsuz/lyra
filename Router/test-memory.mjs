#!/usr/bin/env node
// Test memory tools (lyra_memory_list/read/save)
// Run: node test-memory.mjs

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_NAME = 'TestConfig';
const testDir = resolve(__dirname, 'memory', CONFIG_NAME);

// --- Functions copied from tools-mcp.mjs logic ---

function memoryDir() {
  const dir = resolve(__dirname, 'memory', CONFIG_NAME);
  mkdirSync(resolve(dir, 'skills'), { recursive: true });
  return dir;
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
  if (idx >= 0) { lines[idx] = newLine; } else { lines.push(newLine); }
  writeFileSync(registryPath, lines.join('\n') + '\n', 'utf-8');
}

// --- Cleanup ---
if (existsSync(testDir)) rmSync(testDir, { recursive: true });

// --- Tests ---
let passed = 0;
let failed = 0;

function test(name, condition) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failed++;
  }
}

console.log('Memory tools tests\n');

// Test 1: list on empty config
const dir = memoryDir();
const registryPath = resolve(dir, 'registry.md');
test('list empty — no registry.md', !existsSync(registryPath));

// Test 2: save first skill
const skillContent = '# Дебиторка\n\nЗапрос дебиторской задолженности:\n```\nВЫБРАТЬ ... ИЗ РегистрБухгалтерии.Хозрасчетный.Остатки\n```';
writeFileSync(resolve(dir, 'skills', 'debitorka-query.md'), skillContent, 'utf-8');
updateRegistry(dir, 'debitorka-query', 'Запрос дебиторской задолженности по контрагентам');
test('save — skill file created', existsSync(resolve(dir, 'skills', 'debitorka-query.md')));

// Test 3: registry content
const registry = readFileSync(registryPath, 'utf-8');
test('registry — contains skill name', registry.includes('debitorka-query'));
test('registry — contains description', registry.includes('дебиторской'));
console.log(`    registry.md: ${registry.trim()}`);

// Test 4: read skill
const skill = readFileSync(resolve(dir, 'skills', 'debitorka-query.md'), 'utf-8');
test('read — contains content', skill.includes('Дебиторка') && skill.includes('ВЫБРАТЬ'));

// Test 5: save second skill
writeFileSync(resolve(dir, 'skills', 'ostatki-tovarov.md'), '# Остатки товаров\n\nЗапрос остатков на складах...', 'utf-8');
updateRegistry(dir, 'ostatki-tovarov', 'Остатки товаров на складах');
const registry2 = readFileSync(registryPath, 'utf-8');
const lines2 = registry2.trim().split('\n');
test('two skills — registry has 2 lines', lines2.length === 2);
console.log(`    registry.md:\n      ${lines2.join('\n      ')}`);

// Test 6: update existing skill description
updateRegistry(dir, 'debitorka-query', 'Обновлённое описание дебиторки');
const registry3 = readFileSync(registryPath, 'utf-8');
const lines3 = registry3.trim().split('\n');
test('update — still 2 lines', lines3.length === 2);
test('update — new description', registry3.includes('Обновлённое'));
test('update — old description gone', !registry3.includes('Запрос дебиторской'));

// Test 7: name validation regex
const nameRegex = (n) => /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(n) || /^[a-z0-9]$/.test(n);
test('valid name: a', nameRegex('a'));
test('valid name: debitorka-query', nameRegex('debitorka-query'));
test('valid name: test123', nameRegex('test123'));
test('invalid name: -bad', !nameRegex('-bad'));
test('invalid name: bad-', !nameRegex('bad-'));
test('invalid name: BAD', !nameRegex('BAD'));
test('invalid name: has space', !nameRegex('has space'));

// Test 8: renderSystemPrompt integration
import { loadProfile, renderSystemPrompt } from './profiles.mjs';
const profile = loadProfile('profiles/default');
const session = { configName: CONFIG_NAME, configVersion: '1.0', computer: 'TEST', configId: 'test-id' };
const prompt = renderSystemPrompt(profile.systemPromptTemplate, session, profile);
test('prompt — contains memory registry', prompt.includes('debitorka-query'));
test('prompt — contains Реестр знаний', prompt.includes('Реестр знаний'));

// Cleanup
rmSync(testDir, { recursive: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
