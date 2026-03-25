# Глубокий аудит плана `plan-adapter-timeout.md`

Дата: 2026-03-25

## Вывод

План решает реальную production-проблему и в правильную сторону уводит логику: таймаут нужен именно на "тишину" стрима, а не на весь turn.

Но в текущем виде я бы не отдавал его в реализацию без правок. В нём смешаны transport-retry и semantic turn-ы, недооценён scope по другим SSE-адаптерам, а часть предложенного retry-поведения конфликтует с текущей архитектурой `server.mjs`.

Ниже findings по приоритету.

## Findings

### [P1] Retry привязан к whole tool loop, а не к одному запросу модели

Что видно в плане:

- `retryCount` объявлен один раз перед `while (maxTurns-- > 0)`: `docs/plan-adapter-timeout.md:158-161`.
- Retry предлагается делать через `continue` в тот же `while`: `docs/plan-adapter-timeout.md:193-195`.
- В явном виде зафиксировано: `maxTurns уже уменьшился на 1, это нормально — retry считается за turn`: `docs/plan-adapter-timeout.md:194`.

Что видно в текущем коде:

- `runAdapterChatManaged()` уже использует `maxTurns` как guard именно для model/tool loop, а не для сетевых повторов: `TEST-LYRA/router/server.mjs:742-790`.

Почему это риск:

- Один таймаут на раннем tool-turn съест единственный retry для всей последующей цепочки, хотя план обещает "одну автоматическую повторную попытку" на проблемный запрос, а не на всю сессию.
- Сетевой retry начнёт расходовать `maxTurns`, то есть длинные tool-сценарии будут преждевременно упираться в лимит не из-за модели, а из-за транспорта.
- Для кейса из описания ("зависла после 12-го tool turn") это особенно опасно: текущий guard и так жёсткий, а план делает его ещё жёстче.

Что бы я поправил:

- Ввести отдельный внутренний цикл попыток вокруг одного `adapter.chat(currentRequest)`.
- `maxTurns` уменьшать только после успешного завершения semantic turn-а: либо получили `assistant_end` без retry, либо выполнили `pendingTools` и идём на следующий tool turn.
- `retryCount` держать per-request, а не per-session loop.

### [P1] Connect-timeout добавляется в конфиг, но по плану фактически не получает auto-retry

Что видно в плане:

- Обещано "двухуровневый таймаут с одной автоматической повторной попыткой": `docs/plan-adapter-timeout.md:5`.
- В конфиг добавляется и `chunkTimeout`, и `connectTimeout`: `docs/plan-adapter-timeout.md:29-33`.
- В `openai.mjs` на connect-timeout предлагается yield-ить `{ code: 'timeout', retryable: true }`: `docs/plan-adapter-timeout.md:78-80`.
- Но retry-ветка в `server.mjs` ловит только `event.code === 'chunk_timeout'`: `docs/plan-adapter-timeout.md:167-183`.
- Отдельно в плане написано, что `fetch connect error` уже покрыт существующим `res.ok check`: `docs/plan-adapter-timeout.md:19`.

Что видно в текущем коде:

- Сейчас `fetch()` в `openai.mjs` вообще не обёрнут в `try/catch`; сетевой сбой произойдёт до `res.ok` и уйдёт в общий `catch` уровня `server.mjs`: `TEST-LYRA/router/adapters/openai.mjs:33-45`, `TEST-LYRA/router/server.mjs:791-794`.

Почему это риск:

- План обещает двухуровневый retry, а реализует retry только для `chunk_timeout`.
- `connectTimeout` тогда становится лишь другим текстом ошибки, но не реальной устойчивостью.
- Базовая предпосылка в строке про `res.ok check` неверна, значит текущий объём работ по connect-failure занижен.

Что бы я поправил:

- Нормализовать timeout-ошибки в единый контракт, например `code: 'adapter_timeout'` + `stage: 'connect' | 'chunk'`.
- В `server.mjs` принимать решение по `retryable && code === 'adapter_timeout'`, а не по одному частному коду.
- В самом плане явно исправить тезис про `res.ok`: connect/network failures нужно обрабатывать отдельно.

### [P1] Retry нельзя механически переносить в `runAdapterChatPassthrough()`

