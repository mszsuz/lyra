# Review: реализация adapter timeout (доп. проход 4)

Дата: 2026-03-25

## Findings

### [P2] `handleAbort()` publishes terminal output before the turn is actually quiesced

Файл: `TEST-LYRA/router/server.mjs:425`

`handleAbort()` сразу публикует `assistant_end { aborted: true }`, но в коде нет session-level механизма, который гарантированно подавляет все поздние события из ещё живого managed loop. Если адаптер уже успел дойти до настоящего `assistant_end` или завершится сразу после этого, `runAdapterChatManaged()` всё ещё может форвардить и биллить этот ответ.

Следствие:

- клиент может увидеть два terminal event для одного turn;
- в истории может оказаться и `aborted`, и реальный финальный ответ;
- billing может пройти уже после того, как UI визуально завершил turn через abort.

## Итог

Оставшийся риск здесь не в самом `abort()` HTTP-запроса, а в том, что `assistant_end { aborted: true }` публикуется раньше, чем turn гарантированно замолкает на уровне всей session-логики.
