# Lyra — инструкция по деплою

## Целевая структура

```
/opt/lyra/                          # Linux VPS
C:\LYRA\                            # Windows (разработка)
│
├── centrifugo/
│   ├── centrifugo(.exe)            # бинарник Centrifugo v6
│   └── config.json                 # конфигурация (секреты НЕ из git)
│
├── router/
│   ├── server.mjs                  # точка входа
│   ├── claude.mjs                  # spawn Claude CLI
│   ├── centrifugo.mjs              # WS-клиент + Server API
│   ├── sessions.mjs                # Map сессий, TTL
│   ├── jwt.mjs                     # HMAC SHA-256
│   ├── tools.mjs                   # HTTP endpoint для tool_call
│   ├── tools-mcp.mjs              # MCP server (stdio), спавнится Claude CLI
│   ├── protocol.mjs               # stream-json → универсальный протокол
│   ├── history.mjs                # JSONL-лог сессий
│   ├── profiles.mjs               # загрузка профилей, шаблонизация
│   ├── users.mjs                  # профили пользователей
│   ├── log.mjs                    # логирование
│   ├── config.mjs                 # загрузка конфигурации
│   ├── config.json                # конфигурация роутера
│   ├── package.json               # type: module
│   └── profiles/
│       └── default/
│           ├── model.json          # модель, mode, allowedTools
│           ├── system-prompt.md    # шаблон промпта (без техдеталей!)
│           ├── system-reminder.md  # напоминание к каждому сообщению
│           ├── tools.json          # описания инструментов
│           ├── tool-labels.json    # UI-метки инструментов
│           └── vega.json           # маппинг конфигураций → Vega порты
│
├── users/                          # данные пользователей
│   └── <user_id>/
│       ├── profile.json            # профиль (имя, уровень, токен)
│       ├── databases.json          # реестр баз
│       ├── db-<hash>.json          # настройки per-database
│       ├── memory/<config>/        # личная память
│       └── <session_id>/
│           ├── log.jsonl           # история сессии
│           └── attach/             # вложения
│
├── var/                            # переменные данные
│   ├── router.log                  # лог роутера (с ротацией)
│   └── lobby/                      # данные неавторизованных сессий
│       └── <session_id>/
│           ├── system-prompt.md    # отрендеренный промпт
│           ├── mcp-config.json     # MCP config для Claude CLI
│           └── log.jsonl           # лог сессии (до auth)
│
└── memory/                         # общая память по конфигурациям
    └── <config_name>/
        ├── registry.md
        └── skills/
```

Ни одного CLAUDE.md. Ни .git. Ни документации. Ни тестов.
Claude CLI стартует с `cwd = /opt/lyra/users/<user_id>/` — чистая директория.

---

## Предварительные требования

### Сервер

| Компонент | Минимум | Рекомендовано |
|-----------|---------|---------------|
| OS | Ubuntu 22.04 / Windows Server 2022 | Ubuntu 24.04 LTS |
| RAM | 2 GB | 4 GB |
| Диск | 20 GB SSD | 40 GB SSD |
| CPU | 2 vCPU | 4 vCPU |

### Софт

| Программа | Версия | Назначение |
|-----------|--------|------------|
| Node.js | 22+ | Router (встроенный WebSocket, fetch) |
| Centrifugo | 6.x | WebSocket-транспорт |
| Claude CLI | latest | ИИ-модель (child process) |
| Caddy | 2.x | Reverse proxy + автоматический HTTPS |

### Доступы

- Подписка Anthropic (Claude CLI авторизован: `claude login`)
- Домен с DNS A-записью на IP сервера (для HTTPS)
- SMS-сервис (API ключ для отправки SMS, например SMS.ru)

---

## Шаг 1. Подготовка директорий

### Linux

```bash
sudo mkdir -p /opt/lyra/{centrifugo,router/profiles/default,users,var/lobby,memory}
sudo chown -R lyra:lyra /opt/lyra
```

### Windows (разработка)

```powershell
# Уже создано: C:\LYRA\
mkdir C:\LYRA\centrifugo
mkdir C:\LYRA\router\profiles\default
mkdir C:\LYRA\users
mkdir C:\LYRA\var\lobby
mkdir C:\LYRA\memory
```

---

## Шаг 2. Centrifugo

### Копирование

```bash
# Linux
cp centrifugo/centrifugo /opt/lyra/centrifugo/
chmod +x /opt/lyra/centrifugo/centrifugo

# Windows
copy centrifugo\centrifugo.exe C:\LYRA\centrifugo\
```

### Генерация новых секретов

```bash
# Генерировать 4 секрета (каждый — 64 случайных байта в Base64)
openssl rand -base64 64 | tr -d '\n'   # hmac_secret_key
openssl rand -base64 32 | tr -d '\n'   # admin password
openssl rand -base64 64 | tr -d '\n'   # admin secret
openssl rand -base64 64 | tr -d '\n'   # http_api key
```

### config.json

Создать `/opt/lyra/centrifugo/config.json` с новыми секретами:

