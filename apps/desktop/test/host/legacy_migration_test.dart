import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:silvermoon/host/legacy_migration.dart';

/// 迁移是**一次性、只读旧目录、绝不覆盖目标**的动作：这三点任一被破坏，
/// 轻则每次启动重抄一遍，重则直接盖掉既有用户数据。
///
/// 断言与平台分隔符无关（CI 的 Dart 测试跑在 ubuntu 上）。
void main() {
  late Directory tmp;
  late String sep;
  late String target;
  late String legacy;

  setUp(() {
    tmp = Directory.systemTemp.createTempSync('silvermoon_migrate_');
    sep = Platform.pathSeparator;
    target = tmp.path + sep + 'cn.cool.silvermoon';
    legacy = tmp.path + sep + 'cn.cool.lumiluna';
  });

  tearDown(() {
    if (tmp.existsSync()) tmp.deleteSync(recursive: true);
  });

  group('shouldMigrate', () {
    test('目标不存在且旧目录存在时才为真', () {
      expect(
        shouldMigrate(dataDir: target, legacyDir: legacy),
        isFalse,
        reason: '旧目录都还不存在',
      );

      Directory(legacy).createSync(recursive: true);
      expect(shouldMigrate(dataDir: target, legacyDir: legacy), isTrue);

      Directory(target).createSync(recursive: true);
      expect(
        shouldMigrate(dataDir: target, legacyDir: legacy),
        isFalse,
        reason: '目标已存在就不能再迁移，否则可能覆盖用户数据',
      );
    });

    test('空路径一律不迁移', () {
      expect(shouldMigrate(dataDir: '', legacyDir: legacy), isFalse);
      expect(shouldMigrate(dataDir: target, legacyDir: ''), isFalse);
      expect(shouldMigrate(dataDir: '', legacyDir: ''), isFalse);
    });

    test('目标存在但为空目录，也不迁移', () {
      Directory(target).createSync(recursive: true);
      Directory(legacy).createSync(recursive: true);
      expect(shouldMigrate(dataDir: target, legacyDir: legacy), isFalse);
    });
  });

  group('copyTree', () {
    test('连嵌套目录一起复制，并返回文件数', () {
      Directory(legacy + sep + 'logs').createSync(recursive: true);
      File(legacy + sep + 'settings.json').writeAsStringSync('{"settings":{}}');
      File(legacy + sep + 'logs' + sep + 'main.log').writeAsStringSync('x');

      final int copied = copyTree(Directory(legacy), Directory(target));

      expect(copied, 2);
      expect(
        File(target + sep + 'settings.json').readAsStringSync(),
        '{"settings":{}}',
      );
      expect(
        File(target + sep + 'logs' + sep + 'main.log').existsSync(),
        isTrue,
      );
    });

    test('只读旧目录：源文件内容不变', () {
      Directory(legacy).createSync(recursive: true);
      final File src = File(legacy + sep + 'settings.json');
      src.writeAsStringSync('keep');

      copyTree(Directory(legacy), Directory(target));

      expect(src.readAsStringSync(), 'keep');
      expect(src.existsSync(), isTrue);
    });

    test('空目录也能复制（返回 0）', () {
      Directory(legacy).createSync(recursive: true);
      expect(copyTree(Directory(legacy), Directory(target)), 0);
      expect(Directory(target).existsSync(), isTrue);
    });

    test(
      '自指符号链接不会导致无限递归',
      () {
        Directory(legacy).createSync(recursive: true);
        Link(legacy + sep + 'self').createSync(legacy);

        expect(
          () => copyTree(Directory(legacy), Directory(target)),
          returnsNormally,
        );
        // 链接本身不复制
        expect(Link(target + sep + 'self').existsSync(), isFalse);
      },
      skip: Platform.isWindows ? 'Windows 建符号链接需要开发者模式' : null,
    );
  });
}
