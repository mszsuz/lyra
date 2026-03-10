import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/centrifugo/centrifugo_client.dart';
import '../../core/centrifugo/message_types.dart';
import '../../core/storage/secure_storage.dart';

enum RegistrationStep {
  phoneInput,
  waitingSms,
  codeInput,
  confirming,
  done,
  error,
}

class RegistrationState {
  final RegistrationStep step;
  final String? regId;
  final String? errorMessage;
  final int? retryAfter;
  final int? attemptsLeft;

  const RegistrationState({
    this.step = RegistrationStep.phoneInput,
    this.regId,
    this.errorMessage,
    this.retryAfter,
    this.attemptsLeft,
  });

  RegistrationState copyWith({
    RegistrationStep? step,
    String? regId,
    String? errorMessage,
    int? retryAfter,
    int? attemptsLeft,
  }) {
    return RegistrationState(
      step: step ?? this.step,
      regId: regId ?? this.regId,
      errorMessage: errorMessage,
      retryAfter: retryAfter,
      attemptsLeft: attemptsLeft,
    );
  }
}

class RegistrationNotifier extends StateNotifier<RegistrationState> {
  final CentrifugoClient _centrifugo;
  final SecureStorage _storage;
  StreamSubscription<IncomingMessage>? _messagesSub;

  RegistrationNotifier(this._centrifugo, this._storage)
      : super(const RegistrationState()) {
    _messagesSub = _centrifugo.messages.listen(_onMessage);
  }

  Future<void> sendPhone(String phone) async {
    state = state.copyWith(step: RegistrationStep.waitingSms);

    try {
      await _centrifugo.connectToLobby();
    } on StateError catch (e) {
      state = state.copyWith(
        step: RegistrationStep.error,
        errorMessage: e.message,
      );
      return;
    } on TimeoutException {
      state = state.copyWith(
        step: RegistrationStep.error,
        errorMessage: 'Не удалось подключиться к серверу. Проверьте сеть.',
      );
      return;
    } catch (e) {
      state = state.copyWith(
        step: RegistrationStep.error,
        errorMessage: 'Ошибка подключения: $e',
      );
      return;
    }

    final deviceId = await _storage.getOrCreateDeviceId();
    await _centrifugo.publish(
      'mobile:lobby',
      RegisterMessage(phone: phone, deviceId: deviceId),
    );
    await _storage.savePhone(phone);
  }

  Future<void> confirmCode(String code) async {
    if (state.regId == null) return;

    state = state.copyWith(step: RegistrationStep.confirming);
    await _centrifugo.publish(
      'mobile:lobby',
      ConfirmMessage(regId: state.regId!, code: code),
    );
  }

  void _onMessage(IncomingMessage message) {
    switch (message) {
      case SmsSentMessage(:final regId):
        state = state.copyWith(
          step: RegistrationStep.codeInput,
          regId: regId,
        );

      case RegisterAckMessage(:final status, :final userId):
        if (status == 'ok' && userId != null) {
          _storage.saveUserId(userId);
          _centrifugo.disconnect();
          state = state.copyWith(step: RegistrationStep.done);
        } else {
          state = state.copyWith(
            step: RegistrationStep.error,
            errorMessage: 'Ошибка регистрации: $status',
          );
        }

      case RegisterErrorMessage(:final reason, :final retryAfter):
        state = state.copyWith(
          step: RegistrationStep.error,
          errorMessage: _errorText(reason),
          retryAfter: retryAfter,
        );

      case ConfirmErrorMessage(:final reason, :final attemptsLeft):
        state = state.copyWith(
          step: RegistrationStep.codeInput,
          errorMessage: _errorText(reason),
          attemptsLeft: attemptsLeft,
        );

      default:
        break;
    }
  }

  String _errorText(String reason) {
    return switch (reason) {
      'rate_limited' => 'Слишком часто. Подождите и попробуйте снова.',
      'invalid_code' => 'Неверный код.',
      'expired' => 'Код истёк. Запросите новый.',
      'max_attempts' => 'Превышено число попыток.',
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
  final centrifugo = ref.watch(centrifugoClientProvider);
  final storage = ref.watch(secureStorageProvider);
  return RegistrationNotifier(centrifugo, storage);
});
