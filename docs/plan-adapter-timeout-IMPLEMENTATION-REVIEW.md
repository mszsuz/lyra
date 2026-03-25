# Review: реализация adapter timeout

Дата: 2026-03-25

## Findings

### [P1] Abort is ineffective during tool execution

Файл: `TEST-LYRA/router/server.mjs:327`

`session.streaming` остаётся `true` на весь managed turn, но прерывание всегда идёт через `session.adapter.abort()`. Это останавливает только активный HTTP-стрим. Когда код уже находится внутри `executeTool(...)`, `_currentAbort` в HTTP-адаптерах уже `null`, поэтому новое сообщение пользователя или явный `abort` не останавливают старый turn.

Следствие:

- старая цепочка tool execution может продолжить выполняться;
- после этого она всё ещё может отдать финальный ответ;
- этот ответ может попасть в историю, UI и billing уже после того, как пользователь считает turn прерванным.

### [P2] `handleAbort()` publishes terminal output before the turn is actually quiesced

Файл: `TEST-LYRA/router/server.mjs:425`

`handleAbort()` сразу публикует `assistant_end { aborted: true }`, но в коде нет session-level флага, который запрещает дальнейшую публикацию событий из ещё живого managed loop. Если адаптер уже успел добраться до настоящего `assistant_end` или сделает это сразу после abort, `runAdapterChatManaged()` всё равно продолжит его форвардить и биллить.

Следствие:

- клиент может увидеть два terminal event для одного turn;
- в истории может появиться и `aborted`, и реальный финальный ответ;
- billing может пройти уже после визуального завершения turn через abort.

## Итог

Основной риск сейчас не в timeout-механике как таковой, а в interrupt-path:

- abort не гарантирует фактическую остановку managed turn во время tool execution;
- abort не гарантирует, что поздние события старого turn не дойдут до клиента и биллинга.
