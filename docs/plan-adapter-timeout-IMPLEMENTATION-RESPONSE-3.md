# Ответ на IMPLEMENTATION-REVIEW-3

Дата: 2026-03-25

## Статус findings

### [P1] Aborted turn still leaks tool history — ИСПРАВЛЕНО

Добавлена проверка `session._aborted` **после** `await executeTool()`, перед `conversation.addToolUse()` / `conversation.addToolResult()`.

Файл: `TEST-LYRA/router/server.mjs`

Было: проверка `_aborted` только перед `executeTool()`. Если abort приходил во время await — tool_result добавлялся в историю.

Стало: две проверки — до и после await. Если abort пришёл во время выполнения tool, результат отбрасывается, `billAccumulatedCost()` вызывается, `return`.

```js
if (session._aborted) { /* ... return */ }          // до
const toolResult = await executeTool(session, tu, {  // await — здесь может прийти abort
  centrifugo, toolCallTimeout: config.toolCallTimeout,
});
if (session._aborted) { /* ... return */ }          // после — результат отбрасывается
conversation.addToolUse(session, ...);               // только если не aborted
conversation.addToolResult(session, ...);
```

### [P2] Client tool calls are still not abortable — ПРИНЯТО, ОТЛОЖЕНО

Это ограничение архитектуры `tool-execution.mjs`: promise завершается только через `tool_result` от 1С-клиента или по `toolCallTimeout`. Ни `handleChat()`, ни `handleAbort()` не делают reject этого promise.

Почему не исправляем сейчас:
- Требует переработки tool-execution pipeline (reject pending promises, cancel protocol к 1С-клиенту)
- Это отдельный scope — interrupt client-side tools, не связан с adapter timeout
- Текущий `toolCallTimeout` (30 сек по умолчанию, 300 сек для naparnik) ограничивает максимальное ожидание

Зафиксировать в бэклоге как отдельную задачу.

### [P2] OpenRouter cost lookup bypasses timeout — ИСПРАВЛЕНО

Файл: `TEST-LYRA/router/adapters/openai.mjs`, метод `#fetchGenerationCost()`

Добавлен `AbortController` с таймаутом 5 секунд. При timeout fetch отменяется, возвращается `null` (cost будет неизвестен, но turn не повиснет).

```js
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 5_000);
const res = await fetch(url, { ..., signal: controller.signal });
clearTimeout(timer);
```
