# Повторная проверка v3 плана `plan-adapter-timeout.md`

Дата: 2026-03-25

## Findings

### [P1] Аварийная ветка после `maxToolTurns` теряет накопленную стоимость предыдущих tool-turn'ов

Что видно в плане:

- В обычном happy-path стоимость tool-turn'ов копится в `accumulatedCostUsd`: `docs/plan-adapter-timeout.md:335-338`, `docs/plan-adapter-timeout.md:425-435`.
- В финальной ветке без tools эта накопленная стоимость прибавляется к последнему `assistant_end`: `docs/plan-adapter-timeout.md:436-444`.
- Но в аварийной ветке "модель вернула tool_use после лимита" код либо публикует `event.text`, либо `type: 'error'`, и сразу `return`: `docs/plan-adapter-timeout.md:407-423`.

Почему это проблема:

- Если до этого уже было несколько успешных tool-turn'ов, их стоимость лежит в `accumulatedCostUsd`, но в аварийной ветке она не добавляется к событию и не проходит через обычный billing-flow.
- В варианте с `event.text` пользователь увидит ответ, но итоговая стоимость будет занижена.
- В варианте без `event.text` произойдёт выход с ошибкой вообще без финального billing-event, то есть вся накопленная стоимость предыдущих turn'ов потеряется.

Что бы я поправил:

- Перед `return` в аварийной ветке явно решить судьбу `accumulatedCostUsd`.
- Если публикуется `assistant_end`, прибавлять к нему накопленную стоимость так же, как в обычной финальной ветке.
- Если публикуется только `type: 'error'`, отдельно зафиксировать, как биллить уже понесённые расходы предыдущих tool-turn'ов.

### [P2] В документе осталось два разных механизма для chunk-timeout: через `_abortReason/controller.abort()` и через `AdapterTimeoutError`

Что видно в плане:

- В разделе `Разделение abort-причин` сказано, что и connect-timeout, и chunk-timeout из `sse-reader` идут через `_abortReason = 'timeout'` и `controller.abort()`: `docs/plan-adapter-timeout.md:96-99`.
- Но сам helper `readSSEWithTimeout()` не имеет доступа ни к `controller`, ни к `_abortReason`; он просто кидает `AdapterTimeoutError`: `docs/plan-adapter-timeout.md:145-180`.
- Детальный snippet `openai.mjs` тоже обрабатывает chunk-timeout именно как `AdapterTimeoutError`, а не через `AbortError` + `_abortReason`: `docs/plan-adapter-timeout.md:246-252`.

Почему это проблема:

- Сейчас план почти готов к реализации, и такие расхождения уже не просто редакционные: они создают две конкурирующие модели поведения.
- Один разработчик может реализовать chunk-timeout через исключение helper-а, другой попытается прокинуть abort-причину из helper-а наружу, хотя текущий API helper-а этого не поддерживает.
- На стыке `openai.mjs` и `claude-api.mjs` это легко приведёт к несимметричной реализации и лишним правкам по ходу.

Что бы я поправил:

- Оставить один канонический механизм для chunk-timeout.
- Самый простой вариант: зафиксировать, что `connect-timeout` использует `_abortReason + AbortError`, а `chunk-timeout` идёт только через `AdapterTimeoutError`.
- После этого убрать из раздела `Разделение abort-причин` фразу, что timeout из `sse-reader` тоже делает `controller.abort()`.

## Итог

План уже выглядит рабочим и основные архитектурные риски закрыты.

На этом проходе у меня осталось 2 точечных замечания:

- довести billing/cost-handling в аварийной ветке после `maxToolTurns`;
- убрать внутреннее расхождение в описании механизма `chunk-timeout`.

Если поправить эти два места, документ будет выглядеть согласованным и почти готовым к реализации без скрытых сюрпризов.

## Вариант точечных правок

Ниже вариант минимальных правок прямо в текст плана, без расширения scope beyond necessity.

### 1. Привести `chunk-timeout` к одному каноническому механизму

