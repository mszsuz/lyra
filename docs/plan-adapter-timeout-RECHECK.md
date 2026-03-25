# Повторная проверка плана `plan-adapter-timeout.md`

Дата: 2026-03-25

## Findings

### [P1] Пользовательский `abort` всё ещё смешан с `adapter_timeout`, из-за чего отменённый запрос может уйти в retry

Что видно в плане:

- Один и тот же `AbortController` предлагается использовать и для timeout, и для user abort: `docs/plan-adapter-timeout.md:155-159`.
- Любой `AbortError` на этапе `fetch()` превращается в retryable `adapter_timeout` со `stage: 'connect'`: `docs/plan-adapter-timeout.md:169-175`.
- В `server.mjs` retry принимается по `event.code === 'adapter_timeout'`: `docs/plan-adapter-timeout.md:282-293`.
- При этом раздел `Wiring: abort(sessionId)` ожидает, что user abort просто завершит текущий `for await` и даст обработать `pendingMessage`: `docs/plan-adapter-timeout.md:387-393`.

Почему это проблема:

- Сейчас новый пользовательский message во время стрима приходит через `session.adapter.abort(session.sessionId)`: `TEST-LYRA/router/server.mjs:327-333`.
- Если abort случится во время `fetch()` до получения ответа, предложенный код воспримет его как `adapter_timeout` и запустит retry старого запроса вместо немедленного перехода к `pendingMessage`.
- Если abort случится во время `reader.read()`, helper-псевдокод не показывает отдельной обработки `AbortError`, так что поведение остаётся неоднозначным: это может кончиться либо retry, либо общим `Ошибка модели`, а не чистой отменой.

Что бы я поправил:

- Явно разделить причины abort: `timeout`, `retry_cleanup`, `user_abort`.
- Не маппить пользовательскую отмену в `adapter_timeout`.
- В адаптере обрабатывать `AbortError` через проверку причины отмены и завершать генератор без retry, если это `user_abort`.

### [P1] Новый цикл по-прежнему не даёт финальный ответ после 10 успешных tool-turn'ов

Что видно в плане:

- Внешний цикл ограничен `while (turnCount < maxTurns)` при `maxTurns = 10`: `docs/plan-adapter-timeout.md:265-270`.
- `turnCount++` делается после успешного turn-а с tools: `docs/plan-adapter-timeout.md:336-340`.
- В тексте заявлено, что retry не режет длинные tool-цепочки: `docs/plan-adapter-timeout.md:343-346`.

Почему это проблема:

- Если модель успешно делает 10 tool-turn'ов подряд, то после `turnCount++` значение станет `10`, внешний `while` завершится, и следующий запрос на финальный ответ уже не отправится.
- То есть revised план убирает расход `maxTurns` на retry, но сохраняет старое логическое ограничение: длинная цепочка всё ещё может оборваться до финального ответа.
- Это особенно заметно на фоне production-описания в самом плане, где указан кейс "после 12-го tool turn": `docs/plan-adapter-timeout.md:3`.

Что бы я поправил:

- Либо считать `maxTurns` как лимит только на tool-turn'ы и разрешать ещё один финальный model call после исчерпания лимита tools.
- Либо заменить guard на более явный: отдельно `maxToolTurns` и отдельно допустимость финального ответа.
- Минимум: зафиксировать в плане, что должно происходить на 10-м успешном tool-turn и допускается ли 11-й запрос без tools.

### [P2] План чинит `adapter.abort()`, но не добавляет изменение в `handleAbort()` для adapter-сессий

Что видно в текущем коде:

- Новое сообщение во время стрима действительно идёт через `session.adapter.abort(...)`: `TEST-LYRA/router/server.mjs:327-333`.
- Но явная команда `abort` от клиента всё ещё обслуживается только через `session._abort`, то есть веткой CLI: `TEST-LYRA/router/server.mjs:425-432`.

Что видно в плане:

- Раздел `Wiring: abort(sessionId)` описывает только адаптерный `abort()` и путь через `pendingMessage`: `docs/plan-adapter-timeout.md:387-393`.
- Изменение `handleAbort()` в списке работ не упомянуто.

Почему это проблема:

- После реализации плана новый incoming message сможет прерывать HTTP-адаптер, а отдельная пользовательская команда `abort` останется no-op для `openai.mjs` / `claude-api.mjs`.
- Получится частично починенный interrupt-path с разным поведением для "новое сообщение" и "кнопка/команда abort".

Что бы я поправил:

- Добавить явное изменение в `server.mjs: handleAbort()`: для `session.adapter` вызывать `session.adapter.abort(session.sessionId)`.
- Отдельно определить downstream-поведение: нужно ли и для adapter-сессий публиковать `{ type: 'assistant_end', aborted: true }`, как это сейчас делается для CLI.

## Open Questions

- Должен ли user abort публиковать в канал специальное событие `assistant_end { aborted: true }`, или silent cancel + обработка `pendingMessage` считается достаточной?
- Какой именно лимит нужен на длинные tool-цепочки: `maxToolTurns`, `maxModelCalls`, или оба?

## Итог

Обновлённый план стал заметно сильнее: прошлые ключевые замечания про scope, per-request retry, passthrough-адаптеры и общий helper действительно учтены.

Но перед реализацией я бы ещё поправил три вещи:

- развести `user_abort` и `adapter_timeout`;
- закрыть поведение после 10-го успешного tool-turn;
- явно включить изменение `handleAbort()` в scope работ.