Что видно в плане:

- Предлагается "аналогично" применить тот же retry-паттерн к `runAdapterChatPassthrough()`: `docs/plan-adapter-timeout.md:204`.

Что видно в текущем коде:

- `runAdapterChatPassthrough()` обслуживает адаптеры с `history_mode: 'adapter'`: `TEST-LYRA/router/server.mjs:797-821`.
- `codex-cli.mjs` явно работает в `history_mode: 'adapter'` и переиспользует внутренний `threadId`: `TEST-LYRA/router/adapters/codex-cli.mjs:11`, `:24-25`, `:41-45`, `:85-88`.
- `claude-cli.mjs` тоже работает в `history_mode: 'adapter'` и отправляет каждое новое пользовательское сообщение прямо в уже живой CLI-процесс: `TEST-LYRA/router/adapters/claude-cli.mjs:39-40`, `:51-72`.

Почему это риск:

- Для passthrough-адаптеров "повторить тот же запрос" не эквивалентно "повторить те же messages".
- Повтор может задвоить пользовательское сообщение внутри уже существующего CLI-thread/session.
- В лучшем случае это лишняя сложность без эффекта; в худшем — дубль вопроса и разъезд истории.

Что бы я поправил:

- Ограничить этот план адаптерами с `history_mode: 'router'`.
- Для passthrough-адаптеров делать отдельный ADR: либо у них свой watchdog/abort, либо retry реализуется внутри адаптера с пониманием его state-machine.

### [P1] Scope плана занижен: та же бесконечная тишина уже возможна в `claude-api.mjs`

Что видно в плане:

- Детальная реализация расписана только для `openai.mjs`, а для `claude-api.mjs` указано лишь "проверить": `docs/plan-adapter-timeout.md:218-223`.

Что видно в текущем коде:

- `claude-api.mjs` так же делает `fetch()` без отдельного timeout/abort и так же читает SSE через `for await (const chunk of body)`: `TEST-LYRA/router/adapters/claude-api.mjs:26-45`, `:128-245`.
- Контракт адаптера уже поддерживает generic error events с `retryable`: `docs/MODEL-ADAPTER-API.md:370-380`.

Почему это риск:

- Баг не уникален для OpenAI-совместимого адаптера; это общий класс проблем всех HTTP/SSE adapters.
- Если внедрить политику таймаута только в одном адаптере, системное поведение роутера станет зависеть от выбранного backend-а.
- Потом придётся переносить те же решения повторно и уже под давлением production-инцидента.

Что бы я поправил:

- Поднять задачу на уровень "политика timeout/retry для router-managed HTTP adapters".
- Вынести общее чтение SSE с watchdog в helper, который используется минимум в `openai.mjs` и `claude-api.mjs`.
- В `MODEL-ADAPTER-API.md` зафиксировать timeout-контракт, чтобы `server.mjs` не зависел от частного кода одного адаптера.

### [P2] План вводит `AbortController`, но не закрывает уже существующий провал в `abort()`

Что видно в плане:

- В `openai.mjs` предлагается завести `AbortController` только локально внутри `chat()`: `docs/plan-adapter-timeout.md:64-85`.
- Про `abort(sessionId)` план ничего не меняет.

Что видно в текущем коде:

- Когда пользователь пишет новое сообщение во время стрима, Router рассчитывает на `session.adapter.abort(session.sessionId)`: `TEST-LYRA/router/server.mjs:327-333`.
- После завершения текущего запроса новый `pendingMessage` отправляется только когда `runAdapterChat()` вернётся: `TEST-LYRA/router/server.mjs:706-713`.
- Но у `openai` `abort()` сейчас no-op: `TEST-LYRA/router/adapters/openai.mjs:56-57`.
- У `claude-api` аналогично: `TEST-LYRA/router/adapters/claude-api.mjs:48-50`.

Почему это риск:

- После внедрения плана зависший API-запрос перестанет висеть бесконечно, но пользовательский interrupt всё равно останется "ленивым": новая реплика будет ждать таймаут, retry и только потом пойдёт дальше.
- Это ухудшает UX именно в том сценарии, где пользователь уже пытается спасти зависшую сессию вручную.

