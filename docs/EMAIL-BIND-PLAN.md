# Привязка email к аккаунту — план реализации

Предпосылка: [ACCOUNT-RECOVERY-PLAN-AUDIT.md](ACCOUNT-RECOVERY-PLAN-AUDIT.md) рекомендует реализовать привязку email **отдельно и до** recovery. Этот план — именно привязка, без recovery.

## Цель

Пользователь может привязать и подтвердить email к своему аккаунту. Email хранится на сервере, является уникальным и подтверждённым. Это подготовка к будущему восстановлению аккаунта.

## Что НЕ входит в этот план

- Recovery на новом устройстве (отдельный этап после)
- Изменение splash/авто-регистрации
- Реальная отправка email (на первом этапе код выводится в лог)

---

## 0. Архитектурное решение: персональный канал user:\<user_id\>

### Принцип

Lobby (`mobile:lobby`) — **только** для первичного подключения:
- `register` → `register_ack` с JWT для персонального канала

Все остальные account-операции идут через **персональный канал** `user:<user_id>`:
- `get_profile`, `get_sessions` (перенос из lobby)
- `bind_email`, `confirm_email` (новое)

### Почему

1. **Изоляция** — ответы видит только владелец, а не все клиенты lobby
2. **Нет request_id** — на персональном канале request_id не нужен (один клиент = один канал)
3. **Масштабируемость** — lobby не засоряется account-трафиком
4. **Безопасность** — email, баланс, список сессий не утекают в broadcast

### Namespace в Centrifugo config.json

```json
{
  "namespaces": [
    {
      "name": "user",
      "allow_subscribe_for_client": false,
      "allow_publish_for_client": true
    }
  ]
}
```

`allow_subscribe_for_client: false` — подписка только через JWT channels claim (как session:).

### JWT для персонального канала

При регистрации (`register_ack`) роутер возвращает `user_jwt` — токен с channels claim `["user:<user_id>"]`.

```
register_ack: {
  type: "register_ack",
  status: "ok",
  user_id: "<uuid>",
  user_jwt: "<jwt>",        ← НОВОЕ
  balance: 0,
  currency: "руб"
}
```

Мобильное сохраняет `user_jwt` в secure storage. При следующих запусках подключается к `user:<user_id>` напрямую, без lobby.

**Срок жизни user_jwt**: 1 год (как session JWT). Refresh — при следующей регистрации (переустановка).

### Жизненный цикл подключений мобильного

```
Первый запуск:
  1. connectToLobby(mobileLobbyJwt)       ← общий JWT
  2. publish register {device_id}
  3. receive register_ack {user_id, user_jwt}
  4. disconnect from lobby
  5. connectToUser(user_jwt)               ← персональный канал user:<user_id>
  6. → home

Последующие запуски (user_id + user_jwt есть в storage):
  1. connectToUser(user_jwt)               ← сразу персональный канал
  2. → home

Экран профиля:
  - get_profile, bind_email, confirm_email → через user:<user_id>

Экран home:
  - get_sessions → через user:<user_id>

Сканер QR → сессия:
  - connectToSession(mobile_jwt)           ← канал session:<session_id> (без изменений)
```

### Роутер: подписка на user:\<user_id\>

Роутер подписывается на `user:<user_id>` через Server API `subscribe` при регистрации (и при auth для известных пользователей). При рестарте — переподписка на активных.

Вариант проще: роутер **не подписывается** на user-каналы постоянно. Вместо этого мобильное всегда отправляет через `publish` (клиенту разрешён publish), а роутер слушает через Server API `subscribe` по требованию — или роутер подписан через wildcard `user:*`.

**Рекомендация**: роутер подключён с JWT, содержащим `user:*` в channels (или namespace-level subscribe). Центрифуго v6 не поддерживает wildcard в channels claim — поэтому роутер подписывается на конкретные `user:<id>` каналы при регистрации, аналогично session-каналам.

---

## 1. Протокол (канал user:\<user_id\>)

