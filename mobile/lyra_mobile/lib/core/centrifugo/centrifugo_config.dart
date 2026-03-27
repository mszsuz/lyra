import 'dart:convert';
import 'dart:io';

class CentrifugoConfig {
  /// URL удалённого конфига — публичный файл на GitHub.
  /// Позволяет менять адрес сервера без пересборки приложения.
  static const _connectUrl =
      'https://raw.githubusercontent.com/mszsuz/lyra/master/connect.json';

  static const _fallbackWsUrl = 'ws://localhost:11911/connection/websocket';

  static String? _cachedWsUrl;

  /// Получает WebSocket URL из удалённого конфига (GitHub).
  /// Кеширует результат на время жизни приложения.
  /// При ошибке — fallback на localhost.
  static Future<String> getWsUrl() async {
    if (_cachedWsUrl != null) return _cachedWsUrl!;
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
          print('[CentrifugoConfig] Remote config: $ws');
          return ws;
        }
      }
    } catch (e) {
      print('[CentrifugoConfig] Remote config error: $e');
    }
    print('[CentrifugoConfig] Using fallback: $_fallbackWsUrl');
    return _fallbackWsUrl;
  }

  /// Общий JWT для подключения к mobile:lobby.
  /// Зашивается в приложение, одинаковый для всех пользователей.
  static const mobileLobbyJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJtb2JpbGUtbG9iYnkiLCJjaGFubmVscyI6WyJtb2JpbGU6bG9iYnkiXSwiZXhwIjoxODA1NDg2ODE4fQ.mSNKrQHq2k8fsn3MGJiFV6SijdX5UKMEP1RiW5IbDek';
}
