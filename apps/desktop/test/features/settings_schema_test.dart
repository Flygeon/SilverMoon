import 'package:flutter_test/flutter_test.dart';
import 'package:silvermoon/features/settings/settings_schema.dart';
import 'package:silvermoon/i18n/sm_strings.dart';

/// 设置表的静态约束。
///
/// 这张表是 settings.json 的界面投影：键名、默认值、取值范围一旦与归档
/// stores/settings.ts 的 DEFAULTS 不一致，就会「读不到」或「存错键」——
/// 而 Flutter 侧没有编译期保护，所以用测试把约束钉死。
void main() {
  final List<SmField> fields = <SmField>[
    for (final SmSection section in kSettingsSections) ...section.fields,
  ];

  test('字段 key 不重复', () {
    final Set<String> keys = <String>{};
    for (final SmField field in fields) {
      expect(keys.add(field.key), isTrue, reason: '重复字段: ' + field.key);
    }
    expect(keys, isNotEmpty);
  });

  test('分节 id 不重复，且每个分节都有文案', () {
    final Set<String> ids = <String>{};
    for (final SmSection section in kSettingsSections) {
      expect(ids.add(section.id), isTrue, reason: '重复分节: ' + section.id);
      expect(section.titleKey, isNotEmpty);
    }
  });

  test('控件与默认值自洽', () {
    for (final SmField field in fields) {
      switch (field.kind) {
        case SmFieldKind.toggle:
          expect(field.defaultValue, isA<bool>(), reason: field.key);
        case SmFieldKind.sliderInt:
          expect(field.min < field.max, isTrue, reason: field.key);
          expect(field.defaultValue, isA<int>(), reason: field.key);
        case SmFieldKind.sliderDouble:
          expect(field.min < field.max, isTrue, reason: field.key);
          expect(field.defaultValue, isA<double>(), reason: field.key);
        case SmFieldKind.choice:
          expect(field.choices, isNotEmpty, reason: field.key);
          // 默认值必须是候选项之一，否则打开设置页会是「一个都没选中」。
          final Iterable<String> values =
              field.choices.map((SmChoice choice) => choice.value);
          expect(values.contains(field.defaultValue), isTrue, reason: field.key);
        case SmFieldKind.colorSeed:
          expect(field.defaultValue, isA<String>(), reason: field.key);
        case SmFieldKind.text:
        case SmFieldKind.secret:
          expect(field.defaultValue, isA<String>(), reason: field.key);
        case SmFieldKind.readonly:
          break;
      }
    }
  });

  test('用到的每个词条在 zh / en 都存在', () {
    final Set<String> used = <String>{};
    // 只校验真正的词条 key：语言名（'中文' / 'English'）是刻意直出的字面量，
    // 不含点号，t() 取不到时原样返回正是预期行为。
    void addKey(String key) {
      if (key.contains('.')) used.add(key);
    }

    for (final SmSection section in kSettingsSections) {
      addKey(section.titleKey);
      addKey(section.hintKey);
      for (final SmField field in section.fields) {
        addKey(field.labelKey);
        addKey(field.hintKey);
        addKey(field.placeholderKey);
        addKey(field.offLabelKey);
        for (final SmChoice choice in field.choices) {
          addKey(choice.labelKey);
        }
      }
    }
    for (final SmChoice seed in kColorSeeds) {
      addKey(seed.labelKey);
    }
    for (final SmChoice font in kFontChoices) {
      addKey(font.labelKey);
    }

    expect(used, isNotEmpty);
    for (final String key in used) {
      expect(const SmStrings('zh').t(key), isNot(key), reason: 'zh 缺词条: ' + key);
      expect(const SmStrings('en').t(key), isNot(key), reason: 'en 缺词条: ' + key);
    }
  });
}