Все команды идут через персональный канал. request_id не нужен — ответы адресованы одному клиенту.

### Привязка email (шаг 1 — запрос кода)

```
→ user:<user_id>
{
  type: "bind_email",
  user_id: "<user_id>",
  device_id: "<device_id>",
  email: "User@Mail.ru"
}

← user:<user_id>
{
  type: "bind_email_ack",
  status: "code_sent"
}

или ошибка:
{
  type: "bind_email_ack",
  status: "error",
  reason: "email_already_taken" | "invalid_email" | "too_many_requests" | "auth_failed"
}
```

### Подтверждение кода (шаг 2)

```
→ user:<user_id>
{
  type: "confirm_email",
  user_id: "<user_id>",
  device_id: "<device_id>",
  email: "User@Mail.ru",
  code: "481729"
}

← user:<user_id>
{
  type: "confirm_email_ack",
  status: "ok",
  email: "user@mail.ru"
}

или ошибка:
{
  type: "confirm_email_ack",
  status: "error",
  reason: "invalid_code" | "expired" | "too_many_attempts" | "auth_failed"
}
```

### Запрос профиля (перенос с lobby)

```
→ user:<user_id>
{
  type: "get_profile",
  user_id: "<user_id>",
  device_id: "<device_id>"
}

← user:<user_id>
{
  type: "profile",
  user_id: "<user_id>",
  email: "user@mail.ru" | null,
  email_verified: true | false,
  balance: 150.00,
  currency: "руб",
  user_name: "Андрей" | null,
  user_role: "user" | null,
  created_at: "2026-03-28T..."
}
```

### Список сессий (перенос с lobby)

```
→ user:<user_id>
{
  type: "get_sessions",
  user_id: "<user_id>"
}

← user:<user_id>
{
  type: "sessions_list",
  user_id: "<user_id>",
  sessions: [...]
}
```

---

## 2. Роутер (server.mjs + users.mjs)

### 2.1. Centrifugo config.json — namespace user:

Добавить namespace:

```json
{
  "name": "user",
  "allow_subscribe_for_client": false,
  "allow_publish_for_client": true
}
```

### 2.2. JWT для user-канала (server.mjs)

Новая функция `makeUserJWT(userId, hmacSecret)`:
- sub: `user-<userId>`
- channels: `["user:<userId>"]`
- exp: +1 год

Вызывается при `handleMobileRegister` — возвращается в `register_ack`.

### 2.3. Подписка роутера на user-каналы

При регистрации нового пользователя:
```js
await centrifugo.subscribe(`user:${userId}`);
```

При запуске роутера — подписаться на каналы всех известных пользователей:
```js
// В loadDeviceMapping() собирать список user_id
// После connect — subscribe на каждый user:<id>
```

### 2.4. Диспетчер push для user:\<user_id\>

Добавить в `onPush`:

```js
// --- user:* (personal user channels) ---
if (channel.startsWith('user:')) {
  const userId = channel.slice('user:'.length);
  switch (data.type) {
    case 'get_profile':   handleGetProfile(userId, data);   break;
    case 'get_sessions':  handleGetSessions(data);           break;
    case 'bind_email':    handleBindEmail(userId, data);     break;
    case 'confirm_email': handleConfirmEmail(userId, data);  break;
  }
  return;
}
```

### 2.5. Перенос get_sessions с lobby на user-канал

- Убрать `get_sessions` из диспетчера `mobile:lobby`
- `handleGetSessions` публикует ответ в `user:<user_id>` вместо `mobile:lobby`
- Обратная совместимость: оставить на lobby временно с deprecation log (или убрать сразу — клиент обновляется одновременно)

### 2.6. Новые поля в profile.json

```json
{
  "device_id": "uuid",
  "email": "user@mail.ru",
  "email_verified": true,
  "created_at": "..."
}
```

Email хранится в **нормализованной** форме: `trim().toLowerCase()`.

### 2.7. Email-индекс (users.mjs)

