// RAG layer — finds relevant links from Vega/docs before sending user question to main model
// Free LLM translates user question to 1C terms → parallel MCP search → links as <rag> tag

import { callTool as mcpCallTool } from './mcp-client.mjs';
import * as log from './log.mjs';

const TAG = 'rag';

/**
 * Pre-initialize MCP sessions (handshake) so RAG calls are fast.
 * Call once at session start, fire-and-forget.
 */
export function warmup(mcpServers) {
  const servers = [mcpServers?.vega, mcpServers?.docs].filter(Boolean);
  for (const s of servers) {
    if (s === mcpServers.vega) {
      mcpCallTool(s.url, 'search_metadata', { query: JSON.stringify({ op: 'list_objects_by_name', name: '_warmup_', match: 'exact' }) }, s.headers)
        .then(() => log.info(TAG, `Warmup: vega ready`))
        .catch(e => log.warn(TAG, `Warmup vega failed: ${e.message}`));
    } else {
      mcpCallTool(s.url, 'list_libraries', {}, s.headers)
        .then(() => log.info(TAG, `Warmup: docs ready`))
        .catch(e => log.warn(TAG, `Warmup docs failed: ${e.message}`));
    }
  }
}

/**
 * Find relevant metadata/docs links for a user question.
 * Step 1: Free LLM extracts 1C-specific search terms from user question.
 * Step 2: Parallel search in Vega + docs MCP servers.
 * @param {string} question - User's question text
 * @param {object} mcpServers - { vega?: { url, headers }, docs?: { url, headers } }
 * @param {object} ragConfig - { model, base_url, api_key, timeout }
 * @param {string} configName - 1C configuration name
 * @returns {Promise<{ rag: string, ms: number } | null>}
 */
export async function findRelevantLinks(question, mcpServers, ragConfig, configName) {
  const start = Date.now();
  const timeout = ragConfig.timeout || 5000;

  // Step 1: LLM translates user question to 1C domain terms
  let keywords;
  try {
    keywords = await getKeywords(question, ragConfig, configName);
  } catch (err) {
    log.warn(TAG, `Keywords failed: ${err.message}`);
    return null;
  }
  if (!keywords) return null;

  log.info(TAG, `Keywords (${Date.now() - start}ms): meta="${keywords.metadata_query}", docs="${keywords.docs_query}"`);

  // Step 2: Parallel search in Vega + docs
  const searches = [];

  if (keywords.metadata_query && mcpServers?.vega) {
    searches.push(searchVega(mcpServers.vega, keywords.metadata_query, timeout));
  } else {
    searches.push(Promise.resolve(null));
  }

  if (keywords.docs_query && mcpServers?.docs) {
    searches.push(searchDocs(mcpServers.docs, keywords.docs_query, timeout, configName));
  } else {
    searches.push(Promise.resolve(null));
  }

  const [vegaResult, docsResult] = await Promise.allSettled(searches);

  const metaLinks = vegaResult.status === 'fulfilled' ? vegaResult.value : null;
  const docsLinks = docsResult.status === 'fulfilled' ? docsResult.value : null;

  if (!metaLinks && !docsLinks) {
    log.info(TAG, `No links found (${Date.now() - start}ms)`);
    return null;
  }

  // Build <rag> tag
  const parts = [];
  if (metaLinks) parts.push(`Метаданные: ${metaLinks}`);
  if (docsLinks) parts.push(`Документация: ${docsLinks}`);

  const rag = `<rag>\n${parts.join('\n')}\n</rag>`;
  const ms = Date.now() - start;

  log.info(TAG, `Enriched (${ms}ms): ${metaLinks ? 'meta' : '-'}/${docsLinks ? 'docs' : '-'}`);
  return { rag, ms };
}

/**
 * Call free LLM to translate user question into 1C search terms.
 */
async function getKeywords(question, ragConfig, configName) {
  const res = await withTimeout(
    fetch(`${ragConfig.base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ragConfig.api_key}`,
      },
      body: JSON.stringify({
        model: ragConfig.model,
        messages: [{
          role: 'user',
          content: `Ты — ассистент по 1С:Предприятие. Конфигурация: «${configName || 'неизвестная'}».
Подбери ключевые слова для поиска по вопросу пользователя.
1. metadata_query — описание на естественном языке для семантического поиска объектов метаданных (НЕ технические имена, а синонимы и описания: "приходный кассовый ордер", "цены номенклатуры")
2. docs_query — ключевые слова для поиска по документации языка 1С (методы, функции, свойства, типы)
Верни строго JSON: {"metadata_query": "...", "docs_query": "..."}

Вопрос: ${question}`,
        }],
        max_tokens: 200,
        temperature: 0,
      }),
    }),
    ragConfig.timeout,
  );

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';

  const match = content.match(/\{[^}]*"metadata_query"[^}]*\}/);
  if (!match) {
    log.warn(TAG, `Invalid keywords response: ${content.slice(0, 200)}`);
    return null;
  }

  return JSON.parse(match[0]);
}

