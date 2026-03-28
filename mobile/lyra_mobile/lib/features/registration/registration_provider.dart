import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/centrifugo/centrifugo_client.dart';
import '../../core/centrifugo/message_types.dart';
import '../../core/storage/secure_storage.dart';

enum RegistrationStep {
  connecting,
  waitingBootstrap,
  registering,
  done,
  error,
}

class RegistrationState {
  final RegistrationStep step;
  final String? errorMessage;

  const RegistrationState({
    this.step = RegistrationStep.connecting,
    this.errorMessage,
  });

  RegistrationState copyWith({
    RegistrationStep? step,
    String? errorMessage,
  }) {
    return RegistrationState(
      step: step ?? this.step,
      errorMessage: errorMessage,
    );
  }
}

class RegistrationNotifier extends StateNotifier<RegistrationState> {
  final CentrifugoClient _centrifugo;
  final SecureStorage _storage;
  StreamSubscription<IncomingMessage>? _messagesSub;

  RegistrationNotifier(this._centrifugo, this._storage)
      : super(const RegistrationState());

  /// Регистрация через bootstrap-канал (centrifuge-dart protobuf).
  Future<void> register() async {
    state = state.copyWith(step: RegistrationStep.connecting);

    // Подписываемся на serverSubscriptions ДО connect
    final bootstrapFuture = _centrifugo.serverSubscriptions
        .where((ch) => ch.startsWith('mobile:') && ch != 'mobile:lobby')
        .first
        .timeout(const Duration(seconds: 15));

    try {
      await _centrifugo.connectToLobby();
    } on StateError catch (e) {
      state = state.copyWith(step: RegistrationStep.error, errorMessage: e.message);
      return;
    } on TimeoutException {
      state = state.copyWith(
        step: RegistrationStep.error,
        errorMessage: 'Не удалось подключиться к серверу. Проверьте сеть.',
      );
      return;
    } catch (e) {
      state = state.copyWith(step: RegistrationStep.error, errorMessage: 'Ошибка подключения: $e');
      return;
    }

    // Ждём bootstrap-канал от роутера (push.subscribe)
    state = state.copyWith(step: RegistrationStep.waitingBootstrap);

    String bootstrapChannel;
    try {
      bootstrapChannel = await bootstrapFuture;
    } on TimeoutException {
      state = state.copyWith(
        step: RegistrationStep.error,
        errorMessage: 'Сервер не назначил канал. Попробуйте позже.',
      );
      return;
    }

    // Регистрация через bootstrap-канал
    state = state.copyWith(step: RegistrationStep.registering);
    _messagesSub?.cancel();
    _messagesSub = _centrifugo.messages.listen(_onMessage);

    final deviceId = await _storage.getOrCreateDeviceId();
    await _centrifugo.publish(
      bootstrapChannel,
      RegisterMessage(deviceId: deviceId),
    );
  }

  void _onMessage(IncomingMessage message) {
    switch (message) {
      case RegisterAckMessage(:final status, :final userId, :final userJwt):
        if (status == 'ok' && userId != null) {
          _storage.saveUserId(userId);
          if (userJwt != null) _storage.saveUserJwt(userJwt);
          _centrifugo.disconnect();
          state = state.copyWith(step: RegistrationStep.done);
        } else {
          state = state.copyWith(
            step: RegistrationStep.error,
            errorMessage: 'Ошибка регистрации: $status',
          );
        }

      case RegisterErrorMessage(:final reason):
        state = state.copyWith(
          step: RegistrationStep.error,
          errorMessage: _errorText(reason),
        );

      default:
        break;
    }
  }

  String _errorText(String reason) {
    return switch (reason) {
      'missing_device_id' => 'Ошибка устройства.',
      'subscribe_failed' => 'Ошибка сервера. Попробуйте позже.',
      'internal_error' => 'Внутренняя ошибка. Попробуйте позже.',
      _ => reason,
    };
  }

  @override
  void dispose() {
    _messagesSub?.cancel();
    super.dispose();
  }
}

final registrationProvider =
    StateNotifierProvider<RegistrationNotifier, RegistrationState>((ref) {
  final centrifugo = ref.watch(accountClientProvider);
  final storage = ref.watch(secureStorageProvider);
  return RegistrationNotifier(centrifugo, storage);
});
