class CentrifugoConfig {
  /// WebSocket URL Centrifugo-сервера.
  /// TODO: для production — из remote config.
  static const wsUrl = 'ws://192.168.1.2:11000/connection/websocket';

  /// Общий JWT для подключения к mobile:lobby.
  /// Зашивается в приложение, одинаковый для всех пользователей.
  static const mobileLobbyJwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJtb2JpbGUtbG9iYnkiLCJleHAiOjE4MDQ1ODgyMzQsImlhdCI6MTc3MzA1MjIzNH0.a99ECLG7WGFV5P6WOBgii2NpcmgcdvqU40uZPEImWAA';
}
