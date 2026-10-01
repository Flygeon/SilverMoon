import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:silvermoon/host/sidecar.dart';

/// sidecar 的握手与回收。两条约定错了都会让应用「起得来但用不了」：
///   1. 就绪行 `SILVERMOON_READY {"port":N}` 的解析；
///   2. **stdin 必须一直开着** —— 后端读到 EOF 会立刻 exit(0)，
///      所以退出时靠关 stdin 让它自己走，超时才强杀。
void main() {
  group('parseReady', () {
    test('正常就绪行解析出端口，令牌原样带入', () {
      final SidecarEndpoint? ep = Sidecar.parseReady(
        'SILVERMOON_READY {"port":51234}',
        token: 'abc',
      );
      expect(ep, isNotNull);
      expect(ep!.port, 51234);
      expect(ep.token, 'abc');
      expect(ep.origin, 'http://127.0.0.1:51234');
    });

    test('容忍前后空白与 CRLF（Windows 上的 stdout 常带 \\r）', () {
      expect(
        Sidecar.parseReady('  SILVERMOON_READY {"port":1}  ', token: 't')!.port,
        1,
      );
      expect(
        Sidecar.parseReady('SILVERMOON_READY {"port":2}\r', token: 't')!.port,
        2,
      );
    });

    test('普通日志行返回 null（被当作日志，而不是握手成功）', () {
      expect(Sidecar.parseReady('[backend] 正在初始化', token: 't'), isNull);
      expect(Sidecar.parseReady('', token: 't'), isNull);
      expect(Sidecar.parseReady('silvermoon_ready {"port":1}', token: 't'), isNull);
      // 前缀必须带空格：Rust 侧固定这么打
      expect(Sidecar.parseReady('SILVERMOON_READY{"port":1}', token: 't'), isNull);
    });

    test('JSON 坏了或端口类型不对都返回 null，不抛异常', () {
      expect(Sidecar.parseReady('SILVERMOON_READY 这不是 JSON', token: 't'), isNull);
      expect(Sidecar.parseReady('SILVERMOON_READY {', token: 't'), isNull);
      expect(Sidecar.parseReady('SILVERMOON_READY {}', token: 't'), isNull);
      expect(Sidecar.parseReady('SILVERMOON_READY {"port":"123"}', token: 't'), isNull);
      expect(Sidecar.parseReady('SILVERMOON_READY {"port":null}', token: 't'), isNull);
      expect(Sidecar.parseReady('SILVERMOON_READY [1]', token: 't'), isNull);
    });
  });

  group('进程生命周期', () {
    test(
      '关 stdin 后端就自行退出（靠 EOF，而不是等超时强杀）',
      () async {
        final Directory tmp =
            Directory.systemTemp.createTempSync('silvermoon_sidecar_');
        addTearDown(() {
          if (tmp.existsSync()) tmp.deleteSync(recursive: true);
        });

        // 假后端：打一行就绪行，然后一直读到 stdin EOF 才退出。
        // 如果宿主没把 stdin 留着，它会立刻退出 → start() 报「启动即退出」。
        final String script = tmp.path + Platform.pathSeparator + 'fake.sh';
        File(script).writeAsStringSync(
          '#!/bin/sh\n'
          'echo \'SILVERMOON_READY {"port":45678}\'\n'
          'exec cat > /dev/null\n',
        );
        Process.runSync('chmod', <String>['755', script]);

        final Sidecar sidecar = Sidecar(
          readyTimeout: const Duration(seconds: 10),
          exitGrace: const Duration(seconds: 5),
        );
        addTearDown(() async {
          if (sidecar.isRunning) await sidecar.stop();
        });

        final SidecarEndpoint endpoint = await sidecar.start(
          executable: script,
          token: 'tok',
          environment: <String, String>{'SILVERMOON_DATA_DIR': tmp.path},
        );

        expect(endpoint.port, 45678);
        expect(sidecar.isRunning, isTrue, reason: 'stdin 还开着，进程必须活着');

        final Stopwatch watch = Stopwatch()..start();
        await sidecar.stop();
        watch.stop();

        expect(sidecar.isRunning, isFalse);
        expect(sidecar.endpoint, isNull);
        expect(
          watch.elapsed,
          lessThan(const Duration(seconds: 2)),
          reason: '应当靠 stdin EOF 瞬间退出；走到超时才退出说明 stdin 没被正确关闭',
        );
      },
      skip: Platform.isWindows ? 'Windows 上没有 /bin/sh，此用例只在 CI 的 ubuntu 上跑' : null,
    );

    test('可执行文件不存在时给出明确错误', () async {
      final Sidecar sidecar = Sidecar();
      await expectLater(
        sidecar.start(executable: '/nonexistent/silvermoon-server-xyz'),
        throwsA(
          isA<SidecarException>().having(
            (SidecarException e) => e.message,
            'message',
            contains('找不到后端可执行文件'),
          ),
        ),
      );
    });

    test('启动失败后不留状态', () async {
      final Sidecar sidecar = Sidecar();
      await expectLater(
        sidecar.start(executable: '/nonexistent/x'),
        throwsA(isA<SidecarException>()),
      );
      // 抛错后不应残留状态
      expect(sidecar.isRunning, isFalse);
    });
  });
}
