class CentrifugoConfig {
  /// WebSocket URL Centrifugo-сервера.
  /// TODO: для production — из remote config.
  static const wsUrl = 'ws://localhost:11000/connection/websocket';

  /// Общий JWT для подключения к mobile:lobby.
  /// Зашивается в приложение, одинаковый для всех пользователей.
  /// TODO: заполнить при настройке Centrifugo.
  static const mobileLobbyJwt = '';
}
