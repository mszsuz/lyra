/// Типы исходящих сообщений.
sealed class OutgoingMessage {
  Map<String, dynamic> toJson();
}

class RegisterMessage extends OutgoingMessage {
  final String phone;
  final String deviceId;

  RegisterMessage({required this.phone, required this.deviceId});

  @override
  Map<String, dynamic> toJson() => {
        'type': 'register',
        'phone': phone,
        'device_id': deviceId,
      };
}

class ConfirmMessage extends OutgoingMessage {
  final String regId;
  final String code;

  ConfirmMessage({required this.regId, required this.code});

  @override
  Map<String, dynamic> toJson() => {
        'type': 'confirm',
        'reg_id': regId,
        'code': code,
      };
}

class AuthMessage extends OutgoingMessage {
  final String userId;
  final String deviceId;

  AuthMessage({required this.userId, required this.deviceId});

  @override
  Map<String, dynamic> toJson() => {
        'type': 'auth',
        'user_id': userId,
        'device_id': deviceId,
      };
}

/// Типы входящих сообщений.
sealed class IncomingMessage {
  factory IncomingMessage.fromJson(Map<String, dynamic> json) {
    final type = json['type'] as String?;
    return switch (type) {
      'sms_sent' => SmsSentMessage.fromJson(json),
      'register_ack' => RegisterAckMessage.fromJson(json),
      'register_error' => RegisterErrorMessage.fromJson(json),
      'confirm_error' => ConfirmErrorMessage.fromJson(json),
      'hello_ack' => HelloAckMessage.fromJson(json),
      'auth_ack' => AuthAckMessage.fromJson(json),
      'balance_update' => BalanceUpdateMessage.fromJson(json),
      'sessions_list' => SessionsListMessage(
        sessions: List<Map<String, dynamic>>.from(json['sessions'] ?? []),
      ),
      _ => UnknownMessage(type: type, data: json),
    };
  }
}

class SmsSentMessage implements IncomingMessage {
  final String regId;
  final String? phone;

  SmsSentMessage({required this.regId, this.phone});

  factory SmsSentMessage.fromJson(Map<String, dynamic> json) =>
      SmsSentMessage(regId: json['reg_id'] as String, phone: json['phone'] as String?);
}

class RegisterAckMessage implements IncomingMessage {
  final String? regId;
  final String status;
  final String? userId;

  RegisterAckMessage({this.regId, required this.status, this.userId});

  factory RegisterAckMessage.fromJson(Map<String, dynamic> json) =>
      RegisterAckMessage(
        regId: json['reg_id'] as String?,
        status: json['status'] as String? ?? 'ok',
        userId: json['user_id'] as String?,
      );
}

class RegisterErrorMessage implements IncomingMessage {
  final String reason;
  final int? retryAfter;

  RegisterErrorMessage({required this.reason, this.retryAfter});

  factory RegisterErrorMessage.fromJson(Map<String, dynamic> json) =>
      RegisterErrorMessage(
        reason: json['reason'] as String,
        retryAfter: json['retry_after'] as int?,
      );
}

class ConfirmErrorMessage implements IncomingMessage {
  final String? regId;
  final String reason;
  final int? attemptsLeft;

  ConfirmErrorMessage({this.regId, required this.reason, this.attemptsLeft});

  factory ConfirmErrorMessage.fromJson(Map<String, dynamic> json) =>
      ConfirmErrorMessage(
        regId: json['reg_id'] as String?,
        reason: json['reason'] as String,
        attemptsLeft: (json['attempts_remaining'] ?? json['attempts_left']) as int?,
      );
}

class HelloAckMessage implements IncomingMessage {
  final String sessionId;
  final String? chatJwt;
  final String? mobileJwt;
  final String status;

  HelloAckMessage({
    required this.sessionId,
    this.chatJwt,
    this.mobileJwt,
    required this.status,
  });

  factory HelloAckMessage.fromJson(Map<String, dynamic> json) =>
      HelloAckMessage(
        sessionId: json['session_id'] as String,
        chatJwt: json['chat_jwt'] as String?,
        mobileJwt: json['mobile_jwt'] as String?,
        status: json['status'] as String,
      );
}

class AuthAckMessage implements IncomingMessage {
  final String sessionId;
  final String status;

  AuthAckMessage({required this.sessionId, required this.status});

  factory AuthAckMessage.fromJson(Map<String, dynamic> json) =>
      AuthAckMessage(
        sessionId: json['session_id'] as String,
        status: json['status'] as String,
      );
}

class BalanceUpdateMessage implements IncomingMessage {
  final String sessionId;
  final double balance;
  final String currency;

  BalanceUpdateMessage({
    required this.sessionId,
    required this.balance,
    required this.currency,
  });

  factory BalanceUpdateMessage.fromJson(Map<String, dynamic> json) =>
      BalanceUpdateMessage(
        sessionId: json['session_id'] as String,
        balance: (json['balance'] as num).toDouble(),
        currency: json['currency'] as String? ?? 'руб',
      );
}

class SessionsListMessage implements IncomingMessage {
  final List<Map<String, dynamic>> sessions;
  SessionsListMessage({required this.sessions});
}

class UnknownMessage implements IncomingMessage {
  final String? type;
  final Map<String, dynamic> data;

  UnknownMessage({this.type, required this.data});
}
