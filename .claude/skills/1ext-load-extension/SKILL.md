---
name: 1ext-load-extension
description: Загрузка расширения 1С в базу Lyra. Используй когда пользователь просит загрузить расширение, обновить расширение в базе, залить расширение, "загрузи ЕХТ_Лира_Роутер", "загрузи оба расширения", "загрузил". Также используй автоматически после редактирования кода расширения, когда нужно применить изменения.
argument-hint: "<имя_расширения | all>"
---

# /1ext-load-extension — Загрузка расширения в базу Lyra

Загружает расширение из XML-исходников в базу Lyra через `1cv8.exe DESIGNER /S` (подключение к кластеру автономного сервера srv1c). Два шага: `/LoadConfigFromFiles` (импорт XML) → `/UpdateDBCfg` (применение к БД).

## Usage

```
/1ext-load-extension ЕХТ_Лира_Роутер
/1ext-load-extension ЕХТ_Центрифуга
/1ext-load-extension all
```

## Известные расширения Lyra

| Имя расширения | Исходники |
|---|---|
| ЕХТ_Лира_Роутер | `C:\1ext.ru\projects\github.com\ЕХТ_Лира_Роутер\src` |
| ЕХТ_Центрифуга | `C:\1ext.ru\projects\github.com\ЕХТ_Центрифуга\Конфигурация с вебсокетом в метаданных\src` |
| ЕХТ_Лира_Биллинг | `C:\1ext.ru\projects\github.com\ЕХТ_Лира_Биллинг\src` |
| ЕХТ_Лира_МДМ | `C:\1ext.ru\projects\github.com\ЕХТ_Лира_МДМ\src` |

## Выполнение

Запускать скрипт через `cmd //c` из Git Bash:

```bash
cmd //c "C:\\WORKS\\2026-01-31 Lyra\\.claude\\skills\\1ext-load-extension\\scripts\\load-extension.bat \"<ИСХОДНИКИ>\" \"<ИМЯ_РАСШИРЕНИЯ>\""
```

Пример:
```bash
cmd //c "C:\\WORKS\\2026-01-31 Lyra\\.claude\\skills\\1ext-load-extension\\scripts\\load-extension.bat \"C:\\1ext.ru\\projects\\github.com\\ЕХТ_Лира_Роутер\\src\" \"ЕХТ_Лира_Роутер\""
```

## После загрузки

Перезапустить автономный сервер srv1c, чтобы серверный код обновился:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command 'Start-Process powershell -ArgumentList \"-NoProfile\",\"-ExecutionPolicy\",\"Bypass\",\"-File\",\"C:\\WORKS\\2026-01-31 Lyra\\.claude\\skills\\1ext-load-extension\\scripts\\srv1c-restart.ps1\" -Verb RunAs -Wait'
```

**ВАЖНО:** НЕ убивать процессы тонкого клиента (1cv8c.exe) — это браузерные сессии пользователя.

## Правила

1. Если `all` — загрузить все известные расширения последовательно
2. После выполнения показать результат
3. Если код возврата ≠ 0 — показать ошибку и содержимое лога
4. После успешной загрузки — перезапустить srv1c (НЕ убивать тонкий клиент 1cv8c.exe!)
5. **ConfigDumpInfo.xml** — НЕ редактировать вручную, НЕ коммитить
6. Если загружается ЕХТ_Центрифуга — после загрузки предупредить: "WebSocket-соединение Роутера могло разорваться. Проверь подключение в управлении WebSocket-клиентами."
