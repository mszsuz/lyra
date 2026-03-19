import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/build_info.dart';
import 'registration_provider.dart';

/// Formats phone number: +7 (900) 123-45-67
class _PhoneFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final digits = newValue.text.replaceAll(RegExp(r'[^\d]'), '');
    final limited = digits.length > 11 ? digits.substring(0, 11) : digits;

    final buf = StringBuffer('+');
    for (var i = 0; i < limited.length; i++) {
      if (i == 0) {
        buf.write(limited[i]);
      } else if (i == 1) {
        buf.write(' (${limited[i]}');
      } else if (i == 3) {
        buf.write('${limited[i]}) ');
      } else if (i == 7) {
        buf.write('-${limited[i]}');
      } else if (i == 9) {
        buf.write('-${limited[i]}');
      } else {
        buf.write(limited[i]);
      }
    }

    final text = buf.toString();
    return TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
  }
}

class RegistrationScreen extends ConsumerStatefulWidget {
  const RegistrationScreen({super.key});

  @override
  ConsumerState<RegistrationScreen> createState() => _RegistrationScreenState();
}

class _RegistrationScreenState extends ConsumerState<RegistrationScreen> {
  final _phoneController = TextEditingController(text: '+7');
  final _codeControllers = List.generate(4, (_) => TextEditingController());
  final _codeFocusNodes = List.generate(4, (_) => FocusNode());
  String _submittedPhone = '';

  @override
  void dispose() {
    _phoneController.dispose();
    for (final c in _codeControllers) {
      c.dispose();
    }
    for (final f in _codeFocusNodes) {
      f.dispose();
    }
    super.dispose();
  }

  String _rawPhone() {
    return '+${_phoneController.text.replaceAll(RegExp(r'[^\d]'), '')}';
  }

  void _clearCode() {
    for (final c in _codeControllers) {
      c.clear();
    }
  }

  String _getCode() {
    return _codeControllers.map((c) => c.text).join();
  }

  void _tryAutoSubmit() {
    final code = _getCode();
    if (code.length == 4) {
      ref.read(registrationProvider.notifier).confirmCode(code);
    }
  }

