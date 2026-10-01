import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:silvermoon/bridge/backend_client.dart';
import 'package:silvermoon/bridge/bridge_server.dart';
import 'package:silvermoon/host/json_store.dart';
import 'package:silvermoon/host/sidecar.dart';

/// 中间层是「WebView 里的 Vue 播放层 ↔ Rust 后端」之间唯一的通道，它的信封形状
/// 必须与 Electron preload 完全一致（src/ipc/bridge.ts 只认 { ok, data, error }），
/// 否则播放层既有的 src/ipc/* 会误判成功与失败。
///
/// 这里对着**真 HTTP 服务端**跑：假后端 + 真中间层，不 mock 协议细节。
void main() {
  late Directory root;
  late Directory playerRoot;
  late HttpServer backend;
  late BackendClient client;
  late BridgeServer bridge;

  /// 假后端：只实现中间层会用到的那三条路由。
  Future<void> backendHandler(HttpRequest req, String body) async {
    if (req.uri.path == '/events') {
      req.response
        ..statusCode = 200
        ..headers.set(
          HttpHeaders.contentTypeHeader,
          'text/event-stream; charset=utf-8',
        );
      req.response.write(
        'data: {"event":"scan:progress","target":null,"payload":{"percent":42}}\n\n',
      );
      await req.response.flush();
      // 保持连接：SSE 的语义就是长连接，客户端断开时这个 future 自然结束
      await req.response.done.catchError((Object _) {});
      return;
    }

    final Map<String, Object?> payload =
        (jsonDecode(body) as Map<dynamic, dynamic>).cast<String, Object?>();
    if (req.uri.path == '/cmd') {
      final String cmd = (payload['cmd'] ?? '').toString();
      if (cmd == 'boom') {
        req.response
          ..statusCode = 200
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(<String, Object?>{'ok': false, 'error': '后端炸了'}));
      } else {
        req.response
          ..statusCode = 200
          ..headers.contentType = ContentType.json
          ..write(
            jsonEncode(<String, Object?>{
              'ok': true,
              'data': <String, Object?>{'cmd': cmd, 'args': payload['args']},
            }),
          );
      }
      await req.response.close();
      return;
    }
    if (req.uri.path == '/batch') {
      final List<Object?> calls =
          (payload['calls'] as List<Object?>?) ?? <Object?>[];
      final List<Map<String, Object?>> items = calls.map((Object? call) {
        final String cmd =
            call is Map ? (call['cmd'] ?? '').toString() : '';
        if (cmd == 'boom') {
          return <String, Object?>{'ok': false, 'error': '后端炸了'};
        }
        return <String, Object?>{
          'ok': true,
          'data': <String, Object?>{'cmd': cmd},
        };
      }).toList();
      req.response
        ..statusCode = 200
        ..headers.contentType = ContentType.json
        ..write(jsonEncode(<String, Object?>{'ok': true, 'data': items}));
      await req.response.close();
      return;
    }
    req.response
      ..statusCode = 404
      ..write('nope');
    await req.response.close();
  }

  setUp(() async {
    root = Directory.systemTemp.createTempSync('sm_bridge_');
    playerRoot = Directory.systemTemp.createTempSync('sm_player_');
    backend = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    backend.listen((HttpRequest req) {
      unawaited(() async {
        final String body = await utf8.decoder.bind(req).join();
        await backendHandler(req, body);
      }());
    });
    client = BackendClient(
      endpoint: SidecarEndpoint(port: backend.port, token: 'tok'),
    );
    bridge = BridgeServer(
      client: () => client,
      store: JsonStore(root.path),
      assets: DirectoryPlayerAssets(playerRoot.path),
    );
    await bridge.start();
  });

  tearDown(() async {
    await bridge.stop();
    client.close();
    await backend.close(force: true);
    if (root.existsSync()) root.deleteSync(recursive: true);
    if (playerRoot.existsSync()) playerRoot.deleteSync(recursive: true);
  });

  /// 直连中间层的原始 HTTP 客户端（用 HttpClient 而不是桥自己的抽象，
  /// 这样断言的是真正发到线上的字节）。
  Future<HttpClientResponse> send(
    String method,
    String path, {
    Object? body,
    Map<String, String> headers = const <String, String>{},
  }) async {
    final HttpClient http = HttpClient();
    final HttpClientRequest req =
        await http.openUrl(method, Uri.parse(bridge.origin + path));
    // 默认会跟随 302：断言「/ 跳转到 /player/」时会被跟到下一跳的 404 上去
    req.followRedirects = false;
    headers.forEach(req.headers.set);
    if (body != null) {
      req.headers.contentType = ContentType.json;
      req.write(jsonEncode(body));
    }
    final HttpClientResponse res = await req.close();
    // 客户端在响应读完前不能关，交给调用方读完后再由 addTearDown 收尾
    addTearDown(() => http.close(force: true));
    return res;
  }

  Future<Map<String, Object?>> postJson(
    String path,
    Map<String, Object?> body, {
    Map<String, String> headers = const <String, String>{},
  }) async {
    final HttpClientResponse res =
        await send('POST', path, body: body, headers: headers);
    final String text = await utf8.decoder.bind(res).join();
    return (jsonDecode(text) as Map<dynamic, dynamic>).cast<String, Object?>();
  }

  group('POST /bridge/invoke', () {
    test('转发到后端 /cmd，并原样回 { ok, data } 信封', () async {
      final Map<String, Object?> reply = await postJson(
        '/bridge/invoke',
        <String, Object?>{
          'cmd': 'scan_start',
          'args': <String, Object?>{
            'config': <String, Object?>{'dirs': <String>['D:/照片']},
          },
        },
      );

      expect(reply['ok'], isTrue);
      expect(reply['data'], <String, Object?>{
        'cmd': 'scan_start',
        'args': <String, Object?>{
          'config': <String, Object?>{'dirs': <String>['D:/照片']},
        },
      });
    });

    test('后端业务失败时仍是 200 + { ok:false, error }（渲染端只认信封）', () async {
      final HttpClientResponse res = await send(
        'POST',
        '/bridge/invoke',
        body: <String, Object?>{'cmd': 'boom'},
      );
      expect(res.statusCode, 200);
      final Map<String, Object?> reply =
          (jsonDecode(await utf8.decoder.bind(res).join())
                  as Map<dynamic, dynamic>)
              .cast<String, Object?>();

      expect(reply['ok'], isFalse);
      expect(reply['error'], '后端炸了');
    });

    test('缺少 cmd 时直接回业务错误，不去打扰后端', () async {
      final Map<String, Object?> reply = await postJson(
        '/bridge/invoke',
        <String, Object?>{},
      );

      expect(reply['ok'], isFalse);
      expect(reply['error'], contains('缺少 cmd'));
    });

    test('Origin 不是自身源时拒绝', () async {
      final Map<String, Object?> reply = await postJson(
        '/bridge/invoke',
        <String, Object?>{'cmd': 'scan_start'},
        headers: <String, String>{'origin': 'http://evil.local'},
      );

      expect(reply['ok'], isFalse);
      expect(reply['error'], contains('来源'));
    });

    test('后端未就绪时回可读错误而不是 500', () async {
      final BridgeServer lonely = BridgeServer(
        client: () => null,
        store: JsonStore(root.path),
        assets: DirectoryPlayerAssets(playerRoot.path),
      );
      await lonely.start();
      addTearDown(lonely.stop);

      final HttpClient http = HttpClient();
      addTearDown(() => http.close(force: true));
      final HttpClientRequest req = await http
          .postUrl(Uri.parse(lonely.origin + '/bridge/invoke'))
          ..headers.contentType = ContentType.json
          ..write(jsonEncode(<String, Object?>{'cmd': 'scan_start'}));
      final HttpClientResponse res = await req.close();
      final Map<String, Object?> reply =
          (jsonDecode(await utf8.decoder.bind(res).join())
                  as Map<dynamic, dynamic>)
              .cast<String, Object?>();

      expect(res.statusCode, 200);
      expect(reply['ok'], isFalse);
      expect(reply['error'], '后端未就绪');
    });
  });

  group('POST /bridge/invokeBatch', () {
    test('逐条独立成败，下标一一对应', () async {
      final Map<String, Object?> reply = await postJson(
        '/bridge/invokeBatch',
        <String, Object?>{
          'calls': <Map<String, Object?>>[
            <String, Object?>{'cmd': 'skin_list'},
            <String, Object?>{'cmd': 'boom'},
          ],
        },
      );

      expect(reply['ok'], isTrue);
      final List<Object?> items = reply['data']! as List<Object?>;
      expect(items.length, 2);
      expect((items[0]! as Map<Object?, Object?>)['ok'], isTrue);
      expect((items[1]! as Map<Object?, Object?>)['ok'], isFalse);
      expect(
        (items[1]! as Map<Object?, Object?>)['error'],
        '后端炸了',
        reason: '一条失败不能污染整批',
      );
    });
  });

  group('POST /bridge/call（store 通道）', () {
    test('set 之后再 get 拿得到值，且落在 settings.json 里', () async {
      final Map<String, Object?> wrote = await postJson(
        '/bridge/call',
        <String, Object?>{
          'channel': 'store',
          'payload': <String, Object?>{
            'op': 'set',
            'file': 'settings.json',
            'key': 'themeMode',
            'value': 'dark',
          },
        },
      );
      expect(wrote['ok'], isTrue);

      final Map<String, Object?> read = await postJson(
        '/bridge/call',
        <String, Object?>{
          'channel': 'store',
          'payload': <String, Object?>{
            'op': 'get',
            'file': 'settings.json',
            'key': 'themeMode',
          },
        },
      );
      expect(read['ok'], isTrue);
      expect(read['data'], 'dark');

      final Map<String, Object?> keys = await postJson(
        '/bridge/call',
        <String, Object?>{
          'channel': 'store',
          'payload': <String, Object?>{
            'op': 'keys',
            'file': 'settings.json',
          },
        },
      );
      expect(keys['data'], <String>['themeMode']);
    });

    test('store 抛错时回业务错误（不让中间层 500）', () async {
      final Map<String, Object?> reply = await postJson(
        '/bridge/call',
        <String, Object?>{
          'channel': 'store',
          'payload': <String, Object?>{
            'op': 'set',
            'file': 'settings.json',
          },
        },
      );

      expect(reply['ok'], isFalse);
      expect(reply['error'], contains('key'));
    });

    test('未实现的通道给出指名道姓的错误', () async {
      final Map<String, Object?> reply = await postJson(
        '/bridge/call',
        <String, Object?>{
          'channel': 'dragdrop',
          'payload': <String, Object?>{},
        },
      );

      expect(reply['ok'], isFalse);
      expect(reply['error'], contains('dragdrop'));
    });
  });

  group('GET /bridge/events', () {
    test('把后端 SSE 帧原样转给浏览器', () async {
      final HttpClientResponse res = await send('GET', '/bridge/events');

      expect(res.statusCode, 200);
      expect(res.headers.contentType?.mimeType, 'text/event-stream');

      final String first = await utf8.decoder
          .bind(res)
          .transform(const LineSplitter())
          .firstWhere((String line) => line.startsWith('data:'))
          .timeout(const Duration(seconds: 10));

      final Map<String, Object?> frame = (jsonDecode(first.substring(5).trim())
              as Map<dynamic, dynamic>)
          .cast<String, Object?>();
      expect(frame['event'], 'scan:progress');
      expect(frame['target'], isNull, reason: '广播帧的 target 必须是 null');
      expect(frame['payload'], <String, Object?>{'percent': 42});
    });
  });

  group('GET /a/（本地文件服务）', () {
    late String mediaPath;
    late List<int> mediaBytes;

    setUp(() {
      mediaBytes = List<int>.generate(1000, (int i) => i % 251);
      mediaPath =
          root.path.replaceAll('\\', '/') + '/一首歌.mp3';
      File(mediaPath).writeAsBytesSync(mediaBytes);
    });

    String assetUrl(String path) =>
        '/a/' + Uri.encodeComponent(path.replaceAll('\\', '/'));

    test('整体下发时带 Accept-Ranges 与正确长度', () async {
      final HttpClientResponse res = await send('GET', assetUrl(mediaPath));

      expect(res.statusCode, 200);
      expect(res.headers.value('accept-ranges'), 'bytes');
      expect(res.headers.contentLength, 1000);
      expect(res.headers.contentType?.mimeType, 'audio/mpeg');
      final List<int> got = await res
          .fold<List<int>>(<int>[], (List<int> acc, List<int> chunk) => acc..addAll(chunk));
      expect(got, mediaBytes);
    });

    test('单区间 Range 回 206、Content-Range 与对应切片', () async {
      final HttpClientResponse res = await send(
        'GET',
        assetUrl(mediaPath),
        headers: <String, String>{'range': 'bytes=10-19'},
      );

      expect(res.statusCode, 206);
      expect(res.headers.value('content-range'), 'bytes 10-19/1000');
      expect(res.headers.contentLength, 10);
      final List<int> got = await res
          .fold<List<int>>(<int>[], (List<int> acc, List<int> chunk) => acc..addAll(chunk));
      expect(got, mediaBytes.sublist(10, 20));
    });

    test('bytes=-N 取末尾 N 字节', () async {
      final HttpClientResponse res = await send(
        'GET',
        assetUrl(mediaPath),
        headers: <String, String>{'range': 'bytes=-5'},
      );

      expect(res.statusCode, 206);
      expect(res.headers.value('content-range'), 'bytes 995-999/1000');
      final List<int> got = await res
          .fold<List<int>>(<int>[], (List<int> acc, List<int> chunk) => acc..addAll(chunk));
      expect(got, mediaBytes.sublist(995));
    });

    test('越界 Range 回 416 与总长度', () async {
      final HttpClientResponse res = await send(
        'GET',
        assetUrl(mediaPath),
        headers: <String, String>{'range': 'bytes=5000-6000'},
      );

      expect(res.statusCode, 416);
      expect(res.headers.value('content-range'), 'bytes */1000');
      await res.drain<void>();
    });

    test('多区间（暂不支持）也按 416 处理，而不是回错内容', () async {
      final HttpClientResponse res = await send(
        'GET',
        assetUrl(mediaPath),
        headers: <String, String>{'range': 'bytes=0-1,5-6'},
      );

      expect(res.statusCode, 416);
      await res.drain<void>();
    });

    test('文件不存在回 404', () async {
      final HttpClientResponse res = await send(
        'GET',
        assetUrl(root.path + '/没有这个文件.mp3'),
      );

      expect(res.statusCode, 404);
      await res.drain<void>();
    });

    test('路径指向目录时回 404（不能把目录当文件下发）', () async {
      final HttpClientResponse res =
          await send('GET', assetUrl(root.path));

      expect(res.statusCode, 404);
      await res.drain<void>();
    });
  });

  group('GET /player/*（播放层产物）', () {
    setUp(() {
      File(
        playerRoot.path + Platform.pathSeparator + 'index.html',
      ).writeAsStringSync('<html>player</html>');
      Directory(playerRoot.path + Platform.pathSeparator + 'assets')
          .createSync(recursive: true);
      File(
        playerRoot.path +
            Platform.pathSeparator +
            'assets' +
            Platform.pathSeparator +
            'app.js',
      ).writeAsStringSync('console.log(1)');
    });

    test('/player/ 回 index.html', () async {
      final HttpClientResponse res = await send('GET', '/player/');

      expect(res.statusCode, 200);
      expect(res.headers.contentType?.mimeType, 'text/html');
      expect(await utf8.decoder.bind(res).join(), '<html>player</html>');
    });

    test('子目录里的 js 用正确的 MIME 类型', () async {
      final HttpClientResponse res = await send('GET', '/player/assets/app.js');

      expect(res.statusCode, 200);
      expect(res.headers.contentType?.mimeType, 'application/javascript');
      await res.drain<void>();
    });

    test('编码过的目录穿越被挡住', () async {
      File(root.parent.path + Platform.pathSeparator + 'secret.txt')
          .writeAsStringSync('secret');
      final HttpClientResponse res =
          await send('GET', '/player/%2e%2e%2fsecret.txt');

      expect(res.statusCode, 404, reason: '产物只能落在 assets/player 目录内');
      await res.drain<void>();
    });

    test('/shim.js 由产物目录提供（垫片与产物同源）', () async {
      File(playerRoot.path + Platform.pathSeparator + 'shim.js')
          .writeAsStringSync('window.__SILVERMOON__ = {};');
      final HttpClientResponse res = await send('GET', '/shim.js');

      expect(res.statusCode, 200);
      expect(
        res.headers.contentType?.mimeType,
        'application/javascript',
      );
      await res.drain<void>();
    });
  });

  group('其它', () {
    test('/ 跳到 /player/', () async {
      final HttpClientResponse res = await send('GET', '/');

      expect(res.statusCode, 302);
      expect(res.headers.value('location'), '/player/');
      await res.drain<void>();
    });

    test('未知路径回 404', () async {
      final HttpClientResponse res = await send('GET', '/nope');

      expect(res.statusCode, 404);
      await res.drain<void>();
    });

    test('只绑回环地址，端口是随机分配的', () async {
      expect(bridge.origin, startsWith('http://127.0.0.1:'));
      expect(bridge.port, greaterThan(0));
      expect(bridge.assetBase, bridge.origin + '/a/');
      expect(bridge.playerUrl, bridge.origin + '/player/');
    });
  });
}
