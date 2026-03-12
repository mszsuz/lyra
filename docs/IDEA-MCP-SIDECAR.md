# Идея: отдельный MCP sidecar для 1С

Дата: 2026-03-11

Вместо raw JSON-RPC proxy через Router и Chat использовать отдельный динамический MCP sidecar, который сам завершает MCP-протокол и общается с Лирой по уже существующему прикладному протоколу `tool_call/tool_result`.

Схема:

`Claude CLI`
→ основной ассистент как сейчас через `centrifugo_stdio` и `pipe:<session>`
→ отдельный MCP-сервер `1c-mcp-relay` из `--mcp-config`

`1c-mcp-relay`:
- сам отвечает на `initialize`, `tools/list`, `tools/call`
- читает `tools.json` из профиля
- на `tools/call` публикует в Centrifugo `{type:"tool_call", request_id, tool, params}`
- Chat выполняет инструмент и возвращает `{type:"tool_result", request_id, result/error}`

Почему идея выглядит сильнее текущего плана:

- не нужен второй `centrifugo_stdio`
- не нужен `mcp:` namespace
- не нужен raw JSON-RPC proxy через Router
- не нужно возвращать JSON-RPC логику в Chat
- можно переиспользовать уже существующую обработку `tool_call/tool_result`
- `centrifugo_stdio` остаётся узким транспортным адаптером, а не получает новую MCP-логику

Главный минус:

- появляется ещё один процесс на сессию

Но этот минус, вероятно, дешевле, чем одновременно усложнять Router, Chat и `centrifugo_stdio`.