```js
const emailToUser = new Map();  // email (normalized) → user_id
```

Строится при `loadDeviceMapping()` (переименовать в `loadUserIndex()`). Индексируются **только** `email_verified: true`.

### 2.8. Pending-коды (in-memory)

```js
const pendingCodes = new Map();  // key = userId → {code, email, createdAt, attempts, expiresAt}
```

- 6 цифр, TTL 10 мин, макс. 3 попытки
- Cooldown 60 сек между запросами
- In-memory — рестарт роутера обнуляет (MVP-допущение)

### 2.9. Новые функции в users.mjs

```
normalizeEmail(email)
  → trim().toLowerCase(), валидация формата

requestEmailBind(userId, email)
  → normalizeEmail
  → emailToUser: если занят другим → "email_already_taken"
  → cooldown check
  → генерация 6-значного кода
  → pendingCodes.set(userId, {...})
  → лог: "Email verification code for <userId>: <code>"
  → {ok: true}

confirmEmailBind(userId, email, code)
  → normalizeEmail
  → pendingCodes.get(userId)
  → проверка TTL, attempts, совпадение кода
  → при неверном: attempts++, при >= 3 → удалить
  → при верном:
    → удалить старый email из emailToUser (если был)
    → profile.email = normalized
    → profile.email_verified = true
    → emailToUser.set(email, userId)
    → saveProfile()
    → {ok: true, email}

getPublicProfile(userId)
  → {email, email_verified, balance, user_name, user_role, created_at}
```

---

## 3. Мобильное приложение (Flutter)

### 3.1. Secure storage — новые ключи

- `lyra_user_jwt` — JWT для подключения к `user:<user_id>`

### 3.2. CentrifugoClient — новый метод

```dart
connectToUserChannel(String userJwt)
  // аналогично connectToSession, но для user: канала
```

### 3.3. Изменения в registration_provider.dart

После получения `register_ack`:
- Сохранить `user_jwt` в secure storage
- Подключиться к `user:<user_id>` через `connectToUserChannel(user_jwt)`

### 3.4. Изменения в router.dart (splash)

При наличии `user_id` + `user_jwt` в storage:
- Подключиться к `user:<user_id>` (вместо lobby)
- Перейти на home

### 3.5. Новые типы сообщений (message_types.dart)

**Исходящие:**

```dart
class BindEmailMessage extends OutgoingMessage {
  final String userId;
  final String deviceId;
  final String email;
  // → {type: "bind_email", user_id, device_id, email}
}

class ConfirmEmailMessage extends OutgoingMessage {
  final String userId;
  final String deviceId;
  final String email;
  final String code;
  // → {type: "confirm_email", user_id, device_id, email, code}
}

class GetProfileMessage extends OutgoingMessage {
  final String userId;
  final String deviceId;
  // → {type: "get_profile", user_id, device_id}
}
```

**Входящие:**

```dart
class BindEmailAckMessage implements IncomingMessage {
  final String status;       // "code_sent" | "error"
  final String? reason;
}

class ConfirmEmailAckMessage implements IncomingMessage {
  final String status;       // "ok" | "error"
  final String? email;       // normalized, при успехе
  final String? reason;
}

class ProfileMessage implements IncomingMessage {
  final String userId;
  final String? email;
  final bool emailVerified;
  final double balance;
  final String? currency;
  final String? userName;
  final String? userRole;
  final String? createdAt;
}
```

Без `requestId` — на персональном канале не нужен.

### 3.6. Перенос get_sessions на user-канал

`home_provider.dart`: `loadSessions()` публикует `get_sessions` в `user:<user_id>` вместо `mobile:lobby`.

### 3.7. Новый файл: email_provider.dart