Что бы я поправил:

- Хранить активные `AbortController` по `session_id` внутри адаптера.
- Использовать один и тот же механизм и для `connectTimeout/chunkTimeout`, и для `abort(sessionId)`, и для принудительного teardown перед retry.

### [P2] Псевдокод `Promise.race()` недооформлен: нет cleanup таймера и нет защиты от cross-attempt state

Что видно в плане:

- Таймаут между чанками предлагается как `Promise.race([reader.read(), timeoutPromise])`: `docs/plan-adapter-timeout.md:100-124`.
- В примере нет `clearTimeout()` для успешного чтения и нет явного cleanup helper-а.

Что видно в текущем коде:

- В `openai.mjs` уже есть state на инстансе адаптера (`this._finished`, `this._lastGenerationId`): `TEST-LYRA/router/adapters/openai.mjs:186`, `:234-259`.
- В `claude-api.mjs` аналогично есть state на инстансе (`this._currentToolUse`): `TEST-LYRA/router/adapters/claude-api.mjs:191-211`.

Почему это риск:

- Без `clearTimeout()` каждый успешно прочитанный чанк оставит жить таймер до истечения `chunkTimeout`. На длинных стримах это лишняя нагрузка и шум.
- Если retry будет запускаться на том же экземпляре адаптера, state уровня инстанса надо либо локализовать, либо жёстко сбрасывать в `finally`, иначе появится cross-attempt bleed.

Что бы я поправил:

- Вынести чтение чанка в helper `readWithTimeout(reader, ms, onTimeoutAbort)`, который всегда делает cleanup в `finally`.
- Минимизировать mutable state на инстансе адаптера; всё, что относится к одной генерации, держать локально внутри `chat()` / `#parseSSE()`.

### [P2] Набор тестов в плане слишком слабый для такой точки риска

Что видно в плане:

- В тестах перечислены только: сломанный URL, проверка обычного стрима и "тест на живой сессии": `docs/plan-adapter-timeout.md:237-239`.

Почему этого мало:

- Самые опасные регрессии тут не в happy-path, а в стыках retry/tool loop/history/billing.
- "Живая сессия" плохо воспроизводит гонки и мало пригодна как регрессионный тест.

Каких тестов не хватает:

- timeout после `tool_use`, но до `assistant_end`: убедиться, что инструмент не исполняется дважды;
- timeout на одном tool-turn не сжигает retry для следующего tool-turn;
- transport-retry не уменьшает `maxTurns`;
- user abort во время зависшего стрима реально освобождает сессию;
- `runAdapterChatPassthrough()` остаётся без нового retry или покрыт отдельной безопасной стратегией;
- parity-тест для `claude-api.mjs`, если политика timeout объявляется общей.

## Что я бы поменял в самом плане перед реализацией

1. Переформулировать scope:
   - не "таймаут в openai adapter",
   - а "timeout/retry policy для router-managed HTTP/SSE adapters".

2. Разделить два цикла:
   - внешний `while` для semantic tool turns;
   - внутренний `for attempts` для transport retries одного и того же `currentRequest`.

3. Зафиксировать единый event contract:
   - `type: 'error'`,
   - `code: 'adapter_timeout'`,
   - `stage: 'connect' | 'chunk'`,
   - `retryable: true`.

4. Явно исключить passthrough adapters из этого плана:
   - `claude-cli`,
   - `codex-cli`.

5. Добавить в scope wiring для `abort(sessionId)`:
   - reuse того же `AbortController`,
   - cancel перед retry,
   - cancel по пользовательскому interrupt.

6. Расширить тест-план детерминированными сценариями, а не только "сломать URL" и "проверить на живой сессии".

## Рекомендуемый вердикт

План можно брать за основу, но не в текущем виде.

Минимум, который я бы потребовал до старта реализации:

- переработать retry как per-request, а не per-turn;
- убрать retry из `runAdapterChatPassthrough()`;
- включить в scope `claude-api.mjs` или явно зафиксировать, почему он исключён;
- дописать abort/wiring и тесты на idempotency tool loop.

Без этого есть высокий риск "починить зависание", но одновременно привнести новые регрессии в tool-turn loop и поведение adapter-managed сессий.
