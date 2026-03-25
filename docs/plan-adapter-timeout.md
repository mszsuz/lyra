# План: Timeout/retry для router-managed HTTP/SSE адаптеров

**Проблема:** если API (OpenRouter, Anthropic и т.д.) перестаёт отвечать посреди SSE-стрима, сессия висит бесконечно. Пользователь видит «думаю...» без конца. Подтверждено в production: 2026-03-25, сессия `0ddef27f`, gpt-5.4 зависла после 12-го tool turn.

**Scope:** router-managed HTTP/SSE адаптеры (`openai.mjs`, `claude-api.mjs`).
**Вне scope:** passthrough-адаптеры (`claude-cli.mjs`, `codex-cli.mjs`) — child process, свои механизмы завершения. Retry для них требует отдельного ADR.

**Аудит:** `plan-adapter-timeout-AUDIT.md`, `plan-adapter-timeout-RECHECK.md`, `plan-adapter-timeout-RECHECK-2.md`, `plan-adapter-timeout-RECHECK-3.md`, `plan-adapter-timeout-RECHECK-4.md`, `plan-adapter-timeout-RECHECK-5.md`, `plan-adapter-timeout-RECHECK-6.md` (финальный — замечаний нет).

---

## 1. Поведение

```
Запрос к модели (один semantic turn)
  │
  ├── [Внутренний цикл: до maxRetries+1 попыток]
  │   │
  │   ├── Connect: fetch() с AbortController
  │   │   ├── Ответ получен за connectTimeout → ОК
  │   │   ├── Таймаут → adapter_timeout (stage: connect, retryable)
  │   │   └── User abort → user_abort (НЕ retryable, тихий выход)
  │   │
  │   ├── SSE-стрим: reader.read() с Promise.race
  │   │   ├── Чанк пришёл за chunkTimeout → ОК, сбросить таймер
  │   │   ├── Тишина chunkTimeout → adapter_timeout (stage: chunk, retryable)
  │   │   └── User abort → user_abort (тихий выход)
  │   │
  │   └── Успешный assistant_end → выход из внутреннего цикла
  │
  ├── [Есть tool_use И toolTurnCount < maxToolTurns?] → execute tools → следующий turn
  ├── [toolTurnCount >= maxToolTurns?] → ещё один запрос БЕЗ tools → финальный текст
  └── [Нет tool_use?] → ответ пользователю, конец
```

Два вложенных цикла:
- **Внешний** — semantic turns. `toolTurnCount++` только при успешном turn-е с tools.
- **Внутренний** — transport retries одного запроса. Не расходует toolTurnCount.

После исчерпания `maxToolTurns` — ещё один запрос с `tools: []`. Если модель всё равно вернёт tool_use — аварийный выход **без выполнения tools**.

---

## 2. Конфигурация

`config.json`:

```json
{
  "adapterTimeout": {
    "chunkTimeout": 60000,
    "connectTimeout": 15000,
    "maxRetries": 1
  }
}
```

`config.mjs`:

```js
adapterTimeout: {
  chunkTimeout:   raw.adapterTimeout?.chunkTimeout   || 60_000,
  connectTimeout: raw.adapterTimeout?.connectTimeout  || 15_000,
  maxRetries:     raw.adapterTimeout?.maxRetries      ?? 1,
},
```

---

## 3. Error-контракт адаптеров

```js
// Таймаут — retryable
{ type: 'error', code: 'adapter_timeout', stage: 'connect'|'chunk', message: '...', retryable: true }

// User abort — НЕ retryable, НЕ ошибка для пользователя
{ type: 'error', code: 'user_abort', message: 'Aborted by user', retryable: false }
```

`server.mjs` принимает решение:
- `code === 'adapter_timeout' && retryable` → retry (внутренний цикл)
- `code === 'user_abort'` → тихий return → pendingMessage
- Любой другой error → ошибка пользователю

---

## 4. Разделение abort-причин в адаптере

Один `AbortController` на запрос. Причина отмены хранится в `_abortReason`:

```js
// В chat() перед fetch:
this._abortReason = null;
this._currentAbort = controller;

// Connect-timeout (только connect использует AbortController + _abortReason):
this._abortReason = 'timeout';
controller.abort();

// Chunk-timeout:
// НЕ использует _abortReason и НЕ abort-ит controller.
// Helper readSSEWithTimeout() сам кидает:
throw new AdapterTimeoutError('chunk', chunkTimeout);

// User abort:
abort(sessionId) {
  if (this._currentAbort) {
    this._abortReason = 'user_abort';
    this._currentAbort.abort();
    this._currentAbort = null;
  }
  return { ok: true };
}
```

