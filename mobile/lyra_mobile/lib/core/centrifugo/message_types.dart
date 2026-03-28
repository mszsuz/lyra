/// Типы исходящих сообщений.
sealed class OutgoingMessage {
  Map<String, dynamic> toJson();
}

class RegisterMessage extends OutgoingMessage {
  final String deviceId;

  RegisterMessage({required this.deviceId});

  @override
  Map<String, dynamic> toJson() => {
        'type': 'register',
        'device_id': deviceId,
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

class MobileMessage extends OutgoingMessage {
  final List<Map<String, dynamic>> parts;

  MobileMessage({required this.parts});

  factory MobileMessage.text(String text) =>
      MobileMessage(parts: [{'kind': 'text', 'text': text}]);

  factory MobileMessage.photo(String base64data, String name) =>
      MobileMessage(parts: [{'kind': 'photo', 'data': base64data, 'name': name}]);

  @override
  Map<String, dynamic> toJson() => {
        'type': 'mobile',
        'parts': parts,
      };
}

class GetSessionsMessage extends OutgoingMessage {
  final String userId;

  GetSessionsMessage({required this.userId});

  @override
  Map<String, dynamic> toJson() => {
        'type': 'get_sessions',
        'user_id': userId,
      };
}

/// get_sessions через user-канал (userId из канала, только device_id в payload)
class GetSessionsUserMessage extends OutgoingMessage {
  final String deviceId;

  GetSessionsUserMessage({required this.deviceId});

  @override
  Map<String, dynamic> toJson() => {
        'type': 'get_sessions',
        'device_id': deviceId,
      };
}

/// Типы входящих сообщений.
sealed class IncomingMessage {
  factory IncomingMessage.fromJson(Map<String, dynamic> json) {
    final type = json['type'] as String?;
    return switch (type) {
      'register_ack' => RegisterAckMessage.fromJson(json),
      'register_error' => RegisterErrorMessage.fromJson(json),
      'hello_error' => HelloErrorMessage.fromJson(json),
      'hello_ack' => HelloAckMessage.fromJson(json),
      'auth_ack' => AuthAckMessage.fromJson(json),
      'balance_update' => BalanceUpdateMessage.fromJson(json),
      'sessions_list' => SessionsListMessage(
        userId: json['user_id'] as String?,
        sessions: List<Map<String, dynamic>>.from(json['sessions'] ?? []),
        balance: (json['balance'] as num?)?.toDouble(),
      ),
      _ => UnknownMessage(type: type, data: json),
    };
  }
}

class RegisterAckMessage implements IncomingMessage {
  final String status;
  final String? userId;
  final double? balance;
  final String? userJwt;
  final String? targetClient;

  RegisterAckMessage({required this.status, this.userId, this.balance, this.userJwt, this.targetClient});

  factory RegisterAckMessage.fromJson(Map<String, dynamic> json) =>
      RegisterAckMessage(
        status: json['status'] as String? ?? 'ok',
        userId: json['user_id'] as String?,
        balance: (json['balance'] as num?)?.toDouble(),
        userJwt: json['user_jwt'] as String?,
        targetClient: json['target_client'] as String?,
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
  final String? configName;
  final String? created;
  final double? balance;
  final String? currency;

  AuthAckMessage({
    required this.sessionId,
    required this.status,
    this.configName,
    this.created,
    this.balance,
    this.currency,
  });

  factory AuthAckMessage.fromJson(Map<String, dynamic> json) =>
      AuthAckMessage(
        sessionId: json['session_id'] as String,
        status: json['status'] as String,
        configName: json['config_name'] as String?,
        created: json['created'] as String?,
        balance: (json['balance'] as num?)?.toDouble(),
        currency: json['currency'] as String?,
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
  final String? userId;
  final List<Map<String, dynamic>> sessions;
  final double? balance;
  SessionsListMessage({this.userId, required this.sessions, this.balance});
}

class HelloErrorMessage implements IncomingMessage {
  final String reason;

  HelloErrorMessage({required this.reason});

  factory HelloErrorMessage.fromJson(Map<String, dynamic> json) =>
      HelloErrorMessage(reason: json['reason'] as String? ?? 'unknown');
}

class UnknownMessage implements IncomingMessage {
  final String? type;
  final Map<String, dynamic> data;

  UnknownMessage({this.type, required this.data});
}
