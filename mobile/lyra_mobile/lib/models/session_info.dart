class SessionInfo {
  final String sessionId;
  final String channel;
  final String? mobileJwt;
  final String configName;
  final String configVersion;
  final double balance;
  final String currency;
  final String status; // 'active', 'insufficient_balance', 'disconnected'
  final String? created;
  final String? lastActivity;

  const SessionInfo({
    required this.sessionId,
    required this.channel,
    this.mobileJwt,
    this.configName = '',
    this.configVersion = '',
    this.balance = 0,
    this.currency = '₽',
    this.status = 'active',
    this.created,
    this.lastActivity,
  });

  SessionInfo copyWith({
    String? sessionId,
    String? channel,
    String? mobileJwt,
    String? configName,
    String? configVersion,
    double? balance,
    String? currency,
    String? status,
    String? created,
    String? lastActivity,
  }) {
    return SessionInfo(
      sessionId: sessionId ?? this.sessionId,
      channel: channel ?? this.channel,
      mobileJwt: mobileJwt ?? this.mobileJwt,
      configName: configName ?? this.configName,
      configVersion: configVersion ?? this.configVersion,
      balance: balance ?? this.balance,
      currency: currency ?? this.currency,
      status: status ?? this.status,
      created: created ?? this.created,
      lastActivity: lastActivity ?? this.lastActivity,
    );
  }

  Map<String, dynamic> toJson() => {
    'session_id': sessionId,
    'channel': channel,
    'mobile_jwt': mobileJwt,
    'config_name': configName,
    'config_version': configVersion,
    'balance': balance,
    'currency': currency,
    'status': status,
    'created': created,
    'lastActivity': lastActivity,
  };

  factory SessionInfo.fromJson(Map<String, dynamic> json) => SessionInfo(
    sessionId: json['session_id'] ?? '',
    channel: json['channel'] ?? '',
    mobileJwt: json['mobile_jwt'],
    configName: json['config_name'] ?? '',
    configVersion: json['config_version'] ?? '',
    balance: (json['balance'] ?? 0).toDouble(),
    currency: json['currency'] ?? '₽',
    status: json['status'] ?? 'active',
    created: json['created'],
    lastActivity: json['lastActivity'] ?? json['last_activity'],
  );
}