Канонические механизмы определения причины:
- **connect-timeout** → `AbortError` + `_abortReason === 'timeout'`
- **user_abort** → `AbortError` + `_abortReason === 'user_abort'`
- **chunk-timeout** → `AdapterTimeoutError` (не AbortError, не _abortReason)

При `AbortError` адаптер проверяет `_abortReason`:

```js
catch (err) {
  if (err.name === 'AbortError') {
    if (this._abortReason === 'user_abort') {
      yield { type: 'error', code: 'user_abort', message: 'Aborted by user', retryable: false };
    } else {
      yield { type: 'error', code: 'adapter_timeout', stage: 'connect', message: '...', retryable: true };
    }
    return;
  }
  if (err instanceof AdapterTimeoutError) {
    yield { type: 'error', code: 'adapter_timeout', stage: 'chunk', message: err.message, retryable: true };
    return;
  }
  throw err;
}
```

---

## 5. Файлы

### 5.1. `adapters/sse-reader.mjs` (НОВЫЙ)

Helper для чтения SSE с watchdog-таймером. Используется в `openai.mjs` и `claude-api.mjs`.

```js
export class AdapterTimeoutError extends Error {
  constructor(stage, timeoutMs) {
    super(`No data for ${timeoutMs}ms (stage: ${stage})`);
    this.name = 'AdapterTimeoutError';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * @param {ReadableStream} body
 * @param {number} chunkTimeout — мс
 * @param {AbortSignal} [signal] — для внешнего abort
 */
export async function* readSSEWithTimeout(body, chunkTimeout, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      if (signal?.aborted) return;

      let timer;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AdapterTimeoutError('chunk', chunkTimeout)), chunkTimeout);
      });

      try {
        const result = await Promise.race([reader.read(), timeoutPromise]);
        clearTimeout(timer);
        if (result.done) break;
        yield decoder.decode(result.value, { stream: true });
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof AdapterTimeoutError) {
          reader.cancel().catch(() => {});
          throw err;
        }
        throw err;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

- `clearTimeout` всегда — нет утечек таймеров.
- `signal` для внешнего abort (user interrupt / retry cleanup).
- Вся state локальна — нет mutable state на инстансе.

### 5.2. `adapters/openai.mjs`

**`chat()`:**

```js
async *chat(request) {
  const body = this.#buildRequestBody(request);
  const url = `${this.#baseUrl}/chat/completions`;
  const chunkTimeout = request.options?.chunkTimeout || 60_000;
  const connectTimeout = request.options?.connectTimeout || 15_000;

  const controller = new AbortController();
  this._currentAbort = controller;
  this._abortReason = null;

  // Connect timeout
  const connectTimer = setTimeout(() => {
    this._abortReason = 'timeout';
    controller.abort();
  }, connectTimeout);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${request.api_key || this.#apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(connectTimer);
    this._currentAbort = null;
    if (err.name === 'AbortError') {
      if (this._abortReason === 'user_abort') {
        yield { type: 'error', code: 'user_abort', message: 'Aborted by user', retryable: false };
      } else {
        yield { type: 'error', code: 'adapter_timeout', stage: 'connect',
                message: `Connect timeout (${connectTimeout}ms)`, retryable: true };
      }
      return;
    }
    // Сетевая ошибка (DNS, refused, etc.)
    yield { type: 'error', code: 'adapter_timeout', stage: 'connect',
            message: err.message, retryable: true };
    return;
  }
  clearTimeout(connectTimer);

  if (!res.ok) {
    this._currentAbort = null;
    const errorText = await res.text();
    yield { type: 'error', message: `API error ${res.status}: ${errorText}`,
            code: 'api_error', retryable: res.status >= 500 };
    return;
  }

  try {
    yield* this.#parseSSE(res.body, chunkTimeout, controller.signal);
  } catch (err) {
    if (err instanceof AdapterTimeoutError) {
      yield { type: 'error', code: 'adapter_timeout', stage: err.stage,
              message: err.message, retryable: true };
      return;
    }
    if (err.name === 'AbortError') {
      if (this._abortReason === 'user_abort') {
        yield { type: 'error', code: 'user_abort', message: 'Aborted by user', retryable: false };
      } else {
        yield { type: 'error', code: 'adapter_timeout', stage: 'chunk',
                message: 'Stream aborted', retryable: true };
      }
      return;
    }
    throw err;
  } finally {
    this._currentAbort = null;
  }
}
```

**`#parseSSE()`** — заменить `for await (const chunk of body)` на `readSSEWithTimeout()`. Все переменные (`fullText`, `toolCalls`, `_finished`) — **локальные**, не на инстансе:

