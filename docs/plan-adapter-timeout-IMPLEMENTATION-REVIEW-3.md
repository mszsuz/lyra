# Review: реализация adapter timeout (доп. проход 3)

Дата: 2026-03-25

## Findings

### [P1] Aborted turn still leaks tool history into the next request

Файл: `TEST-LYRA/router/server.mjs:859`

Если `abort` или новое сообщение пользователя приходят в момент, когда `executeTool(...)` уже выполняется, флаг `_aborted` проверяется только до `await`. После завершения tool call код всё равно выполняет `conversation.addToolUse(...)` и `conversation.addToolResult(...)` для уже прерванного turn. После этого managed loop останавливается до следующего semantic turn, но история уже загрязнена tool-вызовами и результатами из отменённого ответа.

Следствие:

- следующее пользовательское сообщение наследует лишний `tool_use/tool_result` контекст;
- модель может опираться на артефакты отменённого turn;
- поведение будет особенно заметно при `abort + resend` или `new chat during tool execution`.

### [P2] Client tool calls are still not abortable

Файл: `TEST-LYRA/router/tool-execution.mjs:107`

`executeTool()` создаёт promise, который завершается только через `tool_result` или timeout. Ни `handleChat()`, ни `handleAbort()` не делают принудительный reject для `pendingToolCalls`, поэтому interrupt во время client-side tool call лишь выставляет session-флаги, но сам router остаётся ждать завершения этого promise.

Следствие:

- реальная отзывчивость `abort` по-прежнему ограничена `toolCallTimeout`;
- новое сообщение пользователя не может стартовать немедленно, пока старый client tool call не завершился;
- при долгих инструментах в 1С пользователь всё ещё будет видеть запоздалое прерывание.

### [P2] OpenRouter cost lookup bypasses the new timeout envelope

Файл: `TEST-LYRA/router/adapters/openai.mjs:121`

После завершения SSE-стрима адаптер может сделать второй `fetch()` в OpenRouter generation API, чтобы получить стоимость. Этот запрос не использует основной `AbortController` и не имеет отдельного timeout, поэтому `chunkTimeout` уже не покрывает его, а `abort()` не может его отменить.

Следствие:

- turn всё ещё может зависнуть уже после завершения основного стрима;
- новый timeout-механизм не закрывает весь жизненный цикл OpenRouter-запроса;
- проблема проявится именно в сценариях, где стоимость берётся через generation lookup, а не приходит в SSE.

## Итог

Основные оставшиеся риски теперь сосредоточены не в базовом retry-loop, а в хвостовых сценариях:

- отменённый turn всё ещё может оставить мусор в conversation history;
- client-side tools всё ещё не прерываются немедленно;
- OpenRouter cost lookup всё ещё может подвесить turn вне нового timeout-контура.
