class User {
  final String userId;
  final String deviceId;
  final String phone;

  const User({
    required this.userId,
    required this.deviceId,
    required this.phone,
  });

  Map<String, dynamic> toJson() => {
        'user_id': userId,
        'device_id': deviceId,
        'phone': phone,
      };

  factory User.fromJson(Map<String, dynamic> json) => User(
        userId: json['user_id'] as String,
        deviceId: json['device_id'] as String,
        phone: json['phone'] as String? ?? '',
      );
}
