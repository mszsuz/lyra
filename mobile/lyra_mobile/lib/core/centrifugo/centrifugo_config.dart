class CentrifugoConfig {
  /// WebSocket URL Centrifugo-сервера.
  /// TODO: для production — из remote config.
  static const wsUrl = 'ws://192.168.1.2:11000/connection/websocket';

  /// Общий JWT для подключения к mobile:lobby.
  /// Зашивается в приложение, одинаковый для всех пользователей.
  static const mobileLobbyJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJtb2JpbGUtbG9iYnkiLCJjaGFubmVscyI6WyJtb2JpbGU6bG9iYnkiXSwiZXhwIjoxODA1NDg2ODE4fQ.mSNKrQHq2k8fsn3MGJiFV6SijdX5UKMEP1RiW5IbDek';
}
