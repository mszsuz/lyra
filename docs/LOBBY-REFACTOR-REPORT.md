# Отчёт о реализации: Lobby Refactor (Этапы 0, 1, 2)

Дата: 2026-03-28
Спецификация: `LOBBY-REFACTOR-PLAN-v7.md`

## Результат

Этапы 0, 1, 2 реализованы и протестированы на реальном устройстве. Lobby полностью silent — регистрация мобильного и подключение Chat через приватные bootstrap-каналы, все ответы приватные. Chat (BSL) полностью переведён на bootstrap: hello через персональный канал, room_jwt, обработка push.subscribe, фильтр presence_leave по router-1. Legacy handleHelloFromLobby удалён — все клиенты используют bootstrap.

Этапы 3 (Email bind) и 4 (Документация) — не реализованы, запланированы отдельно.

---

## Этап 0: Transport substrate

### Router (`TEST-LYRA/router/centrifugo.mjs`)

| Пункт плана | Статус | Что сделано |
|---|---|---|
| 0.1 `body.error` в `_apiCall()` | ✓ | `_apiCall` теперь парсит `body.error` и бросает exception с code и message |
| 0.2 `apiUnsubscribe()` | ✓ | Новый метод, аналогичный `apiSubscribe` |
| 0.3 `onJoin`, `onLeave` | ✓ | Два callback-метода + `joinHandler`/`leaveHandler` в конструкторе |
| 0.4 `_handleMessage()` join/leave/pub | ✓ | Три ветки: `msg.push.pub`, `msg.push.join`, `msg.push.leave` |
| 0.5 тест leave.info формат | ✓ | `test-join-leave.mjs` — подтверждён формат `info.user` + `info.client` |

### Centrifugo config (`TEST-LYRA/centrifugo/config.json`)

| Пункт | Статус | Что сделано |
|---|---|---|
| presence + join_leave на mobile | ✓ | Добавлено |
| force_push_join_leave на session, mobile, room | ✓ | Добавлено (без этого join/leave не доставляются подписчикам) |
| namespace room: | ✓ | Новый namespace |
| namespace user: | ✓ | Новый namespace |

**Важная находка:** `join_leave: true` без `force_push_join_leave: true` не доставляет события подписчикам. Это не было в исходном плане — обнаружено при тестировании.

### Centrifugo сервер

Обновлён с v6.6.2 до **v6.7.0**.

### Mobile

| Пункт | Статус | Файл | Что сделано |
|---|---|---|---|
| 0.6 `serverSubscriptions` стрим | ✓ | `centrifugo_client.dart` | `client.subscribed` → `_serverSubscriptionsController` |
| 0.7 `connectToUserChannel()` | ✓ | `centrifugo_client.dart` | Аналог `connectToSession` для user-канала |
| 0.8 два клиента | ✓ | `centrifugo_client.dart` | `accountClientProvider` + `sessionClientProvider` + legacy alias |
| 0.9 `clearAuth()` + `user_jwt` | ✓ | `secure_storage.dart` | `saveUserJwt`, `getUserJwt`, `clearAuth()` (не трогает device_id) |
| 0.10 message_types | ✓ | `message_types.dart` | `RegisterAckMessage.userJwt`, `HelloErrorMessage`, `GetSessionsUserMessage` |

Дополнительно добавлено: `clientId` getter в `CentrifugoClient`, обработка `event.data` в `client.subscribed` (если subscribe содержит payload — парсить как сообщение).

### Chat (EPF/BSL)

| Пункт | Статус | Что сделано |
|---|---|---|
| 0.9 bootstrap state machine | ✓ | Полный bootstrap: обработка push.subscribe, hello через персональный канал `session:<clientUUID>` |
| 0.10 обработка hello_error | ✓ | Обработка hello_error от роутера |

Chat (1С) полностью переведён на bootstrap-каналы. Lobby JWT обновлён: добавлен `channels: ["session:lobby"]` claim (ранее отсутствовал — из-за этого join events не генерировались). Обработка push.subscribe, room_jwt, фильтр presence_leave по `router-1`.

### Тесты

| Тест | Статус | Файл |
|---|---|---|
| 0.11 join/leave info shape | ✓ | `test-join-leave.mjs` |
| 0.12 body.error exception | ✓ | Проверено в процессе тестирования |
| 0.13 push.subscribe доходит до клиента | ✓ | Подтверждено на реальном устройстве |

---

## Этап 1: room: + user: + JWT

