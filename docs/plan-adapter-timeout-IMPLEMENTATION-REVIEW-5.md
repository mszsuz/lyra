# Review: реализация adapter timeout (доп. проход 5)

Дата: 2026-03-25

## Статус

Исходный finding из `IMPLEMENTATION-REVIEW-4` по сути закрыт:

- поздний `assistant_end` после abort сейчас подавляется через guard в `handleAdapterEvent()`;
- финальная ветка `assistant_end` в managed loop тоже дополнительно проверяет `session._aborted`;
- значит риск двойного terminal event и позднего billing по исходному сценарию заметно снижен.

## Замечание

### [P3] `IMPLEMENTATION-RESPONSE-4` переоценивает охват abort-guard

Файл: `docs/plan-adapter-timeout-IMPLEMENTATION-RESPONSE-4.md`

В response-файле сказано, что guard в `handleAdapterEvent()` подавляет «все поздние события» после abort. Это формулировка шире, чем реальное поведение кода: ветка `tool_use` в `runAdapterChatManaged()` обрабатывается отдельно и публикует `tool_status` напрямую, минуя `handleAdapterEvent()`.

Подтверждение в коде:

- guard стоит в `TEST-LYRA/router/server.mjs` внутри `handleAdapterEvent()`;
- но `tool_use` обрабатывается отдельно в `TEST-LYRA/router/server.mjs` и делает `centrifugo.apiPublish(...)` напрямую.

Следствие:

- исходный finding про двойной `assistant_end` действительно выглядит закрытым;
- но текст `IMPLEMENTATION-RESPONSE-4.md` лучше сузить до terminal/publication path;
- фраза про подавление «всех поздних событий» сейчас слишком сильная.

## Итог

По коду блокирующего замечания из `REVIEW-4` у меня больше нет. Осталось только документальное уточнение формулировки в `IMPLEMENTATION-RESPONSE-4.md`.
