// RAG layer — enriches user message with metadata and documentation from MCP
// Flash Lite agent picks search queries → parallel MCP search → programmatic trim → <rag> tag

import { callTool as mcpCallTool } from './mcp-client.mjs';
import * as log from './log.mjs';

const TAG = 'rag';

// --- Config name → docs library mapping ---

const _CONFIG_TO_DOCS_LIBRARY = {
  'БухгалтерияПредприятия': '1c-config-accounting',
  'ЗарплатаИУправлениеПерсоналом': '1c-config-hrm',
  'УправлениеТорговлей': '1c-config-trade',
  'УправлениеПредприятием': '1c-config-enterprise20',
};

// Categories useful for the model (where data lives or can be queried)
const _USEFUL_CATEGORIES = new Set([
  'Документы', 'Справочники', 'Отчеты', 'Обработки', 'ПланыСчетов',
  'РегистрыСведений', 'РегистрыНакопления', 'РегистрыБухгалтерии', 'РегистрыРасчета',
  'ПланыВидовХарактеристик', 'ПланыВидовРасчета', 'ЖурналыДокументов',
  'Перечисления', 'БизнесПроцессы', 'Задачи',
]);

/**
 * Pre-initialize MCP sessions (handshake) so RAG calls are fast.
 * Call once at session start, fire-and-forget.
 */
export function warmup(mcpServers) {
  if (mcpServers?.vega) {
    mcpCallTool(mcpServers.vega.url, 'search_metadata', { query: JSON.stringify({ op: 'list_objects_by_name', name: '_warmup_', match: 'exact' }) }, mcpServers.vega.headers)
      .then(() => log.info(TAG, 'Warmup: vega ready'))
      .catch(e => log.warn(TAG, `Warmup vega failed: ${e.message}`));
  }
  if (mcpServers?.docs) {
    mcpCallTool(mcpServers.docs.url, 'list_libraries', {}, mcpServers.docs.headers)
      .then(() => log.info(TAG, 'Warmup: docs ready'))
      .catch(e => log.warn(TAG, `Warmup docs failed: ${e.message}`));
  }
}

/**
 * Find relevant metadata and documentation for a user question.
 *
 * Flow:
 *   1. Flash Lite picks search queries via function calling (~1 sec)
 *   2. MCP servers return data in parallel (~1 sec)
 *   3. Results trimmed programmatically — no LLM on output (~0 ms)
 *   4. Real content (not just links) inserted into <rag> tag
 *
 * @returns {{ rag: string, ms: number } | null}
 */
export async function findRelevantLinks(question, mcpServers, ragConfig, configName) {
  const start = Date.now();
  const timeout = ragConfig.timeout || 5000;
  const docsLibrary = _CONFIG_TO_DOCS_LIBRARY[configName] || '1c-language-8.3.27';

  // Step 1: Flash Lite picks search queries
  let toolCalls;
  try {
    toolCalls = await getToolCalls(question, ragConfig, configName, docsLibrary);
  } catch (err) {
    log.warn(TAG, `Agent failed: ${err.message}`);
    return null;
  }
  if (!toolCalls?.length) {
    log.warn(TAG, `Agent returned no tool calls (${Date.now() - start}ms)`);
    return null;
  }

  log.info(TAG, `Agent (${Date.now() - start}ms): ${toolCalls.map(t => t.function.name + '(' + JSON.parse(t.function.arguments).query?.slice(0, 40) + ')').join(', ')}`);

  // Step 2: Execute MCP calls in parallel
  const results = await Promise.allSettled(
    toolCalls.map(tc => executeMcpCall(tc, mcpServers, docsLibrary, timeout))
  );

  // Step 3: Programmatic trim — no LLM
  const parts = [];
  for (let i = 0; i < toolCalls.length; i++) {
    if (results[i].status !== 'fulfilled' || !results[i].value) continue;
    const { name, content } = results[i].value;
    if (name === 'search_metadata' && content) parts.push(`Метаданные: ${content}`);
    if (name === 'search_docs' && content) parts.push(`Документация:\n${content}`);
  }

  if (!parts.length) {
    log.info(TAG, `No results (${Date.now() - start}ms)`);
    return null;
  }

  const rag = `<rag>\n${parts.join('\n')}\n</rag>`;
  const ms = Date.now() - start;

  log.info(TAG, `Enriched (${ms}ms, ${rag.length} chars)`);
  return { rag, ms };
}