### Router

| Пункт | Статус | Файл | Что сделано |
|---|---|---|---|
| 1.1 `makeRoomJWTs()` | ✓ | `jwt.mjs` | channels `["room:<sessionId>"]`, возвращает `roomJwt` + `mobileJwt` |
| 1.2 `makeUserJWT()` | ✓ | `jwt.mjs` | channels `["user:<userId>"]` |
| 1.3 sessions.mjs → room: | ✓ | `sessions.mjs` | `channel: room:<sessionId>`, `getByChannel` парсит `room:` |
| 1.4 history.mjs redaction | ✓ | `history.mjs` | `room_jwt` и `user_jwt` в SENSITIVE_KEYS |
| 1.5 `listKnownUserIds()` | ✓ | `users.mjs` | Дедупликация из `deviceToUser.values()` |
| 1.6 subscribe known users | ✓ | `server.mjs` | `subscribeKnownUsers()` с bounded parallelism (concurrency=20), при старте + reconnect |
| 1.7 dispatch room:* | ✓ | `server.mjs` | Полный dispatch: chat, tool_result, auth, abort, disconnect, settings_save |
| 1.8 dispatch user:* | ✓ | `server.mjs` | `handleGetSessionsUser()` с verifyAuth (userId из channel name, device_id из payload) |
| 1.9 handleHello с room: | ✓ | `server.mjs` | `makeRoomJWTs`, subscribe-before-ack, `room_jwt` в hello_ack |
| 1.10 handleRegister с user_jwt | ✓ | `server.mjs` | subscribe роутер на user: до ack, `makeUserJWT`, user_jwt в register_ack |

### Mobile

| Пункт | Статус | Файл | Что сделано |
|---|---|---|---|
| 1.11 сохранение user_jwt | ✓ | `registration_provider.dart` | При RegisterAckMessage → `_storage.saveUserJwt(userJwt)` |
| 1.12 home через user-канал | ✓ | `home_provider.dart` | `connectToUserChannel(userJwt)`, publish `GetSessionsUserMessage` в `user:<userId>` |
| 1.13 scanner → room: | ✓ | `scanner_provider.dart` | Канал исправлен: `session:$id` → `room:$id` (JWT channels claim указывает на room:) |
| 1.14 splash с user_jwt | ✓ | `app/router.dart` | State machine: user_jwt есть → connectToUserChannel / unauthorized → clearAuth → lobby. Fatal error (missing_device_id) больше не ретраит в splash |

### Тесты

| Тест | Статус | Результат |
|---|---|---|
| 1.11 register → user → get_sessions | ✓ | Проверено, работает |
| 1.12-1.13 hello → room → auth | ✓ | Проверено на реальном устройстве с Chat на room: |

---

## Этап 2: Personal bootstrap channels

### Router (`server.mjs`)

| Пункт | Статус | Что сделано |
|---|---|---|
| 2.1 `pendingBootstraps` Map | ✓ | `clientUUID → { kind, channel, state, timer }` |
| 2.2 dedup join | ✓ | `pendingBootstraps.has(clientUUID)` check в bootstrap functions |
| 2.3 dedup hello/register | ✓ | `state !== 'waiting_message'` → ignore |
| 2.4 cleanup по ack/error/leave/timer | ✓ | 4 триггера: ack, error, leave клиента, таймер 30 сек |
| 2.5 hello_error и register_error | ✓ | JSON-контракт: `{type: "hello_error"/"register_error", reason}` |
| 2.6 lobby silent | ✓ | `if (channel === '...lobby') return;` — ноль бизнес-данных |
| 2.7 legacy handleHelloFromLobby | ✓ | Удалён — все клиенты используют bootstrap |

Реализованные функции:
- `bootstrapChat(clientUUID)` — subscribe роутер + клиент на `session:<clientUUID>`
- `bootstrapMobile(clientUUID)` — subscribe роутер + клиент на `mobile:<clientUUID>`
- `cleanupBootstrap(clientUUID)` — clearTimeout + apiUnsubscribe + delete
- `handleHelloBootstrap(bootstrapClientId, data, clientUUID)` — hello через bootstrap
- `handleRegisterBootstrap(bootstrapClientId, data, clientUUID)` — register через bootstrap

onJoin handler: `session:lobby` → bootstrapChat, `mobile:lobby` → bootstrapMobile
onLeave handler: фильтр `info.user === 'router-1'` → ignore свой unsubscribe

