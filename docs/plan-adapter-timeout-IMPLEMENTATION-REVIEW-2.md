# Review: реализация adapter timeout (доп. проход)

Дата: 2026-03-25

## Findings

### [P1] New user message still does not interrupt a tool turn

Файл: `TEST-LYRA/router/server.mjs:329`

`handleChat()` теперь ставит новое сообщение в `pendingMessage` и вызывает `session.adapter.abort()`, но в отличие от явного `abort` не выставляет `session._aborted = true`. Поэтому если managed turn уже находится внутри `executeTool(...)`, остановки не происходит: `adapter.abort()` уже нечему прерывать, текущий tool call продолжает выполняться, а старый turn может дойти до следующего запроса к модели.

Следствие:

- старый turn может успеть продолжить выполнение после нового сообщения пользователя;
- финальный ответ старого turn всё ещё может уйти в историю, UI и billing;
- новое сообщение начнёт обрабатываться только после завершения предыдущего turn.

### [P2] Accumulated tool-turn cost is lost on timeout/error exits

Файл: `TEST-LYRA/router/server.mjs:790`

`accumulatedCostUsd` пополняется после успешных tool-turn’ов, но при выходе через `adapter_timeout` или другой `error` код сразу делает `return`, не вызывая `billAccumulatedCost(...)`. Если ранний semantic turn уже потратил токены, а следующий запрос упал, стоимость уже завершившихся turn’ов не спишется.

Следствие:

- router может недобилливать фактически уже понесённые расходы;
- баланс пользователя перестаёт соответствовать реальному расходу провайдера;
- ошибка проявится именно в сценариях `tool turn -> следующий запрос timeout/error`.

### [P2] Explicit abort can still trigger one extra model request

Файл: `TEST-LYRA/router/server.mjs:763`

`handleAbort()` выставляет `session._aborted = true`, но managed loop проверяет этот флаг только внутри цикла выполнения tools и перед публикацией финального ответа. Если abort приходит во время последнего tool call в пачке, код завершает этот tool call и затем всё равно переходит к следующему `session.adapter.chat(...)`, потому что перед началом нового semantic turn отдельной проверки на `_aborted` нет.

Следствие:

- после уже отправленного клиенту `assistant_end { aborted: true }` может стартовать ещё один запрос к модели;
- это тратит лишние токены;
- клиент может увидеть поздние `tool_status` или другие артефакты старого turn.

## Итог

Основные оставшиеся риски сейчас сосредоточены в `interrupt-path` и в аварийных выходах из managed loop:

- новое сообщение пользователя ещё не гарантирует реального прерывания tool execution;
- явный `abort` ещё не гарантирует, что старый turn не сделает лишний semantic turn;
- накопленная стоимость tool-turn’ов не во всех error-path корректно списывается.