// --- Step 1: Flash Lite agent ---

async function getToolCalls(question, ragConfig, configName, docsLibrary) {
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
          content: `Поисковый агент 1С:${configName}. Вызови ОБА инструмента чтобы найти метаданные и документацию по вопросу. НЕ отвечай текстом.\n\nВопрос: ${question}`,
        }],
        tools: [
          { type: 'function', function: {
            name: 'search_metadata',
            description: `Семантический поиск объектов метаданных конфигурации ${configName} (регистры, документы, справочники, отчёты) по описанию на естественном языке`,
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          }},
          { type: 'function', function: {
            name: 'search_docs',
            description: `Поиск по документации конфигурации ${configName} (библиотека ${docsLibrary}): ответы на вопросы, инструкции, примеры`,
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          }},
        ],
        tool_choice: 'required',
        temperature: 0,
      }),
    }),
    ragConfig.timeout,
  );

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.tool_calls || null;
}

// --- Step 2: Execute MCP calls ---

async function executeMcpCall(tc, mcpServers, docsLibrary, timeout) {
  const args = JSON.parse(tc.function.arguments);
  const name = tc.function.name;

  if (name === 'search_metadata' && mcpServers?.vega) {
    const result = await withTimeout(
      mcpCallTool(mcpServers.vega.url, 'search_metadata_by_description',
        { query: JSON.stringify({ op: 'search_metadata_by_description', text: args.query }) },
        mcpServers.vega.headers),
      timeout,
    );
    if (result.error) { log.warn(TAG, `Vega error: ${result.error}`); return null; }
    return { name, content: trimVega(result) };
  }

  if (name === 'search_docs' && mcpServers?.docs) {
    const result = await withTimeout(
      mcpCallTool(mcpServers.docs.url, 'search_docs',
        { library: docsLibrary, query: args.query },
        mcpServers.docs.headers),
      timeout,
    );
    if (result.error) { log.warn(TAG, `Docs error: ${result.error}`); return null; }
    return { name, content: trimDocs(result) };
  }

  return null;
}

// --- Step 3: Programmatic trim ---

function trimVega(result) {
  const text = extractMcpText(result);
  if (!text) return null;

  const items = [];
  for (const line of text.split('\n')) {
    if (!line.includes('|')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 4 || cols[0] === '#' || cols[0].startsWith('---')) continue;
    const name = cols[1], category = cols[2], synonym = cols[3];
    if (!name || !category || !_USEFUL_CATEGORIES.has(category)) continue;
    items.push(synonym && synonym !== name ? `${synonym} (${category}.${name})` : `${category}.${name}`);
    if (items.length >= 7) break;
  }

  return items.length > 0 ? items.join(', ') : null;
}

function trimDocs(result) {
  const text = extractMcpText(result);
  if (!text) return null;

  const blocks = text.split(/^-{3,}$/m);
  const snippets = [];

  for (const block of blocks) {
    if (snippets.length >= 3) break;

    // Config docs: "## Title" after "Result N:"
    const titleMatch = block.match(/^##\s+(.+)/m);
    if (titleMatch && block.includes('Result')) {
      const title = titleMatch[1].trim();
      const bodyStart = block.indexOf(titleMatch[0]) + titleMatch[0].length;
      const body = block.slice(bodyStart).replace(/!\[.*?\]\(.*?\)/g, '').trim().slice(0, 400);
      snippets.push(`## ${title}\n${body}`);
      continue;
    }

    // Language docs: "## название: X"
    const nameMatch = block.match(/##\s*название:\s*(.+)/);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      const parentMatch = block.match(/родитель:\s*(.+)/);
      const parent = parentMatch ? parentMatch[1].trim() : '';
      const descMatch = block.match(/<описание>\s*(.*?)\s*<\/описание>/s);
      const desc = descMatch ? descMatch[1].trim().slice(0, 200) : '';
      snippets.push(`${parent ? parent + '.' : ''}${name}${desc ? ': ' + desc : ''}`);
    }
  }

  return snippets.length > 0 ? snippets.join('\n---\n') : null;
}

// --- Helpers ---

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('RAG timeout')), ms)),
  ]);
}

function extractMcpText(mcpResult) {
  if (!mcpResult?.content) return null;
  return mcpResult.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n') || null;
}
