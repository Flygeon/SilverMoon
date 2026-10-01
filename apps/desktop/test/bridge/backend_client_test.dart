import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:silvermoon/bridge/backend_client.dart';
import 'package:silvermoon/host/sidecar.dart';

/// 这里对着**真 HTTP 服务端**跑，而不是 mock：信封形状、状态码与 ok 字段的关系、
/// SSE 分帧规则全部照 `crates/silvermoon-ipc/src/server.rs` 复刻。
void main() {
  /// 起一个只服务一个测试的假后端，返回指向它的客户端。
  Future<BackendClient> serve(
    Future<void> Function(HttpRequest req, String body) handler, {
    void Function(HttpRequest req, String body)? onSeen,
  }) async {
    final HttpServer server =
        await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((HttpRequest req) {
      unawaited(() async {
        final String body = await utf8.decoder.bind(req).join();
        onSeen?.call(req, body);
        await handler(req, body);
      }());
    });
    addTearDown(() async {
      await server.close(force: true);
    });

    final BackendClient client = BackendClient(
      endpoint: SidecarEndpoint(port: server.port, token: 'tok'),
    );
    addTearDown(client.close);
    return client;
  }

  void writeJson(HttpRequest req, int status, Object? payload) {
    req.response
      ..statusCode = status
      ..headers.contentType = ContentType.json
      ..write(jsonEncode(payload));
  }

  group('invoke（POST /cmd）', () {
    test('发到 /cmd，带令牌头，参数键是后端约定的 camelCase', () async {
      String? seenPath;
      String? seenToken;
      Map<String, Object?>? seenBody;
      final BackendClient client = await serve(
        (HttpRequest req, String body) async {
          writeJson(
            req,
            200,
            <String, Object?>{
              'ok': true,
              'data': <String, Object?>{'jobId': 'scan-1'},
            },
          );
          await req.response.close();
        },
        onSeen: (HttpRequest req, String body) {
          seenPath = req.uri.path;
          seenToken = req.headers.value('x-silvermoon-token');
          seenBody = (jsonDecode(body) as Map<dynamic, dynamic>)
              .cast<String, Object?>();
        },
      );

      final BackendReply reply = await client.invoke(
        'scan_start',
        <String, Object?>{
          'config': <String, Object?>{
            'dirs': <String>['D:/照片'],
            'followLinks': false,
          },
        },
      );

      expect(seenPath, '/cmd');
      expect(seenToken, 'tok');
      expect(seenBody, <String, Object?>{
        'cmd': 'scan_start',
        'args': <String, Object?>{
          'config': <String, Object?>{
            'dirs': <String>['D:/照片'],
            'followLinks': false,
          },
        },
      });
      expect(reply.ok, isTrue);
      expect(reply.data, <String, Object?>{'jobId': 'scan-1'});
    });

    test('ok:false 时 unwrap 抛出后端原始字符串（前缀判断依赖这一点）', () async {
      final BackendClient client = await serve(
        (HttpRequest req, String body) async {
          writeJson(
            req,
            200,
            <String, Object?>{
              'ok': false,
              'error': '[WENKU8_LOGIN_CANCELLED] 用户取消登录',
            },
          );
          await req.response.close();
        },
      );

      final BackendReply reply = await client.invoke('wenku8_login_submit');

      expect(reply.ok, isFalse);
      expect(reply.error, '[WENKU8_LOGIN_CANCELLED] 用户取消登录');
      expect(
        () => reply.unwrap(),
        throwsA(
          isA<BackendError>().having(
            (BackendError e) => e.toString(),
            'toString()',
            '[WENKU8_LOGIN_CANCELLED] 用户取消登录',
          ),
        ),
      );
    });

    test('HTTP 404 也按信封解析：判 ok 字段而不是状态码', () async {
      final BackendClient client = await serve(
        (HttpRequest req, String body) async {
          writeJson(
            req,
            404,
            <String, Object?>{'ok': false, 'error': '未知命令 `nope`'},
          );
          await req.response.close();
        },
      );

      final BackendReply reply = await client.invoke('nope');

      expect(reply.ok, isFalse);
      expect(reply.statusCode, 404);
      expect(reply.error, '未知命令 `nope`');
    });

    test('401 令牌无效同样走信封', () async {
      final BackendClient client = await serve(
        (HttpRequest req, String body) async {
          writeJson(req, 401, <String, Object?>{'ok': false, 'error': '令牌无效'});
          await req.response.close();
        },
      );

      final BackendReply reply = await client.invoke('list_files');

      expect(reply.ok, isFalse);
      expect(reply.statusCode, 401);
      expect(reply.error, '令牌无效');
    });

    test('空响应给出可读错误而不是崩', () async {
      final BackendClient client = await serve(
        (HttpRequest req, String body) async {
          req.response.statusCode = 200;
          await req.response.close();
        },
      );

      final BackendReply reply = await client.invoke('list_files');

      expect(reply.ok, isFalse);
      expect(reply.error, contains('空响应'));
    });

    test('非 JSON 响应给出可读错误', () async {
      final BackendClient client = await serve(
        (HttpRequest req, String body) async {
          req.response
            ..statusCode = 200
            ..write('<html>代理返回了网页</html>');
          await req.response.close();
        },
      );

      final BackendReply reply = await client.invoke('list_files');

      expect(reply.ok, isFalse);
      expect(reply.error, contains('不是 JSON'));
    });

    test('连不上后端时返回可读错误，不往上抛异常', () async {
      // 先占一个端口再放掉，保证这个端口此刻没人监听
      final HttpServer probe =
          await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final int port = probe.port;
      await probe.close(force: true);

      final BackendClient client = BackendClient(
        endpoint: SidecarEndpoint(port: port, token: 'tok'),
        timeout: const Duration(seconds: 5),
      );
      addTearDown(client.close);

      final BackendReply reply = await client.invoke('list_files');

      expect(reply.ok, isFalse);
      expect(reply.error, startsWith('与后端通信失败：'));
    });
  });

  group('batch（POST /batch）', () {
    test('逐条独立成败，且与入参下标一一对应', () async {
      final BackendClient client = await serve(
        (HttpRequest req, String body) async {
          writeJson(
            req,
            200,
            <String, Object?>{
              'ok': true,
              'data': <Object?>[
                <String, Object?>{'ok': true, 'data': 'a'},
                <String, Object?>{'ok': false, 'error': 'boom'},
                <String, Object?>{'ok': true, 'data': 'c'},
              ],
            },
          );
          await req.response.close();
        },
      );

      final List<BackendReply> replies =
          await client.batch(<Map<String, Object?>>[
        <String, Object?>{'cmd': 'x'},
        <String, Object?>{'cmd': 'y'},
        <String, Object?>{'cmd': 'z'},
      ]);

      expect(replies.length, 3);
      expect(replies[0].ok, isTrue);
      expect(replies[0].data, 'a');
      expect(replies[1].ok, isFalse);
      expect(replies[1].error, 'boom');
      expect(replies[2].ok, isTrue);
      expect(replies[2].data, 'c');
    });

    test('整通道失败（超上限）时每条都拿到同一个错误', () async {
      final BackendClient client = await serve(
        (HttpRequest req, String body) async {
          writeJson(
            req,
            400,
            <String, Object?>{'ok': false, 'error': '批量调用超过上限 256'},
          );
          await req.response.close();
        },
      );

      final List<BackendReply> replies =
          await client.batch(<Map<String, Object?>>[
        <String, Object?>{'cmd': 'a'},
        <String, Object?>{'cmd': 'b'},
      ]);

      expect(replies.length, 2);
      for (final BackendReply reply in replies) {
        expect(reply.ok, isFalse);
        expect(reply.error, '批量调用超过上限 256');
        expect(reply.statusCode, 400);
      }
    });
  });

  group('health（GET /health）', () {
    test('只看状态码，失败不抛', () async {
      bool healthy = true;
      final BackendClient client = await serve(
        (HttpRequest req, String body) async {
          req.response.statusCode = healthy ? 200 : 500;
          req.response.write(healthy ? '{"ok":true}' : 'oops');
          await req.response.close();
        },
      );

      expect(await client.health(), isTrue);
      healthy = false;
      expect(await client.health(), isFalse);
    });
  });

  group('events（GET /events，SSE）', () {
    /// 按 SSE 的方式把帧推给客户端。
    ///
    /// 两处都是真踩到的坑：
    ///   1. 不写 charset 时 HttpResponse 按 latin1 编码，写中文直接抛
    ///      Invalid argument (string): Contains invalid characters；
    ///   2. 只 flush 不关闭响应时，本环境（Dart 的 HttpServer）里客户端读不到帧，
    ///      用例只能以 30 秒超时告终。真实后端是 axum 的长连接，与宿主无关，
    ///      所以这里先 flush 走一遍逐帧推送，再延迟关闭兜底，保证一定读得到。
    Future<void> pushFrames(HttpRequest req, List<String> chunks) async {
      try {
        req.response
          ..statusCode = 200
          ..headers.contentType =
              ContentType('text', 'event-stream', charset: 'utf-8');
        for (final String chunk in chunks) {
          req.response.write(chunk);
        }
        await req.response.flush();
        await Future<void>.delayed(const Duration(milliseconds: 200));
        await req.response.close();
      } catch (_) {
        // 客户端读完想要的帧后就取消订阅，此时 close 会抛，忽略即可
      }
    }

    test('解析 data 帧并忽略 keep-alive 注释', () async {
      final BackendClient client = await serve(
        (HttpRequest req, String body) => pushFrames(req, <String>[
          // 后端用了 KeepAlive::default()，会插入以冒号开头的注释行
          ': keep-alive\n\n',
          'data: ' +
              jsonEncode(<String, Object?>{
                'event': 'scan:progress',
                'target': null,
                'payload': <String, Object?>{'percent': 1.0},
              }) +
              '\n\n',
          'data: ' +
              jsonEncode(<String, Object?>{
                'event': 'app:player-command',
                'target': 'main',
                'payload': 'toggle',
              }) +
              '\n\n',
        ]),
      );

      final List<Map<String, Object?>> frames = await client
          .events(retryDelay: const Duration(milliseconds: 50))
          .take(2)
          .toList();

      expect(frames.length, 2);
      expect(frames[0]['event'], 'scan:progress');
      expect(frames[0]['target'], isNull);
      expect(frames[0]['payload'], <String, Object?>{'percent': 1.0});
      expect(frames[1]['event'], 'app:player-command');
      expect(frames[1]['target'], 'main');
      expect(frames[1]['payload'], 'toggle');
    });

    test('同一帧的多行 data 按 SSE 规范用换行拼接', () async {
      final BackendClient client = await serve(
        (HttpRequest req, String body) => pushFrames(req, <String>[
          'data: {"event":"scan:progress",\n',
          'data: "target":null,"payload":7}\n\n',
        ]),
      );

      final List<Map<String, Object?>> frames = await client
          .events(retryDelay: const Duration(milliseconds: 50))
          .take(1)
          .toList();

      expect(frames.single['event'], 'scan:progress');
      expect(frames.single['payload'], 7);
    });

    test('非 JSON 帧被丢弃，不影响后续正常帧', () async {
      final BackendClient client = await serve(
        (HttpRequest req, String body) => pushFrames(req, <String>[
          'data: 这不是 JSON\n\n',
          'data: ' +
              jsonEncode(<String, Object?>{
                'event': 'smtc:command',
                'target': null,
                'payload': null,
              }) +
              '\n\n',
        ]),
      );

      final List<Map<String, Object?>> frames = await client
          .events(retryDelay: const Duration(milliseconds: 50))
          .take(1)
          .toList();

      expect(frames.length, 1);
      expect(frames.single['event'], 'smtc:command');
    });
  });
}
