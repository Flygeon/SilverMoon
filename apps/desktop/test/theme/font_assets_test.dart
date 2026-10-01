import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:silvermoon/theme/app_theme.dart';
import 'package:silvermoon/theme/design_tokens.dart';

/// 字体是「看起来对不对」的东西，没法用断言表达；但**接错线**可以：
/// pubspec 里声明的字体文件缺失、或字族常量与 Electron 版的栈不一致，
/// 都会让界面悄悄退到系统默认字体，而 analyze / build 都不会报错。
void main() {
  test('pubspec 声明的字体文件都真实存在且非空', () {
    final String pubspec = File('pubspec.yaml').readAsStringSync();
    final List<String> fonts = <String>[];
    for (final RegExpMatch m
        in RegExp(r'^\s*- asset:\s*(\S+)\s*$', multiLine: true).allMatches(pubspec)) {
      final String path = m.group(1)!;
      if (path.contains('fonts/')) fonts.add(path);
    }

    expect(
      fonts.toSet(),
      <String>{
        'assets/fonts/Roboto-Regular.ttf',
        'assets/fonts/Roboto-Medium.ttf',
        'assets/fonts/Roboto-Bold.ttf',
        'assets/fonts/Roboto-Italic.ttf',
        'assets/fonts/SarasaGothicSC-Regular.ttf',
      },
      reason: 'pubspec 里的字体清单应与打包的 5 个字库一致',
    );

    for (final String path in fonts) {
      final File f = File(path);
      expect(f.existsSync(), isTrue, reason: '缺少字体文件 ' + path);
      expect(f.lengthSync(), greaterThan(1000), reason: path + ' 是空文件');
    }
  });

  test('全局字族与回退链和 Electron 版一致', () {
    // theme.css:285 → "Roboto", "SarasaGothicSC-Regular", ...
    expect(kSmFontFamily, 'Roboto');
    expect(kSmFontFamilyFallback.first, 'SarasaGothicSC-Regular');
    expect(kSmFontFamilyFallback, contains('Microsoft YaHei'));
  });

  test('字族真的落到了主题与字阶上', () {
    final ThemeData light = AppTheme.light();
    for (final TextStyle? s in <TextStyle?>[
      light.textTheme.bodyMedium,
      light.textTheme.titleLarge,
    ]) {
      expect(s?.fontFamily, kSmFontFamily);
      expect(s?.fontFamilyFallback, contains('SarasaGothicSC-Regular'));
    }

    // 直接吃 *Theme.textStyle、不与 TextTheme 合并的组件靠这一条兜住
    for (final TextStyle s in <TextStyle>[
      AppText.bodyMedium,
      AppText.bodySmall,
      AppText.titleLarge,
      AppText.labelSmall,
    ]) {
      expect(s.fontFamily, kSmFontFamily);
      expect(s.fontFamilyFallback, kSmFontFamilyFallback);
    }
  });
}
