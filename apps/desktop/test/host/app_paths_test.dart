import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:silvermoon/host/app_paths.dart';

/// 这几个路径必须与 Rust `app_data_dir()`、Electron `config.ts` 完全一致。
/// 一旦漂移，症状是「库读得到、设置却是空的」这类静默错位。
///
/// 断言刻意与平台分隔符无关：CI 的 Dart 测试跑在 ubuntu 上。
void main() {
  final String sep = Platform.pathSeparator;

  group('HostPaths.forRoots', () {
    const HostPaths paths = HostPaths.forRoots(
      identifier: 'cn.cool.silvermoon',
      appDataRoot: 'APPDATA_ROOT',
      localAppDataRoot: 'LOCALAPPDATA_ROOT',
    );

    test('数据目录 = <APPDATA>/<identifier>（目录名是 identifier，不是 productName）', () {
      expect(paths.dataDir, 'APPDATA_ROOT' + sep + 'cn.cool.silvermoon');
    });

    test('缓存目录 = <LOCALAPPDATA>/<identifier>/cache', () {
      expect(
        paths.cacheDir,
        'LOCALAPPDATA_ROOT' + sep + 'cn.cool.silvermoon' + sep + 'cache',
      );
    });

    test('日志目录在数据目录下', () {
      expect(paths.logDir, paths.dataDir + sep + 'logs');
    });

    test('库与设置落在数据目录根', () {
      expect(paths.indexPath, paths.dataDir + sep + 'library.db');
      expect(paths.settingsPath, paths.dataDir + sep + 'settings.json');
    });

    test('旧标识目录与新目录同级', () {
      expect(
        paths.legacyDataDir('cn.cool.lumiluna'),
        'APPDATA_ROOT' + sep + 'cn.cool.lumiluna',
      );
    });

    test('根目录已带分隔符时不重复', () {
      final HostPaths withSep = HostPaths.forRoots(
        identifier: 'cn.cool.silvermoon',
        appDataRoot: 'APPDATA_ROOT' + sep,
        localAppDataRoot: 'LOCALAPPDATA_ROOT' + sep,
      );
      expect(withSep.dataDir, 'APPDATA_ROOT' + sep + 'cn.cool.silvermoon');
      expect(
        withSep.cacheDir,
        'LOCALAPPDATA_ROOT' + sep + 'cn.cool.silvermoon' + sep + 'cache',
      );
    });
  });

  test('ensureDataDirs 建出数据 / 缓存 / 日志三个目录', () {
    final Directory tmp = Directory.systemTemp.createTempSync('silvermoon_paths_');
    addTearDown(() {
      if (tmp.existsSync()) tmp.deleteSync(recursive: true);
    });

    final HostPaths paths = HostPaths.forRoots(
      identifier: 'cn.cool.silvermoon',
      appDataRoot: tmp.path + sep + 'appdata',
      localAppDataRoot: tmp.path + sep + 'localappdata',
    );
    paths.ensureDataDirs();

    expect(Directory(paths.dataDir).existsSync(), isTrue);
    expect(Directory(paths.cacheDir).existsSync(), isTrue);
    expect(Directory(paths.logDir).existsSync(), isTrue);
  });
}
