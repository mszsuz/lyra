# Lyra Model Adapter API

Спецификация универсального интерфейса для подключения ИИ-моделей к Lyra.

## Концепция

```
Чат (1С) ──► Centrifugo ──► Router ──► ModelAdapter ──► Claude API / OpenAI / Gemini / Ollama / ...
                                          │
                                          ├── session (история, промпт, инструменты)
                                          ├── events (стриминг ответа)
                                          └── tools (вызов инструментов)
```

Router общается с моделью через **ModelAdapter** — единый интерфейс, за которым стоит адаптер конкретного провайдера. Downstream протокол (Router → Chat) не меняется.

## ModelAdapter Interface

```json
{
  "interface": "ModelAdapter",
  "version": "1.0",
  "methods": {
    "init": {
      "description": "Инициализация адаптера. Возвращает capabilities модели.",
      "input": { "$ref": "#/types/AdapterConfig" },
      "output": { "$ref": "#/types/Capabilities" }
    },
    "chat": {
      "description": "Отправить сообщение и получить ответ (стрим событий).",
      "input": { "$ref": "#/types/ChatRequest" },
      "output": "Stream<Event>"
    },
    "abort": {
      "description": "Прервать текущую генерацию.",
      "input": { "session_id": "string" },
      "output": { "ok": "boolean" }
    }
  }
}
```

## Types

### AdapterConfig

Конфигурация адаптера при инициализации.

```json
{
  "type": "AdapterConfig",
  "fields": {
    "provider": {
      "type": "string",
      "description": "Идентификатор провайдера: claude, openai, gemini, ollama, custom",
      "required": true
    },
    "api_key": {
      "type": "string",
      "description": "API-ключ провайдера. Может быть из настроек Роутера или пользователя.",
      "required": false
    },
    "base_url": {
      "type": "string",
      "description": "Base URL API. Для OpenAI-совместимых: http://localhost:11434/v1",
      "required": false
    },
    "model": {
      "type": "string",
      "description": "Идентификатор модели: claude-sonnet-4-6, gpt-4o, gemini-2.5-pro, llama3.3",
      "required": true
    },
    "options": {
      "type": "object",
      "description": "Дополнительные параметры провайдера (temperature, max_tokens и т.д.)",
      "required": false
    }
  }
}
```

### Capabilities

Возможности модели. Адаптер заполняет при `init`.

```json
{
  "type": "Capabilities",
  "fields": {
    "streaming": {
      "type": "boolean",
      "description": "Поддерживает стриминг ответа (text_delta). Если false — отправляет пустые delta, в конце полный текст."
    },
    "tool_calls": {
      "type": "boolean",
      "description": "Поддерживает вызов инструментов (function calling)."
    },
    "vision": {
      "type": "boolean",
      "description": "Поддерживает изображения на входе."
    },
    "thinking": {
      "type": "boolean",
      "description": "Поддерживает extended thinking / chain-of-thought."
    },
    "max_context_tokens": {
      "type": "integer",
      "description": "Максимальный размер контекста в токенах."
    },
    "max_output_tokens": {
      "type": "integer",
      "description": "Максимальный размер ответа в токенах."
    }
  }
}
```

### ChatRequest

Запрос к модели.

```json
{
  "type": "ChatRequest",
  "fields": {
    "session_id": {
      "type": "string",
      "description": "Идентификатор сессии. Адаптер использует для управления историей.",
      "required": true
    },
    "system_prompt": {
      "type": "string",
      "description": "Системный промпт. Передаётся при каждом запросе (адаптер решает как использовать).",
      "required": false
    },
    "messages": {
      "type": "array",
      "items": { "$ref": "#/types/Message" },
      "description": "История сообщений сессии. Включает все предыдущие сообщения + текущее.",
      "required": true
    },
    "tools": {
      "type": "array",
      "items": { "$ref": "#/types/ToolDefinition" },
      "description": "Доступные инструменты для вызова моделью.",
      "required": false
    },
    "options": {
      "type": "object",
      "description": "Параметры генерации (temperature, max_tokens и т.д.).",
      "required": false
    }
  }
}
```