### Chat (EPF/BSL)

| Пункт | Статус | Что сделано |
|---|---|---|
| bootstrap flow | ✓ | Chat подключается к session:lobby → Роутер видит join → subscribe Chat на session:\<clientUUID\> → Chat получает push.subscribe → hello через bootstrap-канал |
| room_jwt | ✓ | hello_ack содержит room_jwt, Chat переподключается на room:\<sessionId\> |
| presence_leave фильтр | ✓ | Фильтр leave по `router-1` — Chat игнорирует unsubscribe Роутера от bootstrap-канала |
| Lobby JWT channels claim | ✓ | JWT обновлён: добавлен `channels: ["session:lobby"]` (без этого join events не генерировались — ключевая находка) |

### Mobile (`registration_provider.dart`)

| Пункт | Статус | Что сделано |
|---|---|---|
| 2.5 bootstrap flow | ✓ | serverSubscriptions ДО connect → ожидание push.subscribe → register в bootstrap-канал |

### Тесты

| Тест | Статус | Результат |
|---|---|---|
| Node.js интеграция | ✓ | `test-stage2-bootstrap.mjs` (10/10 passed): lobby silent, register_ack через bootstrap |
| Реальное устройство | ✓ | Полный flow: connect → push.subscribe → register → register_ack → user_jwt → home |
| Повторная регистрация | ✓ | Тот же device_id → тот же user_id |
| Chat bootstrap | ✓ | Полный flow: connect lobby → push.subscribe → hello → hello_ack → room_jwt → room: |

---

## Обнаруженные проблемы и решения

### 1. `force_push_join_leave: true` (критическая)

**Проблема:** `join_leave: true` в namespace config включает генерацию событий, но **не доставляет** их подписчикам. Роутер не видел join events.

**Решение:** Добавлен `force_push_join_leave: true` на namespaces session, mobile, room. Не было в исходном плане.

### 2. Опечатка `lobby-mobile` vs `mobile-lobby` (критическая)

**Проблема:** Server API subscribe требует `user` = точное совпадение с JWT `sub`. JWT мобильного: `"sub": "mobile-lobby"`. Роутер передавал `"lobby-mobile"`. Subscribe тихо не срабатывал (HTTP 200, без error в body).

**Следствие:** Клиент не получал push.subscribe на bootstrap-канал. Это было ошибочно интерпретировано как баг centrifuge-dart protobuf transport. Потрачено значительное время на исследование ложной проблемы.

**Решение:** Исправлено на `'mobile-lobby'`.

### 3. centrifuge-dart + Server API subscribe

**Исследование:** centrifuge-dart 0.14.x полностью поддерживает Server API subscribe через protobuf. `_handleSubscribe` добавляет канал в `_serverSubs`, publications доставляются через `client.publication`. Подтверждено исходным кодом и реальным тестом после исправления опечатки.

### 4. Chat Lobby JWT без channels claim (критическая)

**Проблема:** Lobby JWT для Chat не содержал `channels` claim. Без авто-подписки через channels claim Centrifugo не генерировал join events на `session:lobby` — Роутер не видел подключение Chat.

**Решение:** JWT обновлён: добавлен `channels: ["session:lobby"]`. После этого join events стали приходить, и bootstrap Chat заработал.

### 5. scanner_provider: session: вместо room: (баг)

**Проблема:** `scanner_provider.dart` извлекал канал как `session:$id` вместо `room:$id`. После миграции на room: namespace сканер подключался к несуществующему каналу.

**Решение:** Исправлено на `room:$id`.

### 6. Fatal error retry в splash

**Проблема:** При fatal error (например `missing_device_id`) splash бесконечно ретраил подключение.

**Решение:** Fatal errors больше не ретраятся — splash показывает ошибку.

---

## Изменённые файлы

### Router (`TEST-LYRA/router/`)

| Файл | Изменения |
|---|---|
| `centrifugo.mjs` | body.error check, apiUnsubscribe, onJoin/onLeave, _handleMessage join/leave/pub, apiSubscribe с data |
| `server.mjs` | imports (makeRoomJWTs, makeUserJWT, listKnownUserIds), subscribeKnownUsers, onJoin/onLeave handlers, pendingBootstraps, bootstrapChat/Mobile, cleanupBootstrap, handleHelloBootstrap, handleRegisterBootstrap, handleGetSessionsUser, dispatch room:/user:, lobby silent, legacy handleHelloFromLobby удалён |
| `jwt.mjs` | makeRoomJWTs(), makeUserJWT() |
| `sessions.mjs` | channel `room:<sessionId>`, getByChannel парсит `room:` |
| `users.mjs` | listKnownUserIds() |
| `history.mjs` | room_jwt, user_jwt в SENSITIVE_KEYS |

