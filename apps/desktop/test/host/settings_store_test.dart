import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:silvermoon/host/json_store.dart';
import 'package:silvermoon/host/settings_store.dart';

/// settings.json 的文件形状与键名由 Electron 版固定，**不能改**，否则读不到既有数据：
///   settings.json = { "settings": { ...约 75 个字段... } }
void main() {
  late Directory root;
  late JsonStore raw;
  late SettingsStore settings;

  setUp(() {
    root = Directory.systemTemp.createTempSync('silvermoon_settings_');
    raw = JsonStore(root.path);
    settings = SettingsStore(raw);
  });

  tearDown(() {
    if (root.existsSync()) root.deleteSync(recursive: true);
  });

  String filePath() => root.path + Platform.pathSeparator + 'settings.json';

  test('空库读出空表与空目录列表', () {
    expect(settings.read(), isEmpty);
    expect(settings.scanDirs(), isEmpty);
  });

  test('addScanDir 写进 settings 键下并立即落盘', () {
    settings.addScanDir('D:/照片');

    final Object? written = jsonDecode(File(filePath()).readAsStringSync());
    expect(written, <String, Object?>{
      'settings': <String, Object?>{
        'scanDirs': <String>['D:/照片'],
      },
    });
    expect(settings.scanDirs(), <String>['D:/照片']);
  });

  test('addScanDir 去重，且忽略空串', () {
    settings.addScanDir('D:/照片');
    settings.addScanDir('D:/照片');
    settings.addScanDir('   ');
    expect(settings.scanDirs(), <String>['D:/照片']);
  });

  test('merge 只覆盖给定字段，不抹掉其它字段与既有扫描目录', () {
    settings.merge(<String, Object?>{
      'theme': 'dark',
      'scanDirs': <String>['D:/照片'],
      'minFileSizeMb': 1,
    });
    settings.merge(<String, Object?>{'theme': 'light'});

    final Map<String, Object?> data = settings.read();
    expect(data['theme'], 'light');
    expect(data['scanDirs'], <String>['D:/照片']);
    expect(data['minFileSizeMb'], 1);
  });

  test('addScanDir 与 merge 混用时两边字段都在', () {
    settings.merge(<String, Object?>{'theme': 'dark'});
    settings.addScanDir('D:/a');
    settings.addScanDir('D:/b');

    final Map<String, Object?> data = settings.read();
    expect(data['theme'], 'dark');
    expect(data['scanDirs'], <String>['D:/a', 'D:/b']);
  });

  test('settings 结构不对时退化成空表，而不是崩', () {
    File(filePath()).writeAsStringSync(
      jsonEncode(<String, Object?>{'settings': <Object?>[1, 2]}),
    );
    final SettingsStore reopened = SettingsStore(JsonStore(root.path));
    expect(reopened.read(), isEmpty);
    expect(reopened.scanDirs(), isEmpty);
  });

  test('scanDirs 混入非字符串时只取字符串', () {
    File(filePath()).writeAsStringSync(
      jsonEncode(<String, Object?>{
        'settings': <String, Object?>{
          'scanDirs': <Object?>['D:/a', 7, null, ''],
        },
      }),
    );
    final SettingsStore reopened = SettingsStore(JsonStore(root.path));
    expect(reopened.scanDirs(), <String>['D:/a']);
  });
}