```js
async *#parseSSE(body, chunkTimeout, signal) {
  let buffer = '';
  let fullText = '';
  let toolCalls = new Map();
  let model = this.#model;
  let usage = null;
  let cost = null;
  let generationId = null;
  let finished = null;  // ← локальная, не this._finished

  for await (const text of readSSEWithTimeout(body, chunkTimeout, signal)) {
    buffer += text;
    // ... существующий парсинг SSE-строк без изменений ...
    // замена this._finished → finished
    // замена this._lastGenerationId → generationId (уже локальная)
  }

  if (finished) {
    // ... emit assistant_end (существующий код, с finished вместо this._finished)
  }
}
```

**`abort()`:**

```js
async abort(sessionId) {
  if (this._currentAbort) {
    this._abortReason = 'user_abort';
    this._currentAbort.abort();
    this._currentAbort = null;
  }
  return { ok: true };
}
```

### 5.3. `adapters/claude-api.mjs`

Те же изменения:
- `chat()`: AbortController + `_abortReason` + connect-таймаут. При `AbortError` — проверка `_abortReason`.
- `#parseSSE()`: `readSSEWithTimeout()` вместо `for await`. `this._currentToolUse` → **локальная** переменная `currentToolUse`.
- `abort()`: `this._abortReason = 'user_abort'` + `this._currentAbort.abort()`.

### 5.4. `server.mjs` — `runAdapterChatManaged()`

```js
async function runAdapterChatManaged(session, text) {
  // ... RAG, conversation.addUserMessage, request setup (существующий код) ...

  const request = {
    session_id: session.sessionId,
    system_prompt: session.systemPrompt,
    messages: conversation.getMessages(session),
    tools: session.tools,
    options: {
      chunkTimeout: config.adapterTimeout.chunkTimeout,
      connectTimeout: config.adapterTimeout.connectTimeout,
    },
    _configName: session.configName,
    _userId: session.userId,
  };

  let accumulatedCostUsd = 0;
  const maxToolTurns = 10;
  const maxRetries = config.adapterTimeout.maxRetries;
  let toolTurnCount = 0;

  try {
    while (true) {
      // После исчерпания tool-лимита — запрос без tools
      const toolsExhausted = toolTurnCount >= maxToolTurns;
      const currentRequest = {
        ...request,
        messages: conversation.getMessages(session),
        tools: toolsExhausted ? [] : request.tools,
      };
      if (toolsExhausted) {
        log.warn(TAG, `Tool limit (${maxToolTurns}) reached, final request without tools`);
      }

      let pendingTools = [];
      let turnSuccess = false;

      // ─── Внутренний цикл: transport retries ───
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        pendingTools = [];
        let gotTimeout = false;

        for await (const event of session.adapter.chat(currentRequest)) {

          // User abort → тихий выход
          if (event.type === 'error' && event.code === 'user_abort') {
            log.info(TAG, `User abort, session ${session.sessionId}`);
            return;
          }

          // Adapter timeout → retry или сдаться
          if (event.type === 'error' && event.code === 'adapter_timeout' && event.retryable) {
            if (attempt < maxRetries) {
              log.warn(TAG, `Adapter timeout [${event.stage}] attempt ${attempt+1}/${maxRetries+1}, session ${session.sessionId}`);
              gotTimeout = true;
              break;
            } else {
              log.error(TAG, `Adapter timeout [${event.stage}] after ${maxRetries+1} attempts, session ${session.sessionId}`);
              centrifugo.apiPublish(session.channel, {
                type: 'error',
                message: 'Не удалось получить ответ на сообщение. Попробуйте переформулировать и повторить.',
              });
              return;
            }
          }

          // Другие ошибки
          if (event.type === 'error') {
            log.error(TAG, `Adapter error: ${event.message}`);
            centrifugo.apiPublish(session.channel, { type: 'error', message: event.message });
            return;
          }

          // Tool use
          if (event.type === 'tool_use') {
            pendingTools.push(event);
            const toolKey = resolveToolKey(event.name, session);
            const toolLabel = profile.toolLabels?.[toolKey] || event.name;
            centrifugo.apiPublish(session.channel, {
              type: 'tool_status', tool: toolKey, description: toolLabel,
            }).catch(() => {});
            continue;
          }

          // Assistant end
          if (event.type === 'assistant_end') {
            turnSuccess = true;

            if (pendingTools.length > 0) {
              // ── Guard: tools после исчерпания лимита → аварийный выход ──
              if (toolsExhausted) {
                log.error(TAG, `Model returned tool_use after tool limit, ignoring tools, session ${session.sessionId}`);
                // НЕ выполняем tools.
                // Но стоимость предыдущих tool-turn'ов не должна теряться.
                if (event.text) {
                  if (accumulatedCostUsd > 0) {
                    event.cost_usd = (event.cost_usd || 0) + accumulatedCostUsd;
                    event.cost_rub = Math.round(event.cost_usd * 100 * 100) / 100;
                  }
                  handleAdapterEvent(session, event);
                  conversation.addAssistantMessage(session, event.text);
                  billingProcessEvent(session, event, centrifugo);
                } else {
                  // Нет текста — списать всю стоимость (накопленная + последний запрос)
                  const totalCostUsd = (accumulatedCostUsd || 0) + (event.cost_usd || 0);
                  if (totalCostUsd > 0) {
                    billAccumulatedCost(session, totalCostUsd, centrifugo);
                  }
                  centrifugo.apiPublish(session.channel, {
                    type: 'error',
                    message: 'Модель пыталась вызвать инструменты после лимита. Попробуйте упростить вопрос.',
                  });
                }
                return;
              }

              // Обычный tool turn — выполняем
              accumulatedCostUsd += event.cost_usd || 0;
              for (const tu of pendingTools) {
                const toolResult = await executeTool(session, tu, {
                  centrifugo,
                  toolCallTimeout: config.toolCallTimeout,
                });
                conversation.addToolUse(session, { id: tu.id, name: tu.name, input: tu.input });
                conversation.addToolResult(session, tu.id, toolResult.content, toolResult.isError);
              }
              log.info(TAG, `Tool results received (${pendingTools.length} tools, cost: $${accumulatedCostUsd.toFixed(4)}), continuing...`);
            } else {
              // Финальный ответ
              if (accumulatedCostUsd > 0) {
                event.cost_usd = (event.cost_usd || 0) + accumulatedCostUsd;
                event.cost_rub = Math.round(event.cost_usd * 100 * 100) / 100;
              }
              handleAdapterEvent(session, event);
              conversation.addAssistantMessage(session, event.text);
              billingProcessEvent(session, event, centrifugo);
            }
            break;
          }

          // text_delta, tool_status, etc.
          handleAdapterEvent(session, event);
        }

        if (turnSuccess || !gotTimeout) break;
      }
      // ─── Конец внутреннего цикла ───

      if (!turnSuccess) break;
      if (pendingTools.length === 0) break;

      toolTurnCount++;
    }
  } catch (err) {
    log.error(TAG, `Adapter error: ${err.message} ${err.stack || ''}`);
    centrifugo.apiPublish(session.channel, { type: 'error', message: 'Ошибка модели' });
  }
}
```

