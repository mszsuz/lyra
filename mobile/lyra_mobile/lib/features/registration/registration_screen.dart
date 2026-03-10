import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/build_info.dart';
import 'registration_provider.dart';

/// Форматирует номер телефона: +7 (900) 123-45-67
class _PhoneFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    // Извлекаем только цифры (без +)
    final digits = newValue.text.replaceAll(RegExp(r'[^\d]'), '');

    // Ограничиваем 11 цифрами (7 + 10)
    final limited = digits.length > 11 ? digits.substring(0, 11) : digits;

    final buf = StringBuffer('+');
    for (var i = 0; i < limited.length; i++) {
      if (i == 0) {
        buf.write(limited[i]); // 7
      } else if (i == 1) {
        buf.write(' (${limited[i]}'); // (9
      } else if (i == 3) {
        buf.write('${limited[i]}) '); // 0)
      } else if (i == 7) {
        buf.write('-${limited[i]}'); // -4
      } else if (i == 9) {
        buf.write('-${limited[i]}'); // -6
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
  ConsumerState<RegistrationScreen> createState() =>
      _RegistrationScreenState();
}

class _RegistrationScreenState extends ConsumerState<RegistrationScreen> {
  final _phoneController = TextEditingController(text: '+7');
  final _codeController = TextEditingController();
  final _codeFocusNode = FocusNode();
  String _submittedPhone = '';

  @override
  void dispose() {
    _phoneController.dispose();
    _codeController.dispose();
    _codeFocusNode.dispose();
    super.dispose();
  }

  String _rawPhone() {
    return '+${_phoneController.text.replaceAll(RegExp(r'[^\d]'), '')}';
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
        // Автофокус на поле кода
        Future.delayed(
          const Duration(milliseconds: 100),
          () => _codeFocusNode.requestFocus(),
        );
      }
    });

    return Scaffold(
      appBar: AppBar(
        title: const Text('Регистрация'),
      ),
      body: Stack(
        children: [
          SingleChildScrollView(
            padding: const EdgeInsets.all(24.0),
            child: _buildContent(state),
          ),
          const Positioned(
            bottom: 8,
            left: 0,
            right: 0,
            child: Text(
              'build $buildNumber',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 10, color: Colors.grey),
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
      return const Center(child: CircularProgressIndicator());
    }

    final isPhoneStep = state.step == RegistrationStep.phoneInput ||
        state.step == RegistrationStep.waitingSms;
    final isCodeStep = state.step == RegistrationStep.codeInput ||
        state.step == RegistrationStep.confirming;
    final isPhoneLoading = state.step == RegistrationStep.waitingSms;
    final isCodeLoading = state.step == RegistrationStep.confirming;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 40),
        const Text(
          'Введите номер телефона',
          style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
          textAlign: TextAlign.center,
        ),
        const SizedBox(height: 8),
        Text(
          isCodeStep
              ? 'SMS отправлено на $_submittedPhone'
              : 'Мы отправим SMS с кодом подтверждения',
          textAlign: TextAlign.center,
          style: TextStyle(
            color: isCodeStep ? Colors.green.shade700 : Colors.grey,
          ),
        ),
        const SizedBox(height: 32),

        // Поле телефона — всегда видно
        TextField(
          controller: _phoneController,
          keyboardType: TextInputType.phone,
          inputFormatters: [
            FilteringTextInputFormatter.allow(RegExp(r'[+0-9() \-]')),
            _PhoneFormatter(),
          ],
          decoration: const InputDecoration(
            labelText: 'Телефон',
            hintText: '+7 (900) 123-45-67',
            border: OutlineInputBorder(),
            prefixIcon: Icon(Icons.phone),
          ),
          enabled: isPhoneStep,
        ),
        const SizedBox(height: 16),

        // Кнопка "Получить код" — только на этапе ввода телефона
        if (isPhoneStep)
          FilledButton(
            onPressed: isPhoneLoading
                ? null
                : () {
                    final phone = _rawPhone();
                    if (phone.length >= 12) {
                      _submittedPhone = _phoneController.text;
                      ref
                          .read(registrationProvider.notifier)
                          .sendPhone(phone);
                    }
                  },
            child: isPhoneLoading
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Text('Получить код'),
          ),

        // Ссылка "Изменить номер" — на этапе ввода кода
        if (isCodeStep)
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: () {
                _codeController.clear();
                ref.invalidate(registrationProvider);
              },
              child: const Text('Изменить номер'),
            ),
          ),

        // Поле кода — появляется после отправки SMS
        if (isCodeStep) ...[
          const SizedBox(height: 16),
          TextField(
            controller: _codeController,
            focusNode: _codeFocusNode,
            keyboardType: TextInputType.number,
            inputFormatters: [
              FilteringTextInputFormatter.digitsOnly,
              LengthLimitingTextInputFormatter(4),
            ],
            decoration: const InputDecoration(
              labelText: 'Код из SMS',
              hintText: '0000',
              border: OutlineInputBorder(),
              prefixIcon: Icon(Icons.lock_outline),
            ),
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 24, letterSpacing: 8),
            enabled: !isCodeLoading,
            onChanged: (value) {
              // Авто-отправка при вводе 4 цифр
              if (value.length == 4) {
                ref.read(registrationProvider.notifier).confirmCode(value);
              }
            },
          ),
          if (state.errorMessage != null) ...[
            const SizedBox(height: 12),
            Text(
              state.errorMessage!,
              style: const TextStyle(color: Colors.red),
              textAlign: TextAlign.center,
            ),
          ],
          if (state.attemptsLeft != null) ...[
            const SizedBox(height: 4),
            Text(
              'Осталось попыток: ${state.attemptsLeft}',
              style: const TextStyle(color: Colors.orange),
              textAlign: TextAlign.center,
            ),
          ],
          const SizedBox(height: 24),
          FilledButton(
            onPressed: isCodeLoading
                ? null
                : () {
                    final code = _codeController.text.trim();
                    if (code.length == 4) {
                      ref
                          .read(registrationProvider.notifier)
                          .confirmCode(code);
                    }
                  },
            child: isCodeLoading
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Text('Подтвердить'),
          ),
        ],
      ],
    );
  }

  Widget _buildError(RegistrationState state) {
    return Column(
      children: [
        const SizedBox(height: 80),
        const Icon(Icons.error_outline, size: 64, color: Colors.red),
        const SizedBox(height: 16),
        Text(
          state.errorMessage ?? 'Произошла ошибка',
          style: const TextStyle(fontSize: 16),
          textAlign: TextAlign.center,
        ),
        if (state.retryAfter != null) ...[
          const SizedBox(height: 8),
          Text(
            'Повторите через ${(state.retryAfter! / 60).ceil()} мин.',
            style: const TextStyle(color: Colors.grey),
            textAlign: TextAlign.center,
          ),
        ],
        const SizedBox(height: 24),
        FilledButton(
          onPressed: () {
            ref.invalidate(registrationProvider);
          },
          child: const Text('Попробовать снова'),
        ),
      ],
    );
  }
}