  void _resetToPhone() {
    _clearCode();
    ref.invalidate(registrationProvider);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(registrationProvider);

    ref.listen<RegistrationState>(registrationProvider, (prev, next) {
      if (next.step == RegistrationStep.done) {
        context.go('/home');
      }
      if (next.step == RegistrationStep.codeInput &&
          prev?.step != RegistrationStep.codeInput) {
        Future.delayed(
          const Duration(milliseconds: 100),
          () {
            if (mounted) _codeFocusNodes[0].requestFocus();
          },
        );
      }
    });

    return Scaffold(
      body: Stack(
        children: [
          Column(
            children: [
              _buildHeader(context),
              Expanded(
                child: Container(
                  color: Colors.white,
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.all(20),
                    child: _buildContent(state),
                  ),
                ),
              ),
            ],
          ),
          Positioned(
            bottom: 8,
            left: 0,
            right: 0,
            child: Text(
              'build $buildNumber',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 10, color: LyraTheme.textMuted),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
    return Container(
      color: LyraTheme.accent,
      width: double.infinity,
      padding: EdgeInsets.only(
        top: MediaQuery.of(context).padding.top + 16,
        bottom: 28,
        left: 24,
        right: 24,
      ),
      child: Column(
        children: [
          Container(
            width: 64,
            height: 64,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
            ),
            child: const Center(
              child: Text(
                '\u266a',
                style: TextStyle(
                  fontSize: 32,
                  color: LyraTheme.accent,
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          const Text(
            '\u0420\u0435\u0433\u0438\u0441\u0442\u0440\u0430\u0446\u0438\u044f',
            style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w800,
              color: Colors.white,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '\u0412\u043e\u0439\u0434\u0438\u0442\u0435 \u043f\u043e \u043d\u043e\u043c\u0435\u0440\u0443 \u0442\u0435\u043b\u0435\u0444\u043e\u043d\u0430',
            style: TextStyle(
              fontSize: 14,
              color: Colors.white.withValues(alpha: 0.7),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildContent(RegistrationState state) {
    if (state.step == RegistrationStep.error) {
      return _buildError(state);
    }
    if (state.step == RegistrationStep.done) {
      return const Padding(
        padding: EdgeInsets.only(top: 60),
        child: Center(child: CircularProgressIndicator()),
      );
    }

    final isCodeStep = state.step == RegistrationStep.codeInput ||
        state.step == RegistrationStep.confirming;

    if (isCodeStep) {
      return _buildCodeStep(state);
    }
    return _buildPhoneStep(state);
  }

  Widget _buildPhoneStep(RegistrationState state) {
    final isLoading = state.step == RegistrationStep.waitingSms;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 20),
        const Text(
          '\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043d\u043e\u043c\u0435\u0440 \u0442\u0435\u043b\u0435\u0444\u043e\u043d\u0430',
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w800,
            color: LyraTheme.textPrimary,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 6),
        const Text(
          '\u041c\u044b \u043e\u0442\u043f\u0440\u0430\u0432\u0438\u043c SMS \u0441 \u043a\u043e\u0434\u043e\u043c \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u044f',
          style: TextStyle(
            fontSize: 14,
            color: LyraTheme.textSecondary,
          ),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 28),
        TextField(
          controller: _phoneController,
          keyboardType: TextInputType.phone,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w700,
            color: LyraTheme.textPrimary,
            letterSpacing: 1,
          ),
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[+0-9() \-]')),
            _PhoneFormatter(),
          ],
          decoration: InputDecoration(
            hintText: '+7 (900) 123-45-67',
            hintStyle: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w700,
              color: LyraTheme.textMuted.withValues(alpha: 0.5),
              letterSpacing: 1,
            ),
            filled: true,
            fillColor: LyraTheme.bgAlt,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
              borderSide: const BorderSide(color: LyraTheme.divider, width: 2),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
              borderSide: const BorderSide(color: LyraTheme.divider, width: 2),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
              borderSide: const BorderSide(color: LyraTheme.accent, width: 2),
            ),
            contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
          ),
        ),
        const SizedBox(height: 20),
        SizedBox(
          height: 52,
          child: ElevatedButton(
            onPressed: isLoading
                ? null
                : () {
                    final phone = _rawPhone();
                    if (phone.length >= 12) {
                      _submittedPhone = _phoneController.text;
                      ref.read(registrationProvider.notifier).sendPhone(phone);
                    }
                  },
            child: isLoading
                ? const SizedBox(
                    height: 22,
                    width: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      color: Colors.white,
                    ),
                  )
                : const Text(
                    '\u041f\u041e\u041b\u0423\u0427\u0418\u0422\u042c \u041a\u041e\u0414',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.5,
                    ),
                  ),
          ),
        ),
      ],
    );
  }

  Widget _buildCodeStep(RegistrationState state) {
    final isLoading = state.step == RegistrationStep.confirming;
    final hasError = state.errorMessage != null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 16),

        // Success banner: SMS sent
        if (!hasError)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: LyraTheme.greenBg,
              borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
              border: Border.all(color: LyraTheme.green.withValues(alpha: 0.3)),
            ),
            child: Row(
              children: [
                const Icon(Icons.check_circle, color: LyraTheme.green, size: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    'SMS \u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e \u043d\u0430 $_submittedPhone',
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: LyraTheme.green,
                    ),
                  ),
                ),
              ],
            ),
          ),

        // Error banner: invalid code
        if (hasError)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            decoration: BoxDecoration(
              color: LyraTheme.redBg,
              borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
              border: Border.all(color: LyraTheme.red.withValues(alpha: 0.3)),
            ),
            child: Row(
              children: [
                const Icon(Icons.error_outline, color: LyraTheme.red, size: 20),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    state.errorMessage!,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: LyraTheme.red,
                    ),
                  ),
                ),
              ],
            ),
          ),

        const SizedBox(height: 12),

        // Change number link
        Align(
          alignment: Alignment.centerRight,
          child: GestureDetector(
            onTap: _resetToPhone,
            child: const Text(
              '\u0418\u0437\u043c\u0435\u043d\u0438\u0442\u044c \u043d\u043e\u043c\u0435\u0440',
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: LyraTheme.accent,
              ),
            ),
          ),
        ),

        const SizedBox(height: 24),

        // Code title
        const Text(
          '\u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043a\u043e\u0434 \u0438\u0437 SMS',
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w800,
            color: LyraTheme.textPrimary,
          ),
          textAlign: TextAlign.center,
        ),

        const SizedBox(height: 20),

        // 4 code input boxes
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: List.generate(4, (i) {
            return Container(
              width: 62,
              height: 68,
              margin: const EdgeInsets.symmetric(horizontal: 6),
              child: TextField(
                controller: _codeControllers[i],
                focusNode: _codeFocusNodes[i],
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 28,
                  fontWeight: FontWeight.w900,
                  color: LyraTheme.textPrimary,
                ),
                keyboardType: TextInputType.number,
                inputFormatters: [
                  FilteringTextInputFormatter.digitsOnly,
                  LengthLimitingTextInputFormatter(1),
                ],
                enabled: !isLoading,
                decoration: InputDecoration(
                  filled: true,
                  fillColor: LyraTheme.bgAlt,
                  contentPadding: const EdgeInsets.symmetric(vertical: 16),
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
                    borderSide: const BorderSide(color: LyraTheme.divider, width: 2),
                  ),
                  enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
                    borderSide: const BorderSide(color: LyraTheme.divider, width: 2),
                  ),
                  focusedBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(LyraTheme.radiusSm),
                    borderSide: const BorderSide(color: LyraTheme.accent, width: 2),
                  ),
                ),
                onChanged: (val) {
                  if (val.isNotEmpty && i < 3) {
                    _codeFocusNodes[i + 1].requestFocus();
                  }
                  if (val.isEmpty && i > 0) {
                    _codeFocusNodes[i - 1].requestFocus();
                  }
                  _tryAutoSubmit();
                },
              ),
            );
          }),
        ),

        // Attempts counter
        if (state.attemptsLeft != null) ...[
          const SizedBox(height: 12),
          Text(
            '\u041e\u0441\u0442\u0430\u043b\u043e\u0441\u044c \u043f\u043e\u043f\u044b\u0442\u043e\u043a: ${state.attemptsLeft}',
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w500,
              color: LyraTheme.textSecondary,
            ),
            textAlign: TextAlign.center,
          ),
        ],

        const SizedBox(height: 24),

        // Confirm button
        SizedBox(
          height: 52,
          child: ElevatedButton(
            onPressed: isLoading
                ? null
                : () {
                    final code = _getCode();
                    if (code.length == 4) {
                      ref.read(registrationProvider.notifier).confirmCode(code);
                    }
                  },
            child: isLoading
                ? const SizedBox(
                    height: 22,
                    width: 22,
                    child: CircularProgressIndicator(
                      strokeWidth: 2.5,
                      color: Colors.white,
                    ),
                  )
                : const Text(
                    '\u041f\u041e\u0414\u0422\u0412\u0415\u0420\u0414\u0418\u0422\u042c',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w700,
                      letterSpacing: 0.5,
                    ),
                  ),
          ),
        ),
      ],
    );
  }

  Widget _buildError(RegistrationState state) {
    return Column(
      children: [
        const SizedBox(height: 40),
        Container(
          padding: const EdgeInsets.all(20),
          decoration: BoxDecoration(
            color: LyraTheme.redBg,
            borderRadius: BorderRadius.circular(LyraTheme.radius),
            border: Border.all(color: LyraTheme.red.withValues(alpha: 0.3)),
          ),
          child: Column(
            children: [
              const Icon(Icons.error_outline, size: 48, color: LyraTheme.red),
              const SizedBox(height: 16),
              Text(
                state.errorMessage ?? '\u041f\u0440\u043e\u0438\u0437\u043e\u0448\u043b\u0430 \u043e\u0448\u0438\u0431\u043a\u0430',
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w600,
                  color: LyraTheme.textPrimary,
                ),
                textAlign: TextAlign.center,
              ),
              if (state.retryAfter != null) ...[
                const SizedBox(height: 8),
                Text(
                  '\u041f\u043e\u0432\u0442\u043e\u0440\u0438\u0442\u0435 \u0447\u0435\u0440\u0435\u0437 ${(state.retryAfter! / 60).ceil()} \u043c\u0438\u043d.',
                  style: const TextStyle(
                    fontSize: 14,
                    color: LyraTheme.textSecondary,
                  ),
                  textAlign: TextAlign.center,
                ),
              ],
            ],
          ),
        ),
        const SizedBox(height: 24),
        SizedBox(
          height: 52,
          width: double.infinity,
          child: ElevatedButton(
            onPressed: _resetToPhone,
            child: const Text(
              '\u041f\u041e\u041f\u0420\u041e\u0411\u041e\u0412\u0410\u0422\u042c \u0421\u041d\u041e\u0412\u0410',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.5,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
