// Profile loader — reads model.json, system-prompt.md, tools.json, vega.json

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as log from './log.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG = 'profiles';

function readJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8').replace(/^\uFEFF/, ''));
}

export function loadProfile(profilePath) {
  const dir = resolve(__dirname, profilePath);
  const profile = {
    model: 'sonnet',
    allowedTools: [],
    systemPromptTemplate: '',
    clientTools: [],
    vegaConfig: null,
  };

  // model.json
  const modelPath = resolve(dir, 'model.json');
  if (existsSync(modelPath)) {
    const m = readJSON(modelPath);
    profile.model = m.model || profile.model;
    profile.mode = m.mode || 'user';
    profile.allowedTools = m.allowedTools || [];
    log.info(TAG, `model: ${profile.model}, tools: ${profile.allowedTools.join(', ')}`);
  }

  // system-prompt.md
  const promptPath = resolve(dir, 'system-prompt.md');
  if (existsSync(promptPath)) {
    profile.systemPromptTemplate = readFileSync(promptPath, 'utf-8');
    log.info(TAG, `system prompt loaded (${profile.systemPromptTemplate.length} chars)`);
  }

  // tools.json
  const toolsPath = resolve(dir, 'tools.json');
  if (existsSync(toolsPath)) {
    const t = readJSON(toolsPath);
    profile.clientTools = t.tools || t;
    log.info(TAG, `client tools: ${profile.clientTools.map(t => t.name).join(', ')}`);
  }

  // vega.json
  const vegaPath = resolve(dir, 'vega.json');
  if (existsSync(vegaPath)) {
    profile.vegaConfig = readJSON(vegaPath);
    log.info(TAG, `vega config loaded (${Object.keys(profile.vegaConfig.configs || {}).length} configs)`);
  }

  // tool-labels.json — human-readable descriptions for client UI
  const labelsPath = resolve(dir, 'tool-labels.json');
  if (existsSync(labelsPath)) {
    profile.toolLabels = readJSON(labelsPath);
    log.info(TAG, `tool labels loaded (${Object.keys(profile.toolLabels).length} tools)`);
  } else {
    profile.toolLabels = {};
  }

  return profile;
}

export function renderSystemPrompt(template, session, profile) {
  // Переменные шаблона
  // Определяем, подключена ли Vega к этой конфигурации
  const vegaConnected = profile?.vegaConfig?.configs?.[session.configName] ? session.configName : '';

  const now = new Date();
  const текущаяДата = now.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long', day: 'numeric' });

  const vars = {
    'ТекущаяДата': текущаяДата,
    'ИмяКонфигурации': session.configName || '',
    'ВерсияКонфигурации': session.configVersion || '',
    'Компьютер': session.computer || '',
    'ИдентификаторКонфигурации': session.configId || '',
    'Режим': profile?.mode || 'user',
    'VegaКонфигурация': vegaConnected,
  };

  let result = template;

  // {{ Переменная }} → значение ([\p{L}\w]+ для поддержки кириллицы)
  result = result.replace(/\{\{\s*([\p{L}\w]+)\s*\}\}/gu, (_, name) => vars[name] ?? '');

  // {% Если Переменная = "значение" Тогда %}...{% Иначе %}...{% КонецЕсли; %}
  // Обрабатываем итеративно от внутренних к внешним (без вложенных Если внутри body)
  const ifPattern = /\{%\s*Если\s+([\p{L}\w]+)\s*(=|<>)\s*"([^"]*)"\s*Тогда\s*%\}((?:(?!\{%\s*Если)[\s\S])*?)\{%\s*КонецЕсли;\s*%\}/u;
  let safety = 20;
  while (ifPattern.test(result) && safety-- > 0) {
    result = result.replace(ifPattern, (_, varName, op, val, body) => {
      const actual = vars[varName] ?? '';
      const match = op === '=' ? actual === val : actual !== val;

      const elseParts = body.split(/\{%\s*Иначе\s*%\}/);
      const ifBlock = elseParts[0] || '';
      const elseBlock = elseParts[1] || '';

      return match ? ifBlock.trim() : elseBlock.trim();
    });
  }

  return result.trim();
}

export function buildMcpConfig(profile, session, toolsPort) {
  const mcpServers = {};

  // 1c tools (via tools-mcp.mjs → HTTP → Router)
  if (profile.clientTools.length > 0) {
    mcpServers['1c'] = {
      command: 'node',
      args: [resolve(__dirname, 'tools-mcp.mjs')],
      env: {
        LYRA_TOOLS_URL: `http://localhost:${toolsPort}/tool-call`,
        LYRA_SESSION_ID: session.sessionId,
      },
    };
  }

  // mcp-1c-docs (документация 1С)
  mcpServers['mcp-1c-docs'] = {
    type: 'http',
    url: 'http://localhost:6280/mcp',
  };

  // Vega MCP (HTTP, by config name)
  if (profile.vegaConfig && session.configName) {
    const vegaCfg = profile.vegaConfig;
    const mapping = vegaCfg.configs || {};
    const port = mapping[session.configName]?.port;
    if (port) {
      mcpServers['vega'] = {
        type: 'http',
        url: `http://localhost:${port}/mcp`,
        headers: vegaCfg.headers || { 'X-API-Key': 'vega' },
      };
      log.info(TAG, `Vega MCP: ${session.configName} → port ${port}`);
    }
  }

  return { mcpServers };
}

export function writeTempFiles(session, profile, toolsPort) {
  const tmpDir = resolve(__dirname, '.tmp', session.sessionId);
  mkdirSync(tmpDir, { recursive: true });

  // System prompt
  const promptContent = renderSystemPrompt(profile.systemPromptTemplate, session, profile);
  const promptPath = resolve(tmpDir, 'system-prompt.md');
  writeFileSync(promptPath, promptContent, 'utf-8');

  // MCP config
  const mcpConfig = buildMcpConfig(profile, session, toolsPort);
  const mcpConfigPath = resolve(tmpDir, 'mcp-config.json');
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf-8');

  return { promptPath, mcpConfigPath, tmpDir };
}