### Centrifugo (`TEST-LYRA/centrifugo/`)

| Файл | Изменения |
|---|---|
| `config.json` | namespaces room: + user:, presence/join_leave/force_push_join_leave на session, mobile и room |
| `centrifugo.exe` | Обновлён v6.6.2 → v6.7.0 |

### Chat (EPF/BSL)

| Изменения |
|---|
| Bootstrap state machine: обработка push.subscribe, hello через персональный канал session:\<clientUUID\> |
| room_jwt: переподключение на room:\<sessionId\> после hello_ack |
| Lobby JWT: добавлен channels claim `["session:lobby"]` для генерации join events |
| presence_leave: фильтр по `router-1` — игнорировать unsubscribe Роутера |

### Mobile (`mobile/lyra_mobile/lib/`)

| Файл | Изменения |
|---|---|
| `core/centrifugo/centrifugo_client.dart` | serverSubscriptions стрим, connectToUserChannel, clientId getter, accountClientProvider + sessionClientProvider, обработка subscribe data |
| `core/centrifugo/message_types.dart` | RegisterAckMessage.userJwt, RegisterAckMessage.targetClient, HelloErrorMessage, GetSessionsUserMessage |
| `core/storage/secure_storage.dart` | lyra_user_jwt, getUserJwt, saveUserJwt, clearAuth, clearSessionCache |
| `core/balance_provider.dart` | Без изменений (слушает accountClient) |
| `features/registration/registration_provider.dart` | Bootstrap flow: serverSubscriptions ДО connect, ожидание push.subscribe, register в bootstrap-канал |
| `features/home/home_provider.dart` | get_sessions через user-канал (accountClient + GetSessionsUserMessage) |
| `features/scanner/scanner_provider.dart` | Канал исправлен: session:$id → room:$id |
| `app/router.dart` | Splash state machine: user_jwt → connectToUserChannel / clearAuth fallback. Fatal error не ретраит |

### Тесты (`TEST-LYRA/router/`)

| Файл | Назначение |
|---|---|
| `test-join-leave.mjs` | Формат push.join/push.leave в Centrifugo v6 |
| `test-stage2-bootstrap.mjs` | Bootstrap через персональные каналы, lobby silent |

### Удалённые файлы

| Файл | Причина |
|---|---|
| `core/centrifugo/bootstrap_client.dart` | Не нужен — centrifuge-dart protobuf работает |
| `test-stage1-flow.mjs` | Устарел после полной реализации |
| `test-dart-subscribe.mjs` | Временный тест, больше не нужен |

---

## Незавершённые пункты

| Пункт | Причина | Следующий шаг |
|---|---|---|
| Этап 3: Email bind | По плану — после lobby refactor | `get_profile`, `bind_email`, `confirm_email` на user-канале |
| Этап 4: Документация | По плану — после всего | `mobile/CLAUDE.md`, `EMAIL-BIND-PLAN.md` |

---

## Definition of Done (из плана v7)

| # | Условие | Статус |
|---|---|---|
| 1 | В lobby нет бизнес-публикаций | ✓ Подтверждено тестом (spy на lobby = 0 сообщений) |
| 2 | `session:lobby` сохранился как entry point | ✓ |
| 3 | Bootstrap не теряет первые сообщения в room: и user: | ✓ subscribe-before-ack |
| 4 | Duplicate join не создаёт вторую запись | ✓ `pendingBootstraps.has()` check |
| 5 | Duplicate hello не создаёт вторую session | ✓ `state !== 'waiting_message'` check |
| 6 | device_id переживает unauthorized fallback | ✓ `clearAuth()` не трогает device_id |
| 7 | Bootstrap cleanup игнорирует leave от router-1 | ✓ `info.user === 'router-1'` → return |
| 8 | Chat корректно обрабатывает hello_error | ✓ Chat BSL реализован: bootstrap, push.subscribe, room_jwt, presence_leave фильтр |
| 9 | pipe:\<sessionId\> не затронут | ✓ pipe: отдельный namespace, не изменён |
| 10 | Документация синхронизирована | ⏳ В процессе (этот документ) |
