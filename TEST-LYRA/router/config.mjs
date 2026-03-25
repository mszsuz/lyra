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

/** Resolve "env:VAR_NAME" → process.env.VAR_NAME, otherwise return as-is */
function resolveEnv(value) {
  if (typeof value === 'string' && value.startsWith('env:')) {
    return process.env[value.slice(4)] || '';
  }
  return value || '';
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
      wsUrl: raw.centrifugo?.wsUrl || '',
      apiUrl: raw.centrifugo?.apiUrl || '',
      hmacSecret: raw.centrifugo?.hmacSecret || centrifugoConfig?.client?.token?.hmac_secret_key || '',
      apiKey: raw.centrifugo?.apiKey || centrifugoConfig?.http_api?.key || '',
    },
    naparnik: {
      url: raw.naparnik?.url || '',
      token: resolveEnv(raw.naparnik?.token),
    },
    claude: {
      path: raw.claude?.path || '',
      model: raw.claude?.model || '',
    },
    toolCallTimeout: typeof raw.toolCallTimeout === 'object'
      ? { default: 0, ...raw.toolCallTimeout }
      : { default: raw.toolCallTimeout || 0 },
    toolsPort: raw.toolsPort || 0,
    profilePath: raw.profilePath || '',
    logLevel: raw.logLevel || 'info',
    sessionTTL: raw.sessionTTL || 0,
    exchangeRate: raw.exchangeRate ?? 100,
    billingMultiplier: raw.billingMultiplier ?? 1,
    rag: {
      enabled: raw.rag?.enabled ?? false,
      model: raw.rag?.model || '',
      base_url: raw.rag?.base_url || '',
      api_key: resolveEnv(raw.rag?.api_key),
      timeout: raw.rag?.timeout || 0,
    },
    adapterTimeout: {
      chunkTimeout:   raw.adapterTimeout?.chunkTimeout   || 0,
      connectTimeout: raw.adapterTimeout?.connectTimeout  || 0,
      maxRetries:     raw.adapterTimeout?.maxRetries      ?? 0,
    },
    adapter: raw.adapter || '',
    adapterConfig: {
      base_url: raw.adapterConfig?.base_url || '',
      api_key: resolveEnv(raw.adapterConfig?.api_key),
      model: raw.adapterConfig?.model || '',
    },
    adapters: raw.adapters || {},
    dataDir,
  };

  // Expose dataDir for child modules and spawned processes (tools-mcp.mjs)
  process.env.LYRA_DATA_DIR = config.dataDir;

  return config;
}