В разделе `Разделение abort-причин в адаптере` я бы заменил фрагмент:

```js
// Таймаут (connect-timeout в chat, chunk-timeout в sse-reader):
this._abortReason = 'timeout';
controller.abort();
```

на такой:

```js
// Connect-timeout:
// только connect-timeout использует AbortController + _abortReason
this._abortReason = 'timeout';
controller.abort();

// Chunk-timeout:
// НЕ использует _abortReason и НЕ abort-ит controller.
// Helper readSSEWithTimeout() сам кидает:
throw new AdapterTimeoutError('chunk', chunkTimeout);
```

И сразу после этого коротко зафиксировал бы правило:

```md
Важно:
- `connect-timeout` определяется через `AbortError` + `_abortReason === 'timeout'`
- `user_abort` определяется через `AbortError` + `_abortReason === 'user_abort'`
- `chunk-timeout` определяется только через `AdapterTimeoutError`
```

Это уберёт двусмысленность между разделом про `_abortReason`, helper `sse-reader.mjs` и детальными snippets адаптеров.

### 2. Довести billing/cost-handling в аварийной ветке после `maxToolTurns`

В секции `runAdapterChatManaged()` я бы заменил аварийную ветку:

```js
if (toolsExhausted) {
  log.error(TAG, `Model returned tool_use after tool limit, ignoring tools, session ${session.sessionId}`);
  // НЕ выполняем tools. Публикуем текст если есть, или ошибку.
  if (event.text) {
    handleAdapterEvent(session, event);
    conversation.addAssistantMessage(session, event.text);
    billingProcessEvent(session, event, centrifugo);
  } else {
    centrifugo.apiPublish(session.channel, {
      type: 'error',
      message: 'Модель пыталась вызвать инструменты после лимита. Попробуйте упростить вопрос.',
    });
  }
  return;
}
```

на такой вариант:

```js
if (toolsExhausted) {
  log.error(TAG, `Model returned tool_use after tool limit, ignoring tools, session ${session.sessionId}`);

  // НЕ выполняем tools.
  // Но стоимость предыдущих tool-turn'ов уже накоплена и не должна теряться.
  if (event.text) {
    if (accumulatedCostUsd > 0) {
      event.cost_usd = (event.cost_usd || 0) + accumulatedCostUsd;
      event.cost_rub = Math.round(event.cost_usd * 100 * 100) / 100;
    }
    handleAdapterEvent(session, event);
    conversation.addAssistantMessage(session, event.text);
    billingProcessEvent(session, event, centrifugo);
  } else {
    if (accumulatedCostUsd > 0) {
      billAccumulatedCost(session, accumulatedCostUsd, centrifugo);
    }
    centrifugo.apiPublish(session.channel, {
      type: 'error',
      message: 'Модель пыталась вызвать инструменты после лимита. Попробуйте упростить вопрос.',
    });
  }
  return;
}
```

И рядом с этим фрагментом я бы добавил короткое пояснение:

```md
Важно:
- если аварийная ветка всё же вернула `assistant_end` с текстом, к нему нужно прибавить `accumulatedCostUsd`
- если текста нет и уходим через `type: "error"`, стоимость предыдущих успешных tool-turn'ов всё равно должна быть списана отдельно
```

### 3. Минимальное доп. изменение в плане для billing

Поскольку текущий [`billing.mjs`](C:/WORKS/2026-01-31%20Lyra/TEST-LYRA/router/billing.mjs) списывает деньги только по `assistant_end`, я бы добавил в план короткий подпункт:

```md
Дополнение:
- либо аварийная ветка всегда завершает turn через `assistant_end` и несёт в нём полную стоимость,
- либо в `billing.mjs` добавляется маленький helper `billAccumulatedCost(session, costUsd, centrifugo)` для списания уже понесённых расходов без публикации искусственного `assistant_end` в UI.
```

Если хочется минимального кода, я бы предпочёл второй вариант: отдельный helper в billing-слое чище, чем синтетический пустой `assistant_end` только ради списания стоимости.