### 5.5. `billing.mjs` — helper `billAccumulatedCost()`

Текущий `processEvent()` списывает только по `assistant_end` и отбрасывает `_internal`/`_suppress`. Для аварийной ветки нужен прямой вызов `deductBalance`:

```js
import { deductBalance } from './users.mjs';

/**
 * Списать накопленную стоимость tool-turn'ов напрямую, без assistant_end.
 * Используется когда нет финального ответа (аварийная ветка maxToolTurns).
 */
export function billAccumulatedCost(session, costUsd, centrifugo) {
  if (!costUsd || !session.userId) return;

  const newBalance = deductBalance(session.userId, costUsd, session.sessionId);
  centrifugo.apiPublish(session.channel, {
    type: 'balance_update',
    session_id: session.sessionId,
    balance: newBalance,
    currency: 'руб',
  });
  log.info(TAG, `Balance (accumulated): -${costUsd}$ → ${newBalance} руб (user=${session.userId})`);
}
```

Вызывает `deductBalance` напрямую + публикует `balance_update`. Не создаёт синтетический `assistant_end`, не проходит через `processEvent()`.

Используется только в аварийной ветке `toolsExhausted` — когда модель вернула tool_use без текста.

### 5.7. `server.mjs` — `handleAbort()`

Текущий `handleAbort()` работает только для CLI. Добавить ветку для adapter-сессий:

```js
function handleAbort(session) {
  log.info(TAG, `abort: session=${session.sessionId}`);

  // Adapter-based sessions
  if (session.adapter && session.streaming) {
    session.adapter.abort(session.sessionId);
    const abortEnd = { type: 'assistant_end', text: '', aborted: true };
    centrifugo.apiPublish(session.channel, abortEnd);
    writeHistory(session, 'out', abortEnd);
    return;
  }

  // CLI-based sessions (существующий код без изменений)
  if (session.streaming && session._abort) {
    session._abort();
    const abortEnd = { type: 'assistant_end', text: '', aborted: true };
    centrifugo.apiPublish(session.channel, abortEnd);
    writeHistory(session, 'out', abortEnd);
  }
}
```

