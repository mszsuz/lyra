# Повторная проверка v6 плана `plan-adapter-timeout.md`

Дата: 2026-03-25

## Findings

Новых содержательных замечаний по самому плану не обнаружено.

Ключевые прошлые проблемы уже закрыты в текущей версии документа:

- retry отделён от semantic turn и не расходует `maxToolTurns`;
- `user_abort` отделён от `adapter_timeout`;
- `chunk-timeout` приведён к одному каноническому механизму через `AdapterTimeoutError`;
- `handleAbort()` добавлен в scope для adapter-сессий;
- аварийная ветка после `maxToolTurns` больше не выполняет tools;
- billing для аварийной ветки учитывает и накопленную стоимость, и стоимость последнего запроса без tools.

## Residual Risk

Остались только риски уровня реализации, а не плана:

- при внедрении `billAccumulatedCost()` нужно аккуратно оформить imports/exports в [`billing.mjs`](C:/WORKS/2026-01-31%20Lyra/TEST-LYRA/router/billing.mjs), чтобы helper не разошёлся с существующим `processEvent`;
- стоит отдельно проверить, что путь `handleAbort() -> assistant_end { aborted: true }` не даёт лишних побочных эффектов в UI и истории;
- тест-план из документа всё ещё критичен: именно он должен поймать регрессии в billing, retry и interrupt-path.

## Итог

Текущая версия [`plan-adapter-timeout.md`](C:/WORKS/2026-01-31%20Lyra/docs/plan-adapter-timeout.md) выглядит согласованной и готовой к реализации.
