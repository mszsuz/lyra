# Lyra-Chat — внешняя обработка 1С

Общайся с пользователем на русском языке.

## Что это

Чат-клиент для 1С:Предприятие 8. Внешняя обработка (EPF) с HTML-интерфейсом на базе фреймворка ЕХТ_Чат. Подключается к Bridge по WebSocket, стримит ответы Claude в реальном времени.

## Архитектура

Модульная: главная форма (контроллер) + служебные формы-модули (Bridge, Парсер, MCP).
Подробности: [ARCHITECTURE.md](ARCHITECTURE.md), [README.md](README.md)

## Стек

- Платформа 1С:Предприятие 8.3 (язык BSL)
- HTML/JS чат-виджет (фреймворк ЕХТ_Чат от 1ext.com)
- WebSocket-клиент (встроенный в платформу)

## Сборка

```bash
# Из папки Chat/ (где лежит .1c-devbase.bat):
build-epf.bat "Lyra-Chat-multiform.epf/src" "Lyra-Chat-multiform.epf/Lyra-Chat-multiform.epf"
```

Подробности: раздел "Сборка EPF" в [README.md](README.md)

## Ключевые файлы

- `Lyra-Chat-multiform.epf/src/` — исходники (XML + BSL)
- `Форма/Module.bsl` — главная форма (контроллер, стриминг, ЕХТ_Чат)
- `МодульBridge/Module.bsl` — WebSocket-соединение
- `МодульПарсер/Module.bsl` — JSON через ЧтениеJSON
- `МодульMCP/Module.bsl` — MCP strategy-dispatch
- `ARCHITECTURE.md` — архитектура и паттерны
- `BACKLOG.md` — бэклог задач

## Папка "! Удалить"

Содержит устаревшие версии и эксперименты. Можно удалить когда не нужны для справки.
