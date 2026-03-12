// Configuration loader
// Reads config.json from Router directory, falls back to centrifugo/config.json for secrets

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  // Load centrifugo config for secrets if not provided
  let centrifugoConfig = {};
  try {
    centrifugoConfig = loadJSON(resolve(__dirname, '..', 'centrifugo', 'config.json'));
  } catch { /* optional */ }

  const config = {
    centrifugo: {
      wsUrl: raw.centrifugo?.wsUrl || 'ws://localhost:11000/connection/websocket',
      apiUrl: raw.centrifugo?.apiUrl || 'http://localhost:11000/api',
      hmacSecret: raw.centrifugo?.hmacSecret || centrifugoConfig?.client?.token?.hmac_secret_key || '',
      apiKey: raw.centrifugo?.apiKey || centrifugoConfig?.http_api?.key || '',
    },
    claude: {
      path: raw.claude?.path || process.env.CLAUDE_PATH || 'claude',
      model: raw.claude?.model || 'sonnet',
    },
    toolsPort: raw.toolsPort || 0,
    profilePath: raw.profilePath || './profiles/default',
    logLevel: raw.logLevel || 'info',
    sessionTTL: raw.sessionTTL || 30 * 60 * 1000, // 30 min
  };

  return config;
}
