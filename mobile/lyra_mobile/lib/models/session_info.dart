class SessionInfo {
  final String sessionId;
  final String channel;
  final String mobileJwt;
  final String? baseName;
  final double balance;
  final String currency;
  final String status;

  const SessionInfo({
    required this.sessionId,
    required this.channel,
    required this.mobileJwt,
    this.baseName,
    this.balance = 0.0,
    this.currency = 'руб',
    this.status = 'active',
  });

  SessionInfo copyWith({
    String? sessionId,
    String? channel,
    String? mobileJwt,
    String? baseName,
    double? balance,
    String? currency,
    String? status,
  }) {
    return SessionInfo(
      sessionId: sessionId ?? this.sessionId,
      channel: channel ?? this.channel,
      mobileJwt: mobileJwt ?? this.mobileJwt,
      baseName: baseName ?? this.baseName,
      balance: balance ?? this.balance,
      currency: currency ?? this.currency,
      status: status ?? this.status,
    );
  }

  Map<String, dynamic> toJson() => {
        'session_id': sessionId,
        'channel': channel,
        'mobile_jwt': mobileJwt,
        'base_name': baseName,
        'balance': balance,
        'currency': currency,
        'status': status,
      };

  factory SessionInfo.fromJson(Map<String, dynamic> json) => SessionInfo(
        sessionId: json['session_id'] as String,
        channel: json['channel'] as String? ?? '',
        mobileJwt: json['mobile_jwt'] as String,
        baseName: json['base_name'] as String?,
        balance: (json['balance'] as num?)?.toDouble() ?? 0.0,
        currency: json['currency'] as String? ?? 'руб',
        status: json['status'] as String? ?? 'active',
      );
}
