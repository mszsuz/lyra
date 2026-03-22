// Adapter loader — creates adapter instance by name

import { ClaudeApiAdapter } from './claude-api.mjs';
import { ClaudeCliAdapter } from './claude-cli.mjs';
import { OpenAiAdapter } from './openai.mjs';
import { CodexCliAdapter } from './codex-cli.mjs';

const ADAPTERS = {
  'claude-api': ClaudeApiAdapter,
  'claude-cli': ClaudeCliAdapter,
  'openai': OpenAiAdapter,
  'codex-cli': CodexCliAdapter,
};

/**
 * Create adapter instance by name.
 * @param {string} name — adapter name from config
 * @param {object} config — adapter-specific configuration
 * @returns {{ adapter, capabilities }} — initialized adapter + capabilities
 */
export async function createAdapter(name, config = {}) {
  const AdapterClass = ADAPTERS[name];
  if (!AdapterClass) {
    throw new Error(`Unknown adapter: "${name}". Available: ${Object.keys(ADAPTERS).join(', ')}`);
  }

  const adapter = new AdapterClass();
  const capabilities = await adapter.init(config);

  return { adapter, capabilities };
}
