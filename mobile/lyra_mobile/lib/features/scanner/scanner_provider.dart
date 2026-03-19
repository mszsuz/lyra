import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/centrifugo/centrifugo_client.dart';
import '../../core/centrifugo/message_types.dart';
import '../../core/storage/secure_storage.dart';
import '../../models/session_info.dart';

enum ScannerStep {
  scanning,
  connecting,
  authenticating,
  done,
  error,
}

class ScannerState {
  final ScannerStep step;
  final String? errorMessage;
  final SessionInfo? session;

  const ScannerState({
    this.step = ScannerStep.scanning,
    this.errorMessage,
    this.session,
  });

  ScannerState copyWith({
    ScannerStep? step,
    String? errorMessage,
    SessionInfo? session,
  }) {
    return ScannerState(
      step: step ?? this.step,
      errorMessage: errorMessage,
      session: session ?? this.session,
    );
  }
}

class ScannerNotifier extends StateNotifier<ScannerState> {
  final CentrifugoClient _centrifugo;
  final SecureStorage _storage;
  StreamSubscription<IncomingMessage>? _messagesSub;
  String _currentMobileJwt = '';

  ScannerNotifier(this._centrifugo, this._storage)
      : super(const ScannerState());

  Future<void> onQrScanned(String qrData) async {
    // QR содержит mobile_jwt (строка начинающаяся с "eyJ")
    if (!qrData.startsWith('eyJ')) {
      state = state.copyWith(
        step: ScannerStep.error,
        errorMessage: 'Неверный QR-код',
      );
      return;
    }

    _currentMobileJwt = qrData;
    state = state.copyWith(step: ScannerStep.connecting);

    _messagesSub = _centrifugo.messages.listen(_onMessage);

    // Подключение с mobile_jwt (авто-подписка через channels claim)
    await _centrifugo.connectToSession(qrData);

    // Ждём подключения, затем отправляем auth
    var authSent = false;
    late StreamSubscription<CentrifugoConnectionState> connSub;
    connSub = _centrifugo.connectionState.listen((connState) async {
      if (connState == CentrifugoConnectionState.connected && !authSent) {
        authSent = true;
        connSub.cancel();
        await _sendAuth();
      }
    });

    // Если уже подключены
    if (_centrifugo.currentState == CentrifugoConnectionState.connected &&
        !authSent) {
      authSent = true;
      connSub.cancel();
      await _sendAuth();
    }
  }

  Future<void> _sendAuth() async {
    state = state.copyWith(step: ScannerStep.authenticating);

    final userId = await _storage.getUserId();
    final deviceId = await _storage.getOrCreateDeviceId();

    if (userId == null) {
      state = state.copyWith(
        step: ScannerStep.error,
        errorMessage: 'Пользователь не зарегистрирован',
      );
      return;
    }

    // Извлекаем канал из JWT payload (channels claim)
    final channel = _extractChannelFromJwt(_currentMobileJwt);

    if (channel != null) {
      await _centrifugo.publish(
        channel,
        AuthMessage(userId: userId, deviceId: deviceId),
      );
    } else {
      state = state.copyWith(
        step: ScannerStep.error,
        errorMessage: 'Не удалось извлечь канал из JWT',
      );
    }
  }

  String? _extractChannelFromJwt(String jwt) {
    try {
      final parts = jwt.split('.');
      if (parts.length != 3) return null;

      var payload = parts[1];
      // Base64url decode
      payload = payload.replaceAll('-', '+').replaceAll('_', '/');
      final remainder = payload.length % 4;
      if (remainder > 0) {
        payload += '=' * (4 - remainder);
      }

      final decoded = utf8.decode(base64.decode(payload));
      final json = jsonDecode(decoded) as Map<String, dynamic>;

      final channels = json['channels'] as List<dynamic>?;
      if (channels != null && channels.isNotEmpty) {
        return channels.first as String;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  void _onMessage(IncomingMessage message) {
    switch (message) {
      case AuthAckMessage(:final sessionId, :final status):
        if (status == 'ok') {
          final session = SessionInfo(
            sessionId: sessionId,
            channel: 'session:$sessionId',
            mobileJwt: _currentMobileJwt,
            status: 'connected',
          );
          _storage.saveSession(session);
          state = state.copyWith(
            step: ScannerStep.done,
            session: session,
          );
        } else {
          state = state.copyWith(
            step: ScannerStep.error,
            errorMessage: _statusText(status),
          );
        }

      case BalanceUpdateMessage(
          :final sessionId,
          :final balance,
          :final currency,
        ):
        if (state.session != null &&
            state.session!.sessionId == sessionId) {
          final updated = state.session!.copyWith(
            balance: balance,
            currency: currency,
          );
          _storage.saveSession(updated);
          state = state.copyWith(session: updated);
        }

      default:
        break;
    }
  }

  void reset() {
    _messagesSub?.cancel();
    _messagesSub = null;
    _currentMobileJwt = '';
    state = const ScannerState();
  }

  String _statusText(String status) {
    return switch (status) {
      'auth_failed' => 'Ошибка авторизации',
      'insufficient_balance' => 'Недостаточно средств',
      'service_unavailable' => 'Сервис временно недоступен',
      _ => 'Ошибка: $status',
    };
  }

  @override
  void dispose() {
    _messagesSub?.cancel();
    super.dispose();
  }
}

final scannerProvider =
    StateNotifierProvider.autoDispose<ScannerNotifier, ScannerState>((ref) {
  final centrifugo = ref.watch(centrifugoClientProvider);
  final storage = ref.watch(secureStorageProvider);
  return ScannerNotifier(centrifugo, storage);
});