### Message

Сообщение в истории диалога.

```json
{
  "type": "Message",
  "fields": {
    "role": {
      "type": "string",
      "enum": ["system", "user", "assistant", "tool_result"],
      "description": "Роль отправителя.",
      "required": true
    },
    "content": {
      "type": "string | array",
      "description": "Текст сообщения. Для multimodal — массив частей (text, image).",
      "required": true
    },
    "tool_use_id": {
      "type": "string",
      "description": "ID вызова инструмента (для role=tool_result).",
      "required": false
    },
    "attachments": {
      "type": "array",
      "items": { "$ref": "#/types/Attachment" },
      "description": "Вложения (фото, файлы).",
      "required": false
    }
  }
}
```

### Attachment

Вложение к сообщению.

```json
{
  "type": "Attachment",
  "fields": {
    "kind": {
      "type": "string",
      "enum": ["image", "file"],
      "description": "Тип вложения.",
      "required": true
    },
    "data": {
      "type": "string",
      "description": "Содержимое в base64.",
      "required": true
    },
    "media_type": {
      "type": "string",
      "description": "MIME-тип: image/jpeg, image/png, application/pdf",
      "required": true
    },
    "name": {
      "type": "string",
      "description": "Имя файла.",
      "required": false
    }
  }
}
```

### ToolDefinition

Описание инструмента для модели.

```json
{
  "type": "ToolDefinition",
  "fields": {
    "name": {
      "type": "string",
      "description": "Уникальное имя инструмента: lyra_data_query, lyra_meta_list",
      "required": true
    },
    "description": {
      "type": "string",
      "description": "Описание для модели — когда и зачем вызывать.",
      "required": true
    },
    "input_schema": {
      "type": "object",
      "description": "JSON Schema параметров инструмента.",
      "required": true
    }
  }
}
```

### ToolResult

Результат выполнения инструмента, возвращаемый модели.

```json
{
  "type": "ToolResult",
  "fields": {
    "tool_use_id": {
      "type": "string",
      "description": "ID вызова (из события tool_use).",
      "required": true
    },
    "content": {
      "type": "string",
      "description": "Результат выполнения (JSON-строка или текст).",
      "required": true
    },
    "is_error": {
      "type": "boolean",
      "description": "Результат — ошибка.",
      "required": false
    }
  }
}
```

## Events (Stream)

Адаптер возвращает поток событий. Каждое событие — JSON-объект с полем `type`.

### text_delta

Фрагмент текста ответа (стриминг).

```json
{
  "type": "text_delta",
  "text": "фрагмент текста"
}
```

Если модель не поддерживает стриминг (`capabilities.streaming = false`), адаптер отправляет один `text_delta` с пустым текстом, затем `assistant_end` с полным текстом.

### thinking_start

Начало блока размышлений (extended thinking / chain-of-thought).

```json
{
  "type": "thinking_start"
}
```

### thinking_delta

Фрагмент размышлений.

```json
{
  "type": "thinking_delta",
  "text": "фрагмент размышлений"
}
```

### thinking_end

Конец блока размышлений.

```json
{
  "type": "thinking_end"
}
```

### tool_use

Модель хочет вызвать инструмент.

```json
{
  "type": "tool_use",
  "id": "unique-call-id",
  "name": "lyra_data_query",
  "input": {
    "query": "ВЫБРАТЬ ПЕРВЫЕ 10 ...",
    "params": {}
  }
}
```

Router выполняет инструмент, получает результат и передаёт модели через `ChatRequest.messages` с `role: "tool_result"`.

### assistant_end

Генерация завершена.

