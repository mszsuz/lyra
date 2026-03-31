import 'dart:convert';
import 'dart:io';

class CentrifugoConfig {
  /// URL удалённого конфига — публичный файл на GitHub.
  /// Позволяет менять адрес сервера без пересборки приложения.
  static const _connectUrl =
      'https://raw.githubusercontent.com/mszsuz/lyra/master/connect.json';

  static const _fallbackWsUrl = 'ws://ru.tuna.am:35773/connection/websocket';

  static String? _cachedWsUrl;
  static String? _cachedFallbackUrl;

  /// Получает WebSocket URL из удалённого конфига (GitHub).
  /// Кеширует результат на время жизни приложения.
  /// При ошибке — fallback на Tuna TCP tunnel.
  static Future<String> getWsUrl() async {
    if (_cachedWsUrl != null) return _cachedWsUrl!;
    await _loadConfig();
    return _cachedWsUrl ?? _fallbackWsUrl;
  }

  /// Возвращает fallback URL (ws://) для тонкого клиента / мобильного.
  /// null если fallback не задан или уже использован.
  static Future<String?> getFallbackWsUrl() async {
    await _loadConfig();
    return _cachedFallbackUrl;
  }

  /// Сбрасывает основной URL и переключает на fallback.
  /// Возвращает fallback URL или null если его нет.
  static String? switchToFallback() {
    if (_cachedFallbackUrl != null && _cachedFallbackUrl!.isNotEmpty) {
      _cachedWsUrl = _cachedFallbackUrl;
      _cachedFallbackUrl = null; // не повторять бесконечно
      print('[CentrifugoConfig] Switched to fallback: $_cachedWsUrl');
      return _cachedWsUrl;
    }
    return null;
  }

  static Future<void> _loadConfig() async {
    if (_cachedWsUrl != null) return;
    try {
      final client = HttpClient();
      client.connectionTimeout = const Duration(seconds: 5);
      final request = await client.getUrl(Uri.parse(_connectUrl));
      final response = await request.close();
      if (response.statusCode == 200) {
        final body = await response.transform(utf8.decoder).join();
        final data = jsonDecode(body) as Map<String, dynamic>;
        final ws = data['ws'] as String?;
        if (ws != null && ws.isNotEmpty) {
          _cachedWsUrl = ws;
          print('[CentrifugoConfig] Remote config ws: $ws');
        }
        final fallback = data['ws_fallback'] as String?;
        if (fallback != null && fallback.isNotEmpty) {
          _cachedFallbackUrl = fallback;
          print('[CentrifugoConfig] Remote config ws_fallback: $fallback');
        }
      }
    } catch (e) {
      print('[CentrifugoConfig] Remote config error: $e');
    }
    _cachedWsUrl ??= _fallbackWsUrl;
    print('[CentrifugoConfig] Using: $_cachedWsUrl');
  }

  /// Общий JWT для подключения к mobile:lobby.
  /// Зашивается в приложение, одинаковый для всех пользователей.
  static const mobileLobbyJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJtb2JpbGUtbG9iYnkiLCJjaGFubmVscyI6WyJtb2JpbGU6bG9iYnkiXSwiZXhwIjoxODA1NDg2ODE4fQ.mSNKrQHq2k8fsn3MGJiFV6SijdX5UKMEP1RiW5IbDek';
}
