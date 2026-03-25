# Повторная проверка v4 плана `plan-adapter-timeout.md`

Дата: 2026-03-25

## Findings

### [P1] Предложенный helper `billAccumulatedCost()` в текущем виде не спишет стоимость

Что видно в плане:

- В плане добавлен helper `billAccumulatedCost(session, costUsd, centrifugo)`: `docs/plan-adapter-timeout.md:492-512`.
- Внутри helper создаёт synthetic event `assistant_end` с флагом `_internal: true` и передаёт его в `billingProcessEvent(session, event, centrifugo)`: `docs/plan-adapter-timeout.md:500-509`.

Что видно в текущем коде:

- Биллинг-модуль экспортирует `processEvent`, а не `billingProcessEvent`: `TEST-LYRA/router/billing.mjs:15`.
- `processEvent()` специально игнорирует события с `_internal`: `TEST-LYRA/router/billing.mjs:19`.
- Само списание денег происходит только после этих guard-ов через `deductBalance(...)`: `TEST-LYRA/router/billing.mjs:21-28`.

Почему это проблема:

- В предложенном виде helper либо не вызовется из-за неверного имени функции, либо, даже если имя поправить, событие с `_internal: true` будет сразу отброшено.
- Значит аварийная ветка после `maxToolTurns` всё ещё не гарантирует списание уже накопленной стоимости предыдущих tool-turn'ов.

Что бы я поправил:

- Либо сделать `billAccumulatedCost()` полноценным helper внутри `billing.mjs`, который напрямую вызывает `deductBalance(session.userId, costUsd, session.sessionId)` и публикует `balance_update`.
- Либо вызывать обычный `processEvent(session, syntheticAssistantEnd, centrifugo)`, но без `_internal`.
- Если нужен флаг "не публиковать это в чат", его лучше обрабатывать вне billing-слоя, потому что текущий billing трактует `_internal` как "не списывать".

## Итог

На этом проходе у меня осталось одно рабочее замечание: довести контракт `billAccumulatedCost()` до совместимости с реальным [`billing.mjs`](C:/WORKS/2026-01-31%20Lyra/TEST-LYRA/router/billing.mjs).

После этого план уже выглядит практически готовым к реализации.
