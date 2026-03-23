// Configuration loader
// Reads config.json from Router directory, falls back to centrifugo/config.json for secrets

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from project root (zero-dependency)
function loadEnv() {
  const envPath = resolve(__dirname, '..', '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val; // don't override existing
  }
}

loadEnv();

function loadJSON(path) {
  return JSON.parse(readFileSync(path, 'utf-8').replace(/^\uFEFF/, ''));
}

export function loadConfig() {
  // Try Router/config.json first
  let raw;
  try {
    raw = loadJSON(resolve(__dirname, 'config.json'));
  } catch {
    raw = {};
  }

  // Load centrifugo config for secrets — from dataDir/centrifugo/config.json
  const dataDir = resolve(__dirname, raw.dataDir || '.');
  let centrifugoConfig = {};
  try {
    centrifugoConfig = loadJSON(resolve(dataDir, 'centrifugo', 'config.json'));
  } catch { /* optional */ }

  const config = {
    centrifugo: {
      wsUrl: raw.centrifugo?.wsUrl || 'ws://localhost:11000/connection/websocket',
      apiUrl: raw.centrifugo?.apiUrl || 'http://localhost:11000/api',
      hmacSecret: raw.centrifugo?.hmacSecret || centrifugoConfig?.client?.token?.hmac_secret_key || '',
      apiKey: raw.centrifugo?.apiKey || centrifugoConfig?.http_api?.key || '',
    },
    naparnik: {
      url: raw.naparnik?.url || 'http://localhost:8000/mcp',
      token: raw.naparnik?.token || process.env.ONEC_AI_TOKEN || '',
    },
    claude: {
      path: raw.claude?.path || process.env.CLAUDE_PATH || 'claude',
      model: raw.claude?.model || 'sonnet',
    },
    toolCallTimeout: typeof raw.toolCallTimeout === 'object'
      ? { default: 30_000, ...raw.toolCallTimeout }
      : { default: raw.toolCallTimeout || 30_000 },
    toolsPort: raw.toolsPort || 0,
    profilePath: raw.profilePath || './profiles/default',
    logLevel: raw.logLevel || 'info',
    sessionTTL: raw.sessionTTL || 30 * 60 * 1000, // 30 min
    rag: {
      enabled: raw.rag?.enabled ?? false,
      model: raw.rag?.model || 'google/gemini-2.0-flash-lite-001',
      base_url: raw.rag?.base_url || raw.adapters?.openai?.base_url || 'https://openrouter.ai/api/v1',
      api_key: raw.rag?.api_key || raw.adapters?.openai?.api_key || process.env.OPENROUTER_API_KEY || '',
      timeout: raw.rag?.timeout || 3000,
    },
    adapters: raw.adapters || {},
    dataDir,
  };

  // Expose dataDir for child modules and spawned processes (tools-mcp.mjs)
  process.env.LYRA_DATA_DIR = config.dataDir;

  return config;
}