```json
{
  "type": "assistant_end",
  "text": "полный текст ответа",
  "usage": {
    "input_tokens": 1500,
    "output_tokens": 300,
    "cache_read_tokens": 0,
    "cache_write_tokens": 0
  },
  "cost_usd": 0.0123,
  "model": "claude-sonnet-4-6",
  "stop_reason": "end_turn"
}
```

Поля `usage` и `cost_usd`:
- Адаптер заполняет `usage` из ответа провайдера
- Адаптер рассчитывает `cost_usd` по тарифам провайдера
- Если провайдер не отдаёт cost — адаптер рассчитывает по `usage` и известным ценам
- Если рассчитать невозможно — `cost_usd: null`

### error

Ошибка генерации.

```json
{
  "type": "error",
  "message": "Rate limit exceeded",
  "code": "rate_limited",
  "retryable": true
}
```

## Session Management

Адаптер **не хранит** историю сообщений. Router передаёт полную историю в `ChatRequest.messages` при каждом запросе. Это позволяет:
- Хранить историю в одном месте (Router)
- Переключать модель посреди сессии
- Восстанавливать сессию после перезапуска

Адаптер может использовать `session_id` для:
- Кэширования контекста (prompt caching)
- Управления внутренним состоянием провайдера
- Логирования

## Tool Call Flow

```
1. Router → adapter.chat(request)    // messages + tools
2. Adapter → event: tool_use         // модель хочет вызвать инструмент
3. Router выполняет инструмент       // через Centrifugo → Chat 1С → result
4. Router → adapter.chat(request)    // messages + tool_result
5. Adapter → event: text_delta...    // модель продолжает ответ
6. Adapter → event: assistant_end    // завершение
```

Шаги 2-5 могут повторяться (модель вызывает несколько инструментов).

## Adapter Registration

Адаптеры регистрируются в конфигурации Роутера:

```json
{
  "adapters": {
    "claude": {
      "module": "./adapters/claude.mjs",
      "config": {
        "api_key": "${ANTHROPIC_API_KEY}"
      }
    },
    "openai": {
      "module": "./adapters/openai.mjs",
      "config": {
        "api_key": "${OPENAI_API_KEY}"
      }
    },
    "ollama": {
      "module": "./adapters/ollama.mjs",
      "config": {
        "base_url": "http://localhost:11434/v1"
      }
    }
  }
}
```

## User Model Selection

Модель выбирается per-user в профиле:

```json
{
  "user_name": "Андрей",
  "model": {
    "adapter": "claude",
    "model": "claude-sonnet-4-6"
  }
}
```

Если у пользователя свой API-ключ:

```json
{
  "model": {
    "adapter": "openai",
    "model": "gpt-4o",
    "api_key": "sk-..."
  }
}
```

Приоритет ключа: `user.model.api_key` > `adapter.config.api_key` > `env`.

## Adapter Implementation Contract

Адаптер — ES-модуль (`.mjs`) экспортирующий класс:

```javascript
export class ClaudeAdapter {
  // Инициализация, возвращает capabilities
  async init(config) → Capabilities

  // Отправить запрос, вернуть async generator событий
  async *chat(request) → AsyncGenerator<Event>

  // Прервать генерацию
  async abort(sessionId) → { ok: boolean }
}
```

### Minimal Adapter Example

```javascript
export class EchoAdapter {
  async init(config) {
    return {
      streaming: true,
      tool_calls: false,
      vision: false,
      thinking: false,
      max_context_tokens: 4096,
      max_output_tokens: 1024,
    };
  }

  async *chat(request) {
    const lastMessage = request.messages[request.messages.length - 1];
    const text = `Echo: ${lastMessage.content}`;

    yield { type: 'text_delta', text: text.slice(0, 5) };
    yield { type: 'text_delta', text: text.slice(5) };
    yield {
      type: 'assistant_end',
      text,
      usage: { input_tokens: 10, output_tokens: 5 },
      cost_usd: 0,
      model: 'echo',
      stop_reason: 'end_turn',
    };
  }

  async abort(sessionId) {
    return { ok: true };
  }
}
```
