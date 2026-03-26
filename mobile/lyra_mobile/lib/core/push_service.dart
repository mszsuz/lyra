import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'storage/secure_storage.dart';

/// Обработчик фоновых push-уведомлений (top-level function, вызывается вне приложения).
@pragma('vm:entry-point')
Future<void> _firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  debugPrint('[FCM] Background message: ${message.messageId}');
}

/// Сервис push-уведомлений через Firebase Cloud Messaging.
///
/// Получает FCM-токен, обрабатывает входящие сообщения,
/// сохраняет токен для отправки на сервер при регистрации.
class PushService {
  final FirebaseMessaging _messaging;
  final SecureStorage _storage;

  PushService({
    FirebaseMessaging? messaging,
    required SecureStorage storage,
  })  : _messaging = messaging ?? FirebaseMessaging.instance,
        _storage = storage;

  /// Инициализация FCM: запрос разрешений, получение токена, обработчики.
  Future<String?> initialize() async {
    // Регистрация background handler
    FirebaseMessaging.onBackgroundMessage(_firebaseMessagingBackgroundHandler);

    // Запрос разрешений (Android 13+ требует явный запрос)
    final settings = await _messaging.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );

    if (settings.authorizationStatus == AuthorizationStatus.denied) {
      debugPrint('[FCM] Push notifications denied by user');
      return null;
    }

    // Получение FCM-токена
    final token = await _messaging.getToken();
    if (token != null) {
      await _storage.saveFcmToken(token);
      debugPrint('[FCM] Token: ${token.substring(0, 20)}...');
    }

    // Обработчик обновления токена
    _messaging.onTokenRefresh.listen((newToken) async {
      await _storage.saveFcmToken(newToken);
      debugPrint('[FCM] Token refreshed');
      // TODO: отправить новый токен на сервер через mobile:lobby
    });

    // Обработчик сообщений в foreground
    FirebaseMessaging.onMessage.listen(_handleForegroundMessage);

    // Обработчик нажатия на уведомление (приложение было в фоне)
    FirebaseMessaging.onMessageOpenedApp.listen(_handleMessageOpenedApp);

    return token;
  }

  /// Получить сохранённый FCM-токен.
  Future<String?> getToken() => _storage.getFcmToken();

  /// Обработка foreground-сообщений.
  void _handleForegroundMessage(RemoteMessage message) {
    debugPrint('[FCM] Foreground: ${message.notification?.title}');
    final data = message.data;
    if (data.containsKey('type')) {
      _processDataMessage(data);
    }
  }

  /// Обработка нажатия на уведомление.
  void _handleMessageOpenedApp(RemoteMessage message) {
    debugPrint('[FCM] Opened app from notification: ${message.data}');
    // TODO: навигация к нужному экрану (сессия, баланс и т.д.)
  }

  /// Обработка data-сообщений (без notification, только данные).
  void _processDataMessage(Map<String, dynamic> data) {
    final type = data['type'];
    switch (type) {
      case 'balance_low':
        debugPrint('[FCM] Balance low: ${data['balance']}');
        break;
      case 'session_ended':
        debugPrint('[FCM] Session ended: ${data['session_id']}');
        break;
      default:
        debugPrint('[FCM] Unknown data type: $type');
    }
  }
}

final pushServiceProvider = Provider<PushService>((ref) {
  final storage = ref.watch(secureStorageProvider);
  return PushService(storage: storage);
});