/**
 * Search Vega for metadata objects by description.
 */
async function searchVega(vega, query, timeout) {
  try {
    const args = {
      query: JSON.stringify({ op: 'search_metadata_by_description', text: query }),
    };

    const result = await withTimeout(
      mcpCallTool(vega.url, 'search_metadata_by_description', args, vega.headers),
      timeout,
    );
    if (result.error) {
      log.warn(TAG, `Vega error: ${result.error}`);
      return null;
    }

    return parseVegaLinks(result);
  } catch (err) {
    log.warn(TAG, `Vega search failed: ${err.message}`);
    return null;
  }
}

// configName → docs library mapping (mirrors Vega config names)
const _CONFIG_TO_DOCS_LIBRARY = {
  'БухгалтерияПредприятия': '1c-config-accounting',
  'ЗарплатаИУправлениеПерсоналом': '1c-config-hrm',
  'УправлениеТорговлей': '1c-config-trade',
  'УправлениеПредприятием': '1c-config-enterprise20',
};

/**
 * Search docs for configuration-specific documentation.
 */
async function searchDocs(docs, query, timeout, configName) {
  const library = _CONFIG_TO_DOCS_LIBRARY[configName] || '1c-language-8.3.27';
  try {
    const args = { library, query };

    const result = await withTimeout(
      mcpCallTool(docs.url, 'search_docs', args, docs.headers),
      timeout,
    );
    if (result.error) {
      log.warn(TAG, `Docs error: ${result.error}`);
      return null;
    }

    return parseDocsLinks(result);
  } catch (err) {
    log.warn(TAG, `Docs search failed: ${err.message}`);
    return null;
  }
}

/**
 * Timeout wrapper for promises.
 */
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('RAG timeout')), ms)),
  ]);
}

// Categories useful for the model (where data lives or can be queried)
const _USEFUL_CATEGORIES = new Set([
  'Документы', 'Справочники', 'Отчеты', 'Обработки', 'ПланыСчетов',
  'РегистрыСведений', 'РегистрыНакопления', 'РегистрыБухгалтерии', 'РегистрыРасчета',
  'ПланыВидовХарактеристик', 'ПланыВидовРасчета', 'ЖурналыДокументов',
  'Перечисления', 'БизнесПроцессы', 'Задачи',
]);

/**
 * Parse Vega MCP result into compact link string.
 * Filters to useful categories only (registers, documents, references, etc.)
 */
function parseVegaLinks(result) {
  const text = extractMcpText(result);
  if (!text) return null;

  const links = [];
  const lines = text.split('\n');

  for (const line of lines) {
    if (!line.includes('|')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 4 || cols[0] === '#' || cols[0].startsWith('---')) continue;
    const name = cols[1];
    const category = cols[2];
    const synonym = cols[3];
    if (!name || !category || !_USEFUL_CATEGORIES.has(category)) continue;
    const display = synonym && synonym !== name ? `${synonym} (${category}.${name})` : `${category}.${name}`;
    links.push(display);
    if (links.length >= 10) break;
  }

  return links.length > 0 ? links.join(', ') : null;
}

/**
 * Parse docs MCP result into compact link string.
 * Handles two formats:
 * - Language docs: "## название: X" / "родитель: Y" blocks
 * - Config docs: "Result N: file:///..." with "## Title" headers
 */
function parseDocsLinks(result) {
  const text = extractMcpText(result);
  if (!text) return null;

  const links = [];
  const blocks = text.split(/^-{3,}$/m);

  for (const block of blocks) {
    if (links.length >= 5) break;

    // Format 1: language docs (## название: X)
    const nameMatch = block.match(/##\s*название:\s*(.+)/);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      const parentMatch = block.match(/родитель:\s*(.+)/);
      const parent = parentMatch ? parentMatch[1].trim() : '';
      links.push(parent ? `${parent}.${name}` : name);
      continue;
    }

    // Format 2: config docs (## Title after Result header)
    const titleMatch = block.match(/^##\s+(.+)/m);
    if (titleMatch && block.includes('Result')) {
      links.push(titleMatch[1].trim());
    }
  }

  return links.length > 0 ? links.join(', ') : null;
}

function extractMcpText(mcpResult) {
  if (!mcpResult?.content) return null;
  return mcpResult.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n') || null;
}
