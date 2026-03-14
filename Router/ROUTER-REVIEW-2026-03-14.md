# Router Review — 2026-03-14

## Findings

### [P1] Global parser state in `protocol.mjs` can mix events between concurrent Claude sessions

**Where:** `protocol.mjs:6-10`, `protocol.mjs:43-52`, `protocol.mjs:75-76`, `claude.mjs:18-20`, `claude.mjs:131-158`

`transformClaudeEvent()` keeps `_inThinking` in module-global state, and each new `spawnClaude()` calls `resetState()`. If two Claude processes stream at the same time, one session can reset or flip thinking state for another session. In practice this can produce missing or extra `thinking_end`, broken TTFT/streaming state, and hard-to-reproduce cross-session glitches.

**Recommendation:** move parser state into a per-process/per-stream parser instance instead of a module singleton.

### [P1] Active session channels are not restored after Centrifugo reconnect

**Where:** `centrifugo.mjs:84-92`, `server.mjs:241-244`

On reconnect the client only restores lobby autosubscriptions. Session channels are subscribed via Server API against the old `centrifugo.clientId`, but there is no code that walks existing sessions and re-subscribes the new client id. After a WS reconnect the router can continue to receive `session:lobby` but silently stop receiving `chat`, `tool_result`, `auth`, and `disconnect` for already-open sessions.

**Recommendation:** after reconnect, iterate live sessions and re-run `apiSubscribe('router-1', centrifugo.clientId, session.channel)` for each active channel.

### [P1] Attachment filenames are written to disk without path sanitization

**Where:** `history.mjs:38-43`, `history.mjs:46-51`, `history.mjs:55-60`

`extractAttachments()` uses `item.name` directly in `join(attachDir, name)`. A crafted filename like `..\\..\\router.log` or `subdir/evil.txt` can escape the `attach/` directory and overwrite arbitrary files writable by the router.

**Recommendation:** strip directory separators, normalize to basename only, and reject names that change after normalization.

### [P2] Hot reload is inconsistent: Claude gets fresh profile, `/tools` serves stale profile

**Where:** `server.mjs:74`, `server.mjs:386-389`, `tools.mjs:12`, `tools.mjs:27-31`

`spawnClaudeForSession()` reloads `profile` on every spawn, but `createToolServer()` captured the original `profile` object at startup. That means changes in `tools.json` can update Claude-side config while `tools-mcp.mjs` still receives the old `/tools` definition until a full router restart. This creates hard-to-debug mismatches between allowed tools and tool schemas.

**Recommendation:** make `/tools` read the current profile dynamically instead of closing over the startup snapshot.

### [P2] Memory subsystem trusts filesystem path components from runtime input

**Where:** `profiles.mjs:76-85`, `profiles.mjs:147-151`, `tools-mcp.mjs:139-149`, `tools-mcp.mjs:171-183`, `tools-mcp.mjs:190-200`

Two inputs flow into filesystem paths without a strong boundary:
- `session.configName` comes from incoming `hello` and is used to build memory paths and MCP env.
- `lyra_memory_read` accepts arbitrary `args.name` and resolves `${name}.md` without validating the segment.

Together this makes it possible to read or write outside the intended memory tree if a client or tool call sends path-like values.

**Recommendation:** validate `config_name` against an allowlist or strict slug/UUID format, and apply the same filename validation to `lyra_memory_read` that is already used in `lyra_memory_save`.

### [P2] All auto-auth sessions share the same logical user and Claude workspace

**Where:** `server.mjs:248-252`, `claude.mjs:61-69`, `profiles.mjs:81-85`

New sessions are force-marked as `userId = 'mvp-user'`. Because Claude `cwd` is derived from `session.userId`, all auto-auth sessions share the same `.users/mvp-user` workspace. The same applies to user memory loading. In a multi-user environment this can mix personal memory and Claude local state across unrelated users.

**Recommendation:** keep sessions anonymous until real auth, or derive an isolated temporary user scope per session/device instead of using a global `mvp-user` bucket.

### [P3] Test suite no longer matches the runtime contract, so regressions can slip through

**Where:** `test-hello.mjs:16`, `test-hello.mjs:56-64`, `test-reconnect.mjs:109-120`, `test-chat.mjs:127-145`, `test-tools.mjs:129-146`, `test-memory.mjs:13-31`

Several tests still assert the old flow:
- `test-hello.mjs` waits for `auth_ack`, but current hello flow is `hello_ack + auto_auth`.
- `test-reconnect.mjs` expects first status `awaiting_auth`, while server now returns `new` with `auto_auth: true`.
- `test-chat.mjs` and `test-tools.mjs` still treat `text_delta` as a required success signal even though the router now suppresses it.
- `test-memory.mjs` copies registry logic instead of exercising `tools-mcp.mjs` directly, so it can pass while the real module regresses.

**Recommendation:** align tests with the current protocol and prefer testing exported behavior over copied helper logic.

## Additional recommendations

- Add `AbortController` timeouts to `centrifugo.mjs::_apiCall()` and to both external fetches in `tools-mcp.mjs::askNaparnik()`. Right now a hung upstream can stall a hello/tool flow indefinitely.
- Consider hardening single-instance enforcement further: current `killOldRouter()` is much better than before, but it still depends on a single PID file and `wmic` availability.
- Expand log redaction to case-insensitive keys like `Authorization` and nested `headers.Authorization` if any request payloads ever start carrying tokens.

## Assumptions and gaps

- This review was static: I inspected production modules and test files, but did not run the Centrifugo/Claude integration flows during this pass.
- I focused on behavior, operational resilience, and security boundaries more than style.
