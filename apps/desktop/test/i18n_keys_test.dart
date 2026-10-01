import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:silvermoon/i18n/sm_strings.dart';

/// 词条 key 的存在性检查。
///
/// 缺 key 在 Flutter 侧不会编译报错（`t()` 拿不到就原样返回 key），
/// 只会在界面上显示出一串英文点号——这类问题很难在人工点测里发现，
/// 所以用测试把 lib/ 下所有字面量 key 与词条表对齐。
void main() {
  test('lib/ 里用到的每个词条 key 都存在于词条表', () {
    final Set<String> known = SmStrings.keysOf('zh');
    expect(known, isNotEmpty);

    // t('x.y') / labelKey: 'x.y' 这类字面量；语言名（'中文' / 'English'）
    // 这种不含点的直出文案不在检查范围。
    final RegExp callPattern = RegExp(r"\.t\(\s*'([^']+)'");
    final RegExp fieldPattern = RegExp(
      r"(?:labelKey|hintKey|placeholderKey|offLabelKey|titleKey|descKey):\s*'([^']+)'",
    );
    final RegExp choicePattern = RegExp(r"SmChoice\([^,]+,\s*'([^']+)'\)");

    final List<String> missing = <String>[];
    final Directory lib = Directory('lib');
    expect(lib.existsSync(), isTrue, reason: '测试工作目录应当是包根目录');

    for (final FileSystemEntity entity in lib.listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      // 词条表本身只存 key，不调用 t()，跳过以免自引用。
      if (entity.path.contains('lib/i18n/')) continue;
      final String source = entity.readAsStringSync();
      for (final RegExp pattern in <RegExp>[callPattern, fieldPattern, choicePattern]) {
        for (final RegExpMatch match in pattern.allMatches(source)) {
          final String key = match.group(1)!;
          if (!key.contains('.')) continue;
          if (!known.contains(key)) missing.add(key + ' <- ' + entity.path);
        }
      }
    }

    expect(missing, isEmpty, reason: '缺失词条：\n' + missing.join('\n'));
  });
}
