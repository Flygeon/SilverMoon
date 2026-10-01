import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:silvermoon/host/json_store.dart';

/// [JsonStore] 的语义必须与 Electron `electron/store.ts` 一致：过渡期两版读写
/// 同一批文件，任何一处偏差都会表现成「用户的设置看起来丢了」。
void main() {
  late Directory root;

  setUp(() {
    root = Directory.systemTemp.createTempSync('silvermoon_store_');
  });

  tearDown(() {
    if (root.existsSync()) root.deleteSync(recursive: true);
  });

  String filePath(String name) => root.path + Platform.pathSeparator + name;

  group('文件名', () {
    test('只取 basename，文件名不能影响目录层级', () {
      final JsonStore store = JsonStore(root.path);
      store.write('../../evil.json', 'k', 1);
      store.save('../../evil.json');

      expect(File(filePath('evil.json')).existsSync(), isTrue);
      expect(
        File(
          root.parent.path + Platform.pathSeparator + 'evil.json',
        ).existsSync(),
        isFalse,
        reason: '不允许穿出数据目录',
      );
    });

    test('空文件名退回 store.json', () {
      final JsonStore store = JsonStore(root.path);
      store.write('', 'k', 1);
      store.save('');
      expect(File(filePath('store.json')).existsSync(), isTrue);
    });
  });

  group('读写与落盘', () {
    test('未 save 不产生文件；save 后是 2 空格缩进的整对象', () {
      final JsonStore store = JsonStore(root.path);
      store.write(
        'settings.json',
        'settings',
        <String, Object?>{'theme': 'dark'},
      );
      expect(
        File(filePath('settings.json')).existsSync(),
        isFalse,
        reason: '与 Electron 一致：write 只改内存，save 才落盘',
      );

      store.save('settings.json');
      final String raw = File(filePath('settings.json')).readAsStringSync();
      expect(
        jsonDecode(raw),
        <String, Object?>{
          'settings': <String, Object?>{'theme': 'dark'},
        },
      );
      expect(raw.contains('\n  "settings"'), isTrue, reason: '缩进必须是 2 空格');
    });

    test('原子写不留下 .tmp', () {
      final JsonStore store = JsonStore(root.path);
      store.write('a.json', 'k', 'v');
      store.save('a.json');
      expect(File(filePath('a.json.tmp')).existsSync(), isFalse);
    });

    test('新实例能读回；缺键与不存在的文件都是 null', () {
      final JsonStore store = JsonStore(root.path);
      store.write('a.json', 'k', 'v');
      store.save('a.json');

      final JsonStore reopened = JsonStore(root.path);
      expect(reopened.read('a.json', 'k'), 'v');
      expect(reopened.read('a.json', 'missing'), isNull);
      expect(reopened.read('never-existed.json', 'k'), isNull);
    });

    test('「值是 null」与「没有这个键」一致返回 null', () {
      final JsonStore store = JsonStore(root.path);
      store.write('a.json', 'k', null);
      expect(store.read('a.json', 'k'), isNull);
    });
  });

  group('损坏文件', () {
    test('解析失败退化成空 store，且原文件原样保留', () {
      final File broken = File(filePath('settings.json'));
      broken.writeAsStringSync('{ this is not json');

      final JsonStore store = JsonStore(root.path);
      expect(store.read('settings.json', 'settings'), isNull);
      expect(store.handle(<String, Object?>{'file': 'settings.json', 'op': 'length'}), 0);

      store.flushAll();
      expect(broken.readAsStringSync(), '{ this is not json');
    });

    test('顶层是数组（结构不对）也退化成空 store', () {
      File(filePath('arr.json')).writeAsStringSync('[1,2,3]');
      final JsonStore store = JsonStore(root.path);
      expect(store.read('arr.json', 'a'), isNull);
      expect(store.handle(<String, Object?>{'file': 'arr.json', 'op': 'keys'}), isEmpty);
    });
  });

  group('handle（bridge 的 store 通道直接转发）', () {
    test('set / get / has / keys / values / entries / length / delete / clear', () {
      final JsonStore store = JsonStore(root.path);
      const Map<String, Object?> base = <String, Object?>{'file': 'x.json'};

      expect(
        store.handle(<String, Object?>{...base, 'op': 'set', 'key': 'a', 'value': 1}),
        isNull,
      );
      expect(store.handle(<String, Object?>{...base, 'op': 'get', 'key': 'a'}), 1);
      expect(store.handle(<String, Object?>{...base, 'op': 'has', 'key': 'a'}), isTrue);
      expect(store.handle(<String, Object?>{...base, 'op': 'keys'}), <String>['a']);
      expect(store.handle(<String, Object?>{...base, 'op': 'values'}), <Object?>[1]);
      expect(
        store.handle(<String, Object?>{...base, 'op': 'entries'}),
        <Object?>[
          <Object?>['a', 1],
        ],
      );
      expect(store.handle(<String, Object?>{...base, 'op': 'length'}), 1);

      expect(store.handle(<String, Object?>{...base, 'op': 'delete', 'key': 'a'}), isTrue);
      expect(store.handle(<String, Object?>{...base, 'op': 'delete', 'key': 'a'}), isFalse);

      store.handle(<String, Object?>{...base, 'op': 'set', 'key': 'b', 'value': 2});
      expect(store.handle(<String, Object?>{...base, 'op': 'clear'}), isNull);
      expect(store.handle(<String, Object?>{...base, 'op': 'length'}), 0);
    });

    test('缺 file 时默认 store.json', () {
      final JsonStore store = JsonStore(root.path);
      store.handle(<String, Object?>{'op': 'set', 'key': 'k', 'value': 'v'});
      store.flushAll();
      expect(File(filePath('store.json')).existsSync(), isTrue);
    });

    test('未知 op 抛错', () {
      final JsonStore store = JsonStore(root.path);
      expect(
        () => store.handle(<String, Object?>{'file': 'a.json', 'op': 'nope'}),
        throwsA(isA<StateError>()),
      );
    });

    test('set 缺 key 抛错', () {
      final JsonStore store = JsonStore(root.path);
      expect(
        () => store.handle(<String, Object?>{'file': 'a.json', 'op': 'set'}),
        throwsA(isA<StateError>()),
      );
    });
  });
}
