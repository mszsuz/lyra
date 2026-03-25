# Повторная проверка v5 плана `plan-adapter-timeout.md`

Дата: 2026-03-25

## Findings

### [P1] В аварийной ветке после `maxToolTurns` может потеряться стоимость последнего запроса без tools

Что видно в плане:

- В ветке с `event.text` стоимость последнего запроса корректно суммируется с `accumulatedCostUsd`: `docs/plan-adapter-timeout.md:427-434`.
- Но в ветке без текста вызывается только `billAccumulatedCost(session, accumulatedCostUsd, centrifugo)`: `docs/plan-adapter-timeout.md:435-443`.
- Helper `billAccumulatedCost()` принимает только одну сумму `costUsd` и списывает именно её: `docs/plan-adapter-timeout.md:503-514`.

Почему это проблема:

- Если финальный запрос "без tools" сам стоил денег (`event.cost_usd > 0`), но текста не вернул, то в текущем pseudocode будет списана только накопленная стоимость предыдущих tool-turn'ов.
- Стоимость именно последнего запроса выпадет из биллинга.

Что бы я поправил:

- Либо в аварийной ветке без текста вызывать:

```js
const totalCostUsd = (accumulatedCostUsd || 0) + (event.cost_usd || 0);
if (totalCostUsd > 0) {
  billAccumulatedCost(session, totalCostUsd, centrifugo);
}
```

- Либо расширить helper, чтобы он явно принимал уже итоговую сумму последнего аварийного turn-а, а не только "накопленную до него".

## Итог

Это последнее содержательное замечание, которое я вижу в текущем плане.

После его правки документ выглядит готовым к реализации.