### 5.8. `server.mjs` — `runAdapterChatPassthrough()` — БЕЗ retry

Только уведомление пользователя:

```js
if (event.type === 'error' && event.code === 'user_abort') {
  return;  // тихий выход
}
if (event.type === 'error' && event.code === 'adapter_timeout') {
  log.error(TAG, `Passthrough adapter timeout [${event.stage}], session ${session.sessionId}`);
  centrifugo.apiPublish(session.channel, {
    type: 'error',
    message: 'Не удалось получить ответ. Попробуйте повторить.',
  });
  return;
}
```

### 5.9. `config.mjs`

```js
adapterTimeout: {
  chunkTimeout:   raw.adapterTimeout?.chunkTimeout   || 60_000,
  connectTimeout: raw.adapterTimeout?.connectTimeout  || 15_000,
  maxRetries:     raw.adapterTimeout?.maxRetries      ?? 1,
},
```

---

## 6. Что НЕ делаем

- Таймаут на весь turn целиком — только на тишину между чанками
- Обрезка истории при retry — повторяем тот же запрос
- Retry как отдельный billing-event
- Retry в passthrough-адаптерах
- user_abort → retry (user_abort всегда тихий выход)
- Расход maxToolTurns при retry
- Выполнение tools после исчерпания maxToolTurns

---

## 7. Порядок реализации

1. `adapters/sse-reader.mjs` — helper readSSEWithTimeout + AdapterTimeoutError
2. `config.mjs` + `config.json` — секция adapterTimeout
3. `adapters/openai.mjs` — AbortController + _abortReason + readSSEWithTimeout + abort()
4. `adapters/claude-api.mjs` — то же
5. `billing.mjs` — helper billAccumulatedCost()
6. `server.mjs: runAdapterChatManaged()` — два цикла + user_abort + toolsExhausted guard + billing
7. `server.mjs: handleAbort()` — поддержка adapter-сессий
8. `server.mjs: runAdapterChatPassthrough()` — adapter_timeout без retry
9. Тесты

---

## 8. Тест-план

| # | Сценарий | Ожидание |
|---|----------|----------|
| 1 | Сломанный URL → connect timeout | `adapter_timeout stage:connect`, retry, при 2-м → ошибка пользователю |
| 2 | Нормальный стриминг | Без регрессий |
| 3 | Timeout после tool_use но до assistant_end | Tools НЕ выполняются дважды, pendingTools сбрасывается |
| 4 | Timeout на turn N не сжигает retry для turn N+1 | attempt = 0 для каждого нового turn |
| 5 | Transport retry не расходует maxToolTurns | toolTurnCount++ только после успешного tool-turn |
| 6 | User abort во время SSE-стрима | `_abortReason='user_abort'` → `user_abort` event → **не retry** → pendingMessage |
| 7 | User abort во время fetch (до SSE) | `_abortReason='user_abort'` → AbortError → `user_abort` event → **не retry** |
| 8 | handleAbort() для adapter-сессии | `adapter.abort()` → `assistant_end { aborted: true }` в канал |
| 9 | Passthrough adapter timeout | Ошибка пользователю без retry |
| 10 | `claude-api.mjs` — chunk timeout | То же поведение что openai.mjs |
| 11 | maxToolTurns исчерпан (10 tool turns) | 11-й запрос без tools → текстовый ответ |
| 12 | maxToolTurns + модель возвращает tool_use | Tools **НЕ** выполняются → аварийный выход |

---

## 9. Логирование

```
[WARN]  [server] Adapter timeout [chunk] attempt 1/2, session 0ddef27f
[ERROR] [server] Adapter timeout [chunk] after 2 attempts, session 0ddef27f
[INFO]  [openai] Connect timeout (15000ms)
[INFO]  [server] User abort, session 0ddef27f
[WARN]  [server] Tool limit (10) reached, final request without tools
[ERROR] [server] Model returned tool_use after tool limit, session 0ddef27f
[WARN]  [server] Passthrough adapter timeout [chunk], session abc123
```

---

## 10. Сообщение пользователю

При финальном таймауте:
```json
{ "type": "error", "message": "Не удалось получить ответ на сообщение. Попробуйте переформулировать и повторить." }
```

При аварийном выходе после tool limit:
```json
{ "type": "error", "message": "Модель пыталась вызвать инструменты после лимита. Попробуйте упростить вопрос." }
```
