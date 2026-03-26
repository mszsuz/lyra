import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

import '../../models/session_info.dart';

class SecureStorage {
  static const _keyUserId = 'lyra_user_id';
  static const _keyDeviceId = 'lyra_device_id';
  static const _keyPhone = 'lyra_phone';
  static const _keySessions = 'lyra_sessions';
  static const _keyUserName = 'lyra_user_name';
  static const _keyUserRole = 'lyra_user_role';

  final FlutterSecureStorage _storage;

  SecureStorage({FlutterSecureStorage? storage})
      : _storage = storage ?? const FlutterSecureStorage();

  Future<String?> getUserId() async {
    return _storage.read(key: _keyUserId);
  }

  Future<void> saveUserId(String userId) async {
    await _storage.write(key: _keyUserId, value: userId);
  }

  Future<String?> getPhone() async {
    return _storage.read(key: _keyPhone);
  }

  Future<void> savePhone(String phone) async {
    await _storage.write(key: _keyPhone, value: phone);
  }

  /// Получить или создать device_id (UUID, создаётся при первом запуске).
  Future<String> getOrCreateDeviceId() async {
    var deviceId = await _storage.read(key: _keyDeviceId);
    if (deviceId == null) {
      deviceId = const Uuid().v4();
      await _storage.write(key: _keyDeviceId, value: deviceId);
    }
    return deviceId;
  }

  Future<void> saveSession(SessionInfo session) async {
    final sessions = await getSessions();
    // Обновить существующую или добавить новую
    final index = sessions.indexWhere((s) => s.sessionId == session.sessionId);
    if (index >= 0) {
      sessions[index] = session;
    } else {
      sessions.add(session);
    }
    final jsonList = sessions.map((s) => s.toJson()).toList();
    await _storage.write(key: _keySessions, value: jsonEncode(jsonList));
  }

  Future<void> removeSession(String sessionId) async {
    final sessions = await getSessions();
    sessions.removeWhere((s) => s.sessionId == sessionId);
    final jsonList = sessions.map((s) => s.toJson()).toList();
    await _storage.write(key: _keySessions, value: jsonEncode(jsonList));
  }

  Future<List<SessionInfo>> getSessions() async {
    final raw = await _storage.read(key: _keySessions);
    if (raw == null || raw.isEmpty) return [];
    try {
      final list = jsonDecode(raw) as List;
      return list
          .map((e) => SessionInfo.fromJson(e as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return [];
    }
  }

  Future<String?> getUserName() async {
    return _storage.read(key: _keyUserName);
  }

  Future<void> saveUserName(String name) async {
    await _storage.write(key: _keyUserName, value: name);
  }

  Future<String?> getUserRole() async {
    return _storage.read(key: _keyUserRole);
  }

  Future<void> saveUserRole(String role) async {
    await _storage.write(key: _keyUserRole, value: role);
  }

  static const _keyFcmToken = 'lyra_fcm_token';

  Future<String?> getFcmToken() async {
    return _storage.read(key: _keyFcmToken);
  }

  Future<void> saveFcmToken(String token) async {
    await _storage.write(key: _keyFcmToken, value: token);
  }

  static const _keyBalance = 'lyra_balance';
  static const _keyAutoScanner = 'lyra_auto_scanner';

  Future<double> getBalance() async {
    final val = await _storage.read(key: _keyBalance);
    return val != null ? double.tryParse(val) ?? 0 : 0;
  }

  Future<void> saveBalance(double balance) async {
    await _storage.write(key: _keyBalance, value: balance.toString());
  }

  Future<bool> getAutoScanner() async {
    final val = await _storage.read(key: _keyAutoScanner);
    return val == 'true';
  }

  Future<void> setAutoScanner(bool value) async {
    await _storage.write(key: _keyAutoScanner, value: value.toString());
  }

  Future<void> clearSessions() async {
    await _storage.write(key: _keySessions, value: '[]');
  }

  Future<void> clearAll() async {
    await _storage.deleteAll();
  }
}

final secureStorageProvider = Provider<SecureStorage>((ref) {
  return SecureStorage();
});