```json
{
  "token": {
    "hmac_secret_key": "<НОВЫЙ_КЛЮЧ>"
  },
  "http_server": {
    "port": "11911"
  },
  "allowed_origins": ["https://your-domain.com"],
  "admin": {
    "enabled": false
  },
  "http_api": {
    "key": "<НОВЫЙ_КЛЮЧ>"
  },
  "namespaces": [
    {
      "name": "session",
      "allow_subscribe_for_client": false,
      "allow_publish_for_client": true
    },
    {
      "name": "mobile",
      "allow_subscribe_for_client": false,
      "allow_publish_for_client": true
    },
    {
      "name": "pipe",
      "allow_subscribe_for_client": false,
      "allow_publish_for_client": false
    },
    {
      "name": "service",
      "allow_subscribe_for_client": false,
      "allow_publish_for_client": false
    }
  ],
  "client": {
    "channel_limit": 16
  }
}
```

Изменения по сравнению с dev:
- `allowed_origins` — конкретный домен (не `*`)
- `admin.enabled: false`
- `pipe:` — `allow_publish_for_client: false` (SEC-05)
- `service:` — оба `false` (SEC-06)
- Все секреты новые

---

## Шаг 3. Router

### Копирование файлов

```bash
# Из репозитория → deploy
SRC="Router"
DST="/opt/lyra/router"

# Код (только .mjs и .json)
for f in server.mjs claude.mjs centrifugo.mjs sessions.mjs jwt.mjs \
         tools.mjs tools-mcp.mjs protocol.mjs history.mjs \
         profiles.mjs users.mjs log.mjs config.mjs package.json; do
  cp "$SRC/$f" "$DST/$f"
done

# Профиль
cp "$SRC/profiles/default/"* "$DST/profiles/default/"
```

НЕ копировать: `CLAUDE.md`, `test-*.mjs`, `TASK-*.md`, `.users/`, `.lobby/`, `router.log`, `router.pid`, `ЕХТ_*`

### config.json роутера

Создать `/opt/lyra/router/config.json`:

```json
{
  "centrifugo": {
    "wsUrl": "ws://localhost:11911/connection/websocket",
    "apiUrl": "http://localhost:11911/api",
    "hmacSecret": "<тот же hmac_secret_key из centrifugo/config.json>",
    "apiKey": "<тот же http_api.key из centrifugo/config.json>"
  },
  "dataDir": "/opt/lyra",
  "profilePath": "/opt/lyra/router/profiles/default"
}
```

`dataDir` — базовый путь для `users/`, `var/`, `memory/`. Router использует его вместо `__dirname/.users/`.

### Адаптация путей в коде

Router сейчас использует `__dirname` для `.users/`, `.lobby/`, `memory/`. Нужно переключить на `config.dataDir`:

| Файл | Было | Стало |
|------|------|-------|
| `claude.mjs` | `cwd: resolve(__dirname, '.users', userId)` | `cwd: resolve(dataDir, 'users', userId)` |
| `users.mjs` | `resolve(__dirname, '.users', userId)` | `resolve(dataDir, 'users', userId)` |
| `history.mjs` | `resolve(__dirname, '.lobby', sessionId)` | `resolve(dataDir, 'var/lobby', sessionId)` |
| `history.mjs` | `resolve(__dirname, '.users', userId)` | `resolve(dataDir, 'users', userId)` |
| `tools-mcp.mjs` | `resolve(__dirname, '.users', userId, 'memory')` | `resolve(dataDir, 'users', userId, 'memory')` |
| `tools-mcp.mjs` | `resolve(__dirname, 'memory')` | `resolve(dataDir, 'memory')` |
| `log.mjs` | `resolve(__dirname, 'router.log')` | `resolve(dataDir, 'var/router.log')` |

---

## Шаг 4. Lobby JWT

Сгенерировать **новые** общие JWT (подписанные новым `hmac_secret_key`):

### Chat lobby JWT

```javascript
// payload
{
  "sub": "lobby-user",
  "exp": <now + 1 год>,
  "iat": <now>
}
```

Зашить в Chat EPF (`МодульТранспорт/Module.bsl`, строка 51).

### Mobile lobby JWT

```javascript
// payload
{
  "sub": "mobile-lobby",
  "channels": ["mobile:lobby"],
  "exp": <now + 1 год>,
  "iat": <now>
}
```

Зашить в мобильное приложение (`centrifugo_config.dart`).

**Скрипт для генерации JWT** (Node.js, использует jwt.mjs Роутера):

```bash
cd /opt/lyra/router
node -e "
  import { makeJWT } from './jwt.mjs';
  const secret = '<hmac_secret_key>';
  const exp = Math.floor(Date.now()/1000) + 365*24*3600;
  console.log('Chat JWT:', makeJWT(secret, {sub:'lobby-user', exp}));
  console.log('Mobile JWT:', makeJWT(secret, {sub:'mobile-lobby', channels:['mobile:lobby'], exp}));
"
```

---

## Шаг 5. TLS/HTTPS (Caddy)

