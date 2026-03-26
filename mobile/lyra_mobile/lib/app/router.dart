import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../app/theme.dart';
import '../core/push_service.dart';
import '../core/storage/secure_storage.dart';
import '../features/registration/registration_screen.dart';
import '../features/home/home_screen.dart';
import '../features/scanner/scanner_screen.dart';
import '../features/session/session_screen.dart';
import '../features/profile/profile_screen.dart';

final routerProvider = Provider<GoRouter>((ref) {
  return GoRouter(
    initialLocation: '/',
    routes: [
      GoRoute(path: '/', builder: (_, __) => const SplashScreen()),
      GoRoute(path: '/registration', builder: (_, __) => const RegistrationScreen()),
      GoRoute(path: '/home', builder: (_, __) => const HomeScreen()),
      GoRoute(path: '/scanner', builder: (_, __) => const ScannerScreen()),
      GoRoute(
        path: '/session/:id',
        builder: (_, state) => SessionScreen(sessionId: state.pathParameters['id']!),
      ),
      GoRoute(path: '/profile', builder: (_, __) => const ProfileScreen()),
    ],
  );
});

class SplashScreen extends ConsumerStatefulWidget {
  const SplashScreen({super.key});

  @override
  ConsumerState<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends ConsumerState<SplashScreen> {
  @override
  void initState() {
    super.initState();
    _checkAuth();
  }

  Future<void> _checkAuth() async {
    await Future.delayed(const Duration(seconds: 2));
    if (!mounted) return;

    // Инициализация push-уведомлений
    final pushService = ref.read(pushServiceProvider);
    await pushService.initialize();

    final storage = ref.read(secureStorageProvider);
    var userId = await storage.getUserId();
    if (!mounted) return;

    if (userId == null) {
      // Авто-регистрация: device_id = user_id
      final deviceId = await storage.getOrCreateDeviceId();
      await storage.saveUserId(deviceId);
      // MDM-регистрация (register в mobile:lobby) произойдёт при первом
      // подключении к Centrifugo — отложенная, не блокирует запуск.
    }

    context.go('/home');
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Container(
        color: LyraTheme.accent,
        width: double.infinity,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 120,
              height: 120,
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(LyraTheme.radius),
              ),
              child: const Center(
                child: Text(
                  '\u266a',
                  style: TextStyle(fontSize: 56, color: LyraTheme.accent),
                ),
              ),
            ),
            const SizedBox(height: 24),
            const Text(
              '\u041b\u0418\u0420\u0410',
              style: TextStyle(
                fontSize: 36,
                fontWeight: FontWeight.w900,
                color: Colors.white,
                letterSpacing: 4,
              ),
            ),
            const SizedBox(height: 32),
            const SizedBox(
              width: 40,
              height: 40,
              child: CircularProgressIndicator(
                strokeWidth: 4,
                valueColor: AlwaysStoppedAnimation<Color>(Colors.white),
              ),
            ),
            const SizedBox(height: 16),
            Text(
              '\u0417\u0410\u0413\u0420\u0423\u0417\u041a\u0410',
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
                color: Colors.white.withValues(alpha: 0.7),
                letterSpacing: 2,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
