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

  return profile;
}

export function renderSystemPrompt(template, session) {
  let result = template;
  result = result.replace(/\{\{\s*ИмяКонфигурации\s*\}\}/g, session.configName);
  result = result.replace(/\{\{\s*ВерсияКонфигурации\s*\}\}/g, session.configVersion);
  result = result.replace(/\{\{\s*Компьютер\s*\}\}/g, session.computer);
  result = result.replace(/\{\{\s*ИдентификаторКонфигурации\s*\}\}/g, session.configId);

  // {% Если ИдентификаторКонфигурации <> "" Тогда %} ... {% КонецЕсли; %}
  result = result.replace(
    /\{%\s*Если\s+ИдентификаторКонфигурации\s*<>\s*""\s*Тогда\s*%\}([\s\S]*?)\{%\s*КонецЕсли;\s*%\}/g,
    (_, content) => session.configId ? content : '',
  );

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
  const promptContent = renderSystemPrompt(profile.systemPromptTemplate, session);
  const promptPath = resolve(tmpDir, 'system-prompt.md');
  writeFileSync(promptPath, promptContent, 'utf-8');

  // MCP config
  const mcpConfig = buildMcpConfig(profile, session, toolsPort);
  const mcpConfigPath = resolve(tmpDir, 'mcp-config.json');
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig), 'utf-8');

  return { promptPath, mcpConfigPath, tmpDir };
}
