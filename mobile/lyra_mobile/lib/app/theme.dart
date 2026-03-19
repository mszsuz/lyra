import 'package:flutter/material.dart';

class LyraTheme {
  // Design tokens from design-v7.html
  static const accent = Color(0xFF2979FF);
  static const accentDark = Color(0xFF1565C0);
  static const accentBg = Color(0xFFE3F2FD);
  static const green = Color(0xFF00C853);
  static const greenBg = Color(0xFFE8F5E9);
  static const yellow = Color(0xFFFF9100);
  static const yellowBg = Color(0xFFFFF3E0);
  static const red = Color(0xFFF44336);
  static const redBg = Color(0xFFFFEBEE);
  static const purple = Color(0xFF7C4DFF);
  static const purpleBg = Color(0xFFEDE7F6);
  static const teal = Color(0xFF00BFA5);

  static const textPrimary = Color(0xFF212121);
  static const textSecondary = Color(0xFF757575);
  static const textMuted = Color(0xFFBDBDBD);
  static const divider = Color(0xFFEEEEEE);
  static const bgAlt = Color(0xFFF5F5F5);

  static const radius = 12.0;
  static const radiusSm = 8.0;
  static const radiusPill = 50.0;

  static ThemeData get lightTheme => ThemeData(
    useMaterial3: true,
    colorScheme: ColorScheme.light(
      primary: accent,
      onPrimary: Colors.white,
      secondary: accent,
      surface: Colors.white,
      onSurface: textPrimary,
      error: red,
    ),
    scaffoldBackgroundColor: Colors.white,
    fontFamily: 'Roboto',
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.white,
      foregroundColor: textPrimary,
      elevation: 0,
      scrolledUnderElevation: 0,
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: accent,
        foregroundColor: Colors.white,
        minimumSize: const Size(double.infinity, 52),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusSm)),
        textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700, letterSpacing: 0.5),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: accent,
        side: const BorderSide(color: accent, width: 2),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radiusSm)),
        textStyle: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700, letterSpacing: 0.5),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radiusSm),
        borderSide: const BorderSide(color: divider, width: 2),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radiusSm),
        borderSide: const BorderSide(color: divider, width: 2),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(radiusSm),
        borderSide: const BorderSide(color: accent, width: 2),
      ),
      filled: false,
      contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
    ),
    dividerTheme: const DividerThemeData(color: divider, thickness: 2),
    cardTheme: CardThemeData(
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(radius),
        side: const BorderSide(color: divider, width: 2),
      ),
      margin: EdgeInsets.zero,
    ),
  );
}