### Caddyfile

```
lyra.your-domain.com {
    # Centrifugo WebSocket
    handle /connection/* {
        reverse_proxy localhost:11911
    }

    # Centrifugo API (только с localhost, не пробрасывать наружу)
    # handle /api/* — НЕ проксировать

    # Будущее: сайт, личный кабинет
    handle {
        respond "Lyra" 200
    }
}
```

Caddy автоматически получает и обновляет Let's Encrypt сертификат.

### Обновить wsUrl в клиентах

- Chat EPF: `wss://lyra.your-domain.com/connection/websocket`
- Mobile: `wss://lyra.your-domain.com/connection/websocket`

---

## Шаг 6. Systemd-сервисы (Linux)

### centrifugo.service

```ini
[Unit]
Description=Lyra Centrifugo
After=network.target

[Service]
Type=simple
User=lyra
WorkingDirectory=/opt/lyra/centrifugo
ExecStart=/opt/lyra/centrifugo/centrifugo --config=config.json
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### lyra-router.service

```ini
[Unit]
Description=Lyra Router
After=network.target centrifugo.service
Requires=centrifugo.service

[Service]
Type=simple
User=lyra
WorkingDirectory=/opt/lyra/router
ExecStart=/usr/bin/node server.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Управление

```bash
sudo systemctl enable centrifugo lyra-router
sudo systemctl start centrifugo lyra-router
sudo systemctl status centrifugo lyra-router
journalctl -u lyra-router -f    # логи в реальном времени
```

---

## Шаг 6.5. Firewall

### Linux (ufw)

```bash
sudo ufw allow 443/tcp    # HTTPS (Caddy)
sudo ufw allow 22/tcp     # SSH
# Centrifugo (11911) НЕ открывать — трафик идёт через Caddy
```

### Windows (для локальной разработки)

Мобильное подключается по Wi-Fi к IP компьютера (`192.168.x.x:11911`). Windows Firewall привязывает правила к пути exe — при смене папки нужно новое правило.

```powershell
# PowerShell от администратора
$params = @{
  DisplayName = "centrifugo-lyra"
  Direction = "Inbound"
  Action = "Allow"
  Program = "C:\LYRA\centrifugo\centrifugo.exe"
  Protocol = "TCP"
  Profile = "Private,Public"
}
New-NetFirewallRule @params
```

Для TEST-LYRA (разработка) — аналогично с путём `C:\WORKS\...\TEST-LYRA\centrifugo\centrifugo.exe`.

---

## Шаг 7. Проверка

### 1. Centrifugo работает

```bash
curl http://localhost:11911/health
# {"status":"ok"}
```

### 2. Router подключился

```bash
tail -5 /opt/lyra/var/router.log
# [INFO] [centrifugo] Connected to Centrifugo
# [INFO] [server] Lyra Router started
```

### 3. WebSocket доступен извне

```bash
# С другой машины
wscat -c wss://lyra.your-domain.com/connection/websocket
```

### 4. Полный флоу

1. Открыть Chat EPF в 1С → hello → QR-код
2. Отсканировать QR мобильным → auth_ack
3. Написать «Привет» → ответ от Лиры
4. Проверить: Лира НЕ упоминает Claude, Router, MCP, Centrifugo

---

## Шаг 8. Windows (C:\LYRA) — локальная отработка

Перед VPS всё проверяем на локальной машине:

```
C:\LYRA\
├── centrifugo\config.json     ← новые секреты
├── router\                    ← код из репозитория (без CLAUDE.md)
├── users\                     ← cwd для Claude CLI
├── var\                       ← логи, lobby
└── memory\                    ← общая память
```

```powershell
# Запуск
cd C:\LYRA\centrifugo && .\centrifugo.exe --config=config.json
cd C:\LYRA\router && node server.mjs
```

---

## Чеклист безопасности перед запуском

- [ ] Секреты сгенерированы заново (не из git)
- [ ] `centrifugo/config.json`: `allowed_origins` — конкретный домен
- [ ] `centrifugo/config.json`: `admin.enabled: false`
- [ ] `centrifugo/config.json`: `pipe:` publish запрещён
- [ ] `centrifugo/config.json`: `service:` subscribe/publish запрещены
- [ ] Нет CLAUDE.md нигде в дереве `/opt/lyra/`
- [ ] `system-prompt.md` не содержит технических деталей архитектуры
- [ ] `router.log` не логирует SMS-коды
- [ ] TLS включён (Caddy / nginx)
- [ ] Server API недоступен извне (только localhost)
- [ ] `verifyAuth()` проверяет пару (user_id, device_id) в MDM
- [ ] Firewall: открыты только 443 (HTTPS) и 22 (SSH)

---

## Миграция данных

При переезде с dev на VPS:

```bash
# Пользователи
rsync -av C:\LYRA\users\ user@vps:/opt/lyra/users/

# Общая память
rsync -av C:\LYRA\memory\ user@vps:/opt/lyra/memory/
```

Логи и lobby — не переносятся (эфемерные данные).