```dart
enum EmailBindStep { idle, sendingCode, waitingCode, confirming, done, error }

class EmailBindState {
  final EmailBindStep step;
  final String? email;
  final bool emailVerified;
  final String? errorMessage;
}

class EmailBindNotifier extends StateNotifier<EmailBindState> {
  // requestBind(email)
  //   → publish BindEmailMessage в user:<user_id>
  //   → слушать BindEmailAckMessage
  //   → step = waitingCode

  // confirmCode(email, code)
  //   → publish ConfirmEmailMessage
  //   → слушать ConfirmEmailAckMessage
  //   → step = done

  // loadProfile()
  //   → publish GetProfileMessage
  //   → слушать ProfileMessage
  //   → обновить email/emailVerified из серверного ответа
}
```

### 3.8. Изменения в profile_screen.dart

Секция **Email** между «Как общаться» и «Сохранить»:

1. **Email не привязан** — поле ввода + кнопка «Привязать»
2. **Код отправлен** — 6 полей ввода кода + «Подтвердить» + таймер повтора
3. **Email подтверждён** — readonly с зелёной галочкой

При входе: `loadProfile()` — серверный статус.

---

## 4. Порядок реализации

### Шаг 1: Centrifugo — namespace user:

1. Добавить namespace `user` в `config.json`
2. Перезапустить Centrifugo

### Шаг 2: Роутер — user-канал и перенос get_sessions

1. `server.mjs`: `makeUserJWT()`, возврат `user_jwt` в `register_ack`
2. `server.mjs`: подписка роутера на `user:<id>` при регистрации
3. `server.mjs`: диспетчер `user:*` в onPush
4. `server.mjs`: перенести `handleGetSessions` → publish в `user:<user_id>`
5. `users.mjs`: переименовать `loadDeviceMapping()` → `loadUserIndex()`, добавить emailToUser
6. Подписка при старте на user-каналы всех известных пользователей

### Шаг 3: Роутер — email bind

1. `users.mjs`: `normalizeEmail()`, `requestEmailBind()`, `confirmEmailBind()`, `getPublicProfile()`
2. `users.mjs`: pendingCodes
3. `server.mjs`: обработчики `bind_email`, `confirm_email`, `get_profile`

### Шаг 4: Тест роутера

- `test-user-channel.mjs`: подключение к user-каналу, get_sessions, get_profile
- `test-email-bind.mjs`: bind_email → код из лога → confirm_email → get_profile → verified

### Шаг 5: Мобильное — user-канал

1. `secure_storage.dart`: `lyra_user_jwt`
2. `centrifugo_client.dart`: `connectToUserChannel()`
3. `registration_provider.dart`: сохранение user_jwt, подключение к user-каналу
4. `router.dart` (splash): подключение к user-каналу при наличии user_jwt
5. `home_provider.dart`: get_sessions через user-канал
6. `message_types.dart`: новые типы

### Шаг 6: Мобильное — email UI

1. `email_provider.dart`
2. `profile_screen.dart`: секция Email

### Шаг 7: Сборка и тест

1. Собрать APK
2. Чистая установка → регистрация → получение user_jwt → home → get_sessions работает
3. Профиль → привязка email (код из лога) → подтверждение → «Email подтверждён»
4. Переустановка → профиль → loadProfile → email по-прежнему подтверждён (сервер)

---

## 5. Безопасность (MVP)

- **verifyAuth** на каждую команду в user-канале (user_id + device_id)
- **JWT** для user-канала — доступ только владельцу
- **Нормализация email**: `trim().toLowerCase()`
- **Уникальность**: один verified email = один user
- **Код**: 6 цифр, TTL 10 мин, макс. 3 попытки
- **Cooldown**: 60 сек между запросами кода
- **In-memory коды**: рестарт = потеря pending (MVP-допущение)

---

## 6. Что это даёт

- **Персональный канал** `user:<user_id>` — фундамент для всех account-операций (email, профиль, сессии, будущий recovery, пополнение)
- **Lobby чист** — только register, как и задумано
- **Email привязан на сервере** — подготовка к recovery
- **get_profile** как контракт — полезен для синхронизации имени, роли, email между устройствами
- **Нет request_id** — изоляция каналов решает проблему broadcast элегантнее
