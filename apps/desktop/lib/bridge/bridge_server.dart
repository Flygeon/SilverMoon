import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'dart:ui' show Offset, Size;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/services.dart' show ByteData, rootBundle;
import 'package:url_launcher/url_launcher.dart';
import 'package:window_manager/window_manager.dart';

import '../host/json_store.dart';
import 'backend_client.dart';

/// 播放层静态产物的读取入口。
///
/// 应用里读打包进资产的 assets/player/；测试与本地调试可以直接指向磁盘目录，
/// 这样中间层的路由与范围请求逻辑不必依赖 Flutter 资产束就能测。
abstract class PlayerAssets {
  /// 读取相对路径对应的文件内容；不存在返回 null。
  Future<Uint8List?> load(String path);
}

/// 从 Flutter 资产束读取（生产路径）。
class BundlePlayerAssets implements PlayerAssets {
  const BundlePlayerAssets({this.assetDir = 'assets/player'});

  final String assetDir;

  @override
  Future<Uint8List?> load(String path) async {
    try {
      final ByteData data = await rootBundle.load(assetDir + '/' + path);
      return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    } catch (_) {
      return null;
    }
  }
}

/// 从磁盘目录读取（测试 / 本地调试）。
class DirectoryPlayerAssets implements PlayerAssets {
  DirectoryPlayerAssets(this.root);

  final String root;

  @override
  Future<Uint8List?> load(String path) async {
    final String? full = _resolve(path);
    if (full == null) return null;
    final File file = File(full);
    try {
      if (!await file.exists()) return null;
      return await file.readAsBytes();
    } catch (_) {
      return null;
    }
  }

  /// 把播放层里的相对路径落到 root 下，并挡住目录穿越。
  String? _resolve(String path) {
    final String sep = Platform.pathSeparator;
    final String normalized = path.replaceAll('\\', '/').replaceAll('/', sep);
    for (final String segment in normalized.split(sep)) {
      if (segment == '..') return null;
    }
    final String basePath = File(root).absolute.path;
    final String full = File(basePath + sep + normalized).absolute.path;
    final String prefix = basePath.endsWith(sep) ? basePath : basePath + sep;
    if (!full.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    return full;
  }
}

/// 一段已解析的单区间范围。
class _ByteRange {
  const _ByteRange(this.start, this.end);

  /// 起始字节（含）
  final int start;

  /// 结束字节（含）
  final int end;

  int get length => end - start + 1;
}

/// 供 WebView 里 Vue 播放层使用的 loopback 中间层。
///
/// 对应 Electron 版的 preload + 主进程 dispatcher + asset:// 协议处理器三块能力：
///   * POST /bridge/invoke      → 后端 POST /cmd
///   * POST /bridge/invokeBatch → 后端 POST /batch
///   * POST /bridge/call        → 通用能力通道（store / opener / dialog …）
///   * POST /bridge/emit        → 跨窗口事件（当前只有一个窗口，先广播给所有订阅者）
///   * GET  /bridge/events      → 后端 SSE 转 SSE
///   * GET  /a/<编码后的绝对路径> → 本地文件服务，支持单区间 Range（拖动进度必需）
///   * GET  /player/*           → 播放层静态产物
///   * GET  /shim.js            → 注入 window.__SILVERMOON__ 的垫片
///
/// 只绑 127.0.0.1 随机端口；/bridge/* 校验 Origin 必须等于自身源。
class BridgeServer {
  BridgeServer({
    required BackendClient? Function() client,
    JsonStore? store,
    PlayerAssets? assets,
    this.label = 'main',
  })  : _client = client,
        _store = store,
        _assets = assets ?? const BundlePlayerAssets();

  final BackendClient? Function() _client;
  final JsonStore? _store;
  final PlayerAssets _assets;

  /// 当前窗口 label，随事件帧回给播放层做 target 过滤。
  final String label;

  HttpServer? _server;
  HttpClient? _http;

  int get port {
    final HttpServer? server = _server;
    if (server == null) throw StateError('中间层未启动');
    return server.port;
  }

  /// 播放层所在的源，也是 Origin 校验的基准。
  String get origin => 'http://127.0.0.1:' + port.toString();

  /// 本地文件 URL 前缀，注入给播放层的 window.__SILVERMOON__.assetBase。
  String get assetBase => origin + '/a/';

  String get playerUrl => origin + '/player/';

  String get shimUrl => origin + '/shim.js';

  /// 启动服务，返回实际端口（0 表示随机端口）。
  Future<int> start({int port = 0}) async {
    final HttpServer server =
        await HttpServer.bind(InternetAddress.loopbackIPv4, port);
    // 范围请求与 SSE 都不该被压缩：压缩会丢掉 Content-Length 与分帧边界。
    server.autoCompress = false;
    _server = server;
    unawaited(_serve(server));
    return server.port;
  }

  Future<void> stop() async {
    final HttpServer? server = _server;
    _server = null;
    await server?.close(force: true);
    _http?.close(force: true);
    _http = null;
  }

  /// 每个请求都**不能**在循环里 await：SSE 是长连接，await 它会把整个服务
  /// 卡在一条连接上，后续所有 invoke 都再也进不来（表现为播放层「全部请求超时」）。
  Future<void> _serve(HttpServer server) async {
    await for (final HttpRequest request in server) {
      unawaited(_handleSafely(request));
    }
  }

  Future<void> _handleSafely(HttpRequest request) async {
    try {
      await _route(request);
    } catch (error) {
      await _fail(request, HttpStatus.internalServerError, error.toString());
    }
  }

  Future<void> _route(HttpRequest request) async {
    final String path = request.uri.path;

    if (path == '/bridge/invoke') return _invoke(request);
    if (path == '/bridge/invokeBatch') return _invokeBatch(request);
    if (path == '/bridge/call') return _call(request);
    if (path == '/bridge/emit') return _emit(request);
    if (path == '/bridge/events') return _events(request);
    if (path == '/shim.js') return _playerFile(request, 'shim.js');
    if (path == '/player' || path == '/player/') {
      // 构建产物入口叫 player.html（vite 单入口配置决定），index.html 作为兜底：
      // 将来换入口文件名时，宿主这一侧不用跟着改。
      for (final String entry in <String>['index.html', 'player.html']) {
        final Uint8List? bytes = await _assets.load(entry);
        if (bytes != null) return _serveBytes(request, bytes, entry);
      }
      return _fail(
        request,
        HttpStatus.notFound,
        '播放层产物缺失：index.html / player.html',
      );
    }
    if (path.startsWith('/player/')) {
      return _playerFile(request, path.substring('/player/'.length));
    }
    if (path.startsWith('/a/')) return _asset(request);
    if (path == '/' || path.isEmpty) {
      request.response.statusCode = HttpStatus.found;
      request.response.headers.set(HttpHeaders.locationHeader, '/player/');
      await request.response.close();
      return;
    }
    return _fail(request, HttpStatus.notFound, '未知路径 ' + path);
  }

  /// /bridge/* 的来源校验：允许无 Origin 的本机调用，有 Origin 就必须是自己。
  bool _originAllowed(HttpRequest request) {
    final String? header = request.headers.value('origin');
    if (header == null) return true;
    return header == origin;
  }

  Future<Map<String, Object?>> _body(HttpRequest request) async {
    final String text = await utf8.decoder.bind(request).join();
    if (text.trim().isEmpty) return <String, Object?>{};
    final Object? decoded = jsonDecode(text);
    if (decoded is! Map) throw const FormatException('请求体必须是 JSON 对象');
    return Map<String, Object?>.from(decoded);
  }

  Future<void> _invoke(HttpRequest request) async {
    if (request.method != 'POST') return _methodNotAllowed(request);
    if (!_originAllowed(request)) return _bridgeError(request, '来源不被允许');
    final Map<String, Object?> payload = await _body(request);
    final Object? cmd = payload['cmd'];
    if (cmd is! String || cmd.isEmpty) return _bridgeError(request, '缺少 cmd');

    final BackendClient? client = _client();
    if (client == null) return _bridgeError(request, '后端未就绪');

    final Object? rawArgs = payload['args'];
    final Map<String, Object?> args = rawArgs is Map
        ? Map<String, Object?>.from(rawArgs)
        : <String, Object?>{};
    final BackendReply reply = await client.invoke(cmd, args);
    return _envelope(request, reply);
  }

  Future<void> _invokeBatch(HttpRequest request) async {
    if (request.method != 'POST') return _methodNotAllowed(request);
    if (!_originAllowed(request)) return _bridgeError(request, '来源不被允许');
    final Map<String, Object?> payload = await _body(request);
    final Object? rawCalls = payload['calls'];
    if (rawCalls is! List) return _bridgeError(request, '缺少 calls');

    final BackendClient? client = _client();
    if (client == null) return _bridgeError(request, '后端未就绪');

    final List<Map<String, Object?>> calls = rawCalls
        .whereType<Map<Object?, Object?>>()
        .map((Map<Object?, Object?> call) => Map<String, Object?>.from(call))
        .toList();
    final List<BackendReply> replies = await client.batch(calls);
    final List<Map<String, Object?>> items =
        replies.map((BackendReply reply) => _replyJson(reply)).toList();
    return _writeJson(request, <String, Object?>{'ok': true, 'data': items});
  }

  Map<String, Object?> _replyJson(BackendReply reply) {
    return <String, Object?>{
      'ok': reply.ok,
      if (reply.data != null) 'data': reply.data,
      if (reply.error != null) 'error': reply.error,
    };
  }

  Future<void> _envelope(HttpRequest request, BackendReply reply) {
    return _writeJson(request, _replyJson(reply));
  }

  /// 通用能力通道。当前实现 store（设置 / 播放器状态落盘）与 opener；
  /// 其余通道明确回错误，避免静默失败难排查。
  Future<void> _call(HttpRequest request) async {
    if (request.method != 'POST') return _methodNotAllowed(request);
    if (!_originAllowed(request)) return _bridgeError(request, '来源不被允许');
    final Map<String, Object?> payload = await _body(request);
    final Object? channel = payload['channel'];
    if (channel is! String || channel.isEmpty) {
      return _bridgeError(request, '缺少 channel');
    }
    final Object? inner = payload['payload'];
    final Map<String, Object?> args =
        inner is Map ? Map<String, Object?>.from(inner) : <String, Object?>{};

    // 通道清单不是猜的：来自播放闭包（MusicView / PlayerView / MiniPlayer 及其
    // stores、capabilities）里实际出现的 callBridge 调用点。
    switch (channel) {
      case 'store':
        final JsonStore? store = _store;
        if (store == null) return _bridgeError(request, '存储通道未就绪');
        return _writeResult(request, () async => _storeCall(args, store));
      case 'fs':
        return _writeResult(request, () => _fsCall(args));
      case 'http':
        return _writeResult(request, () => _httpCall(args));
      case 'dialog':
        return _writeResult(request, () => _dialogCall(args));
      case 'opener':
        return _writeResult(request, () => _openerCall(args));
      case 'window':
        return _writeResult(request, () => _windowCall(args));
      default:
        return _bridgeError(
          request,
          '通道 ' + channel + ' 尚未在 Flutter 宿主里实现（播放层用到时必须补）',
        );
    }
  }

  /// 把通道实现的返回值 / 异常统一包成 { ok, data } 与 { ok:false, error }。
  Future<void> _writeResult(
    HttpRequest request,
    Future<Object?> Function() run,
  ) async {
    try {
      final Object? data = await run();
      return _writeJson(request, <String, Object?>{'ok': true, 'data': data});
    } catch (error) {
      return _bridgeError(request, error.toString());
    }
  }

  /// store 通道：语义完全照 [JsonStore.handle]，只补 Electron 侧还有、
  /// handle 里没有的几个生命周期 op（save / close / reload / reset / path）。
  Object? _storeCall(Map<String, Object?> args, JsonStore store) {
    final String op = (args['op'] ?? '').toString();
    final String file = (args['file'] ?? 'store.json').toString();
    switch (op) {
      case 'save':
        store.save(file);
        return null;
      case 'close':
        store.flushAll();
        return null;
      case 'reload':
        store.reload(file);
        return null;
      case 'reset':
        return store.handle(<String, Object?>{'op': 'clear', 'file': file});
      case 'path':
        return store.pathOf(file);
      default:
        return store.handle(args);
    }
  }

  /// dialog 通道。open / save 走系统对话框；message / confirm / ask 需要窗口内 UI，
  /// 宿主暂未提供——这里明确报错，绝不能让调用方拿到一个假的「取消」。
  Future<Object?> _dialogCall(Map<String, Object?> args) async {
    final String op = (args['op'] ?? '').toString();
    final Object? rawOptions = args['options'];
    final Map<String, Object?> options = rawOptions is Map
        ? Map<String, Object?>.from(rawOptions)
        : <String, Object?>{};
    final List<XTypeGroup> groups = _typeGroups(options['filters']);

    switch (op) {
      case 'open':
        if (options['directory'] == true) {
          return getDirectoryPath();
        }
        if (options['multiple'] == true) {
          final List<XFile> files = await openFiles(acceptedTypeGroups: groups);
          if (files.isEmpty) return null;
          return files.map((XFile file) => file.path).toList();
        }
        final XFile? file = await openFile(acceptedTypeGroups: groups);
        return file?.path;
      case 'save':
        final FileSaveLocation? location = await getSaveLocation(
          suggestedName: options['defaultPath']?.toString(),
          acceptedTypeGroups: groups,
        );
        return location?.path;
      default:
        throw StateError('对话框 op=' + op + ' 尚未在 Flutter 宿主里接入（需要窗口内 UI）');
    }
  }

  /// Electron 的 filters 是 [{ name, extensions:[mp3] }]，转换时要去掉前导点。
  static List<XTypeGroup> _typeGroups(Object? filters) {
    if (filters is! List) return <XTypeGroup>[];
    final List<XTypeGroup> groups = <XTypeGroup>[];
    for (final Object? raw in filters) {
      if (raw is! Map) continue;
      final List<String> extensions = <String>[];
      final Object? list = raw['extensions'];
      if (list is List) {
        for (final Object? item in list) {
          final String value = item.toString().replaceFirst('.', '');
          if (value.isNotEmpty && value != '*') extensions.add(value);
        }
      }
      groups.add(
        XTypeGroup(
          label: raw['name']?.toString() ?? '文件',
          extensions: extensions.isEmpty ? null : extensions,
        ),
      );
    }
    return groups;
  }

  /// fs 通道。
  ///
  /// 二进制走 Base64 变体：渲染端的 fs.readFile 在失败时会自动回退到
  /// readFileBase64（src/ipc/fs.ts 就是这样写的），而 JSON 通道传不了裸字节，
  /// 所以裸二进制 op 故意报错，让上游走回退分支。
  Future<Object?> _fsCall(Map<String, Object?> args) async {
    final String op = (args['op'] ?? '').toString();
    final String path = (args['path'] ?? '').toString();
    switch (op) {
      case 'readFileBase64':
        return base64Encode(await File(path).readAsBytes());
      case 'writeFileBase64':
        await File(path).writeAsBytes(
          base64Decode((args['data'] ?? '').toString()),
        );
        return null;
      case 'readFile':
      case 'writeFile':
        throw StateError(op + ' 请走 Base64 变体（JSON 通道传不了裸字节）');
      case 'readTextFile':
        return File(path).readAsString();
      case 'writeTextFile':
        await File(path).writeAsString((args['contents'] ?? '').toString());
        return null;
      case 'exists':
        return FileSystemEntity.typeSync(path) !=
            FileSystemEntityType.notFound;
      case 'mkdir':
        await Directory(path).create(recursive: args['recursive'] == true);
        return null;
      case 'remove':
        final FileSystemEntityType type = FileSystemEntity.typeSync(path);
        if (type == FileSystemEntityType.directory) {
          await Directory(path).delete(recursive: args['recursive'] == true);
        } else if (type != FileSystemEntityType.notFound) {
          await File(path).delete();
        }
        return null;
      case 'copyFile':
        await File(path).copy((args['to'] ?? '').toString());
        return null;
      case 'rename':
        await File(path).rename((args['to'] ?? '').toString());
        return null;
      case 'stat':
        final FileStat stat = await FileStat.stat(path);
        return <String, Object?>{
          'isFile': stat.type == FileSystemEntityType.file,
          'isDirectory': stat.type == FileSystemEntityType.directory,
          'size': stat.size,
          'mtime': stat.type == FileSystemEntityType.notFound
              ? null
              : stat.modified.millisecondsSinceEpoch,
        };
      case 'readDir':
        final List<Map<String, Object?>> entries = <Map<String, Object?>>[];
        await for (final FileSystemEntity entity in Directory(path).list()) {
          entries.add(<String, Object?>{
            'name': entity.path.split(Platform.pathSeparator).last,
            'isFile': entity is File,
            'isDirectory': entity is Directory,
          });
        }
        return entries;
      default:
        throw StateError('fs 通道未实现 op=' + op);
    }
  }

  /// http 通道：由宿主发起请求以绕开浏览器 CORS（播放层拿第三方封面 / 歌词必需）。
  ///
  /// 响应体按**字节数组**回给渲染端：src/ipc/bridge.ts 的 toBytes 支持数字数组，
  /// 传字符串会被当 UTF-8 编码，二进制（图片）就会坏掉。
  Future<Object?> _httpCall(Map<String, Object?> args) async {
    final String url = (args['url'] ?? '').toString();
    if (url.isEmpty) throw StateError('http 通道缺少 url');
    final String method = (args['method'] ?? 'GET').toString().toUpperCase();
    final HttpClient client = _http ??= (HttpClient()
      ..connectionTimeout = const Duration(seconds: 10));

    final HttpClientRequest request = await client.openUrl(
      method,
      Uri.parse(url),
    );
    final Object? headers = args['headers'];
    if (headers is List) {
      for (final Object? item in headers) {
        if (item is List && item.length >= 2) {
          request.headers.set(item[0].toString(), item[1].toString());
        }
      }
    }
    final Object? body = args['body'];
    if (body is String && body.isNotEmpty) request.add(utf8.encode(body));

    final HttpClientResponse response = await request.close();
    final List<int> bytes = await response.fold<List<int>>(
      <int>[],
      (List<int> acc, List<int> chunk) => acc..addAll(chunk),
    );
    final List<List<String>> outHeaders = <List<String>>[];
    response.headers.forEach((String name, List<String> values) {
      for (final String value in values) {
        outHeaders.add(<String>[name, value]);
      }
    });
    return <String, Object?>{
      'status': response.statusCode,
      'statusText': response.reasonPhrase,
      'url': url,
      'headers': outHeaders,
      'body': bytes,
    };
  }

  /// opener 通道（openPath / openUrl / reveal）。
  Future<Object?> _openerCall(Map<String, Object?> args) async {
    final String op = (args['op'] ?? '').toString();
    final String target = (args['path'] ?? args['url'] ?? '').toString();
    if (target.isEmpty) throw StateError('opener 缺少 path/url');
    if (op == 'reveal') {
      // 资源管理器定位到该文件（Electron 的 reveal 同义）
      await Process.start('explorer', <String>['/select,', target]);
      return true;
    }
    final Uri uri = op == 'openUrl' ? Uri.parse(target) : Uri.file(target);
    return launchUrl(uri);
  }

  /// window 通道。单窗口下，播放层里的窗口操作直接作用到宿主窗口
  /// （useWindowDrag 会调 outerPosition / setPosition 来拖动窗口）。
  Future<Object?> _windowCall(Map<String, Object?> args) async {
    final String op = (args['op'] ?? '').toString();
    switch (op) {
      case 'isMaximized':
        return windowManager.isMaximized();
      case 'isVisible':
        return windowManager.isVisible();
      case 'minimize':
        await windowManager.minimize();
        return null;
      case 'toggleMaximize':
        if (await windowManager.isMaximized()) {
          await windowManager.unmaximize();
        } else {
          await windowManager.maximize();
        }
        return null;
      case 'close':
      case 'destroy':
        await windowManager.close();
        return null;
      case 'hide':
        await windowManager.hide();
        return null;
      case 'show':
        await windowManager.show();
        return null;
      case 'setFocus':
        await windowManager.focus();
        return null;
      case 'setTitle':
        await windowManager.setTitle((args['title'] ?? '').toString());
        return null;
      case 'setAlwaysOnTop':
        await windowManager.setAlwaysOnTop(args['alwaysOnTop'] == true);
        return null;
      case 'setIgnoreCursorEvents':
        await windowManager.setIgnoreMouseEvents(args['ignore'] == true);
        return null;
      case 'outerPosition':
        final Offset position = await windowManager.getPosition();
        return <String, Object?>{'x': position.dx, 'y': position.dy};
      case 'outerSize':
        final Size size = await windowManager.getSize();
        return <String, Object?>{'width': size.width, 'height': size.height};
      case 'setPosition':
        final Object? position = args['position'];
        if (position is Map) {
          await windowManager.setPosition(
            Offset(_toDouble(position['x']), _toDouble(position['y'])),
          );
        }
        return null;
      case 'setSize':
        final Object? size = args['size'];
        if (size is Map) {
          await windowManager.setSize(
            Size(_toDouble(size['width']), _toDouble(size['height'])),
          );
        }
        return null;
      default:
        throw StateError(
          '窗口 op=' + op + ' 尚未实现（多窗口相关：create / watchClose / preventClose）',
        );
    }
  }

  static double _toDouble(Object? value) {
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value) ?? 0;
    return 0;
  }

  /// 跨窗口事件。当前只有一个 WebView，先接受再广播给所有 SSE 订阅者。
  Future<void> _emit(HttpRequest request) async {
    if (request.method != 'POST') return _methodNotAllowed(request);
    if (!_originAllowed(request)) return _bridgeError(request, '来源不被允许');
    final Map<String, Object?> payload = await _body(request);
    _broadcast(<String, Object?>{
      'event': payload['event'],
      'target': payload['label'] ?? payload['target'],
      'payload': payload['payload'],
    });
    return _writeJson(request, <String, Object?>{'ok': true, 'data': null});
  }

  /// 广播一个宿主事件给所有已连接的页面（播放层监听 silvermoon:event）。
  ///
  /// 典型用途：设置页改完设置，让 WebView 里的播放层重读盘。归档版有多个窗口，
  /// 靠主进程分发天然送达；这里只有一个 WebView 且它有自己的内存副本，
  /// 必须显式通知，否则播放器会一直用挂载时读到的旧设置。
  void broadcastEvent(String event, [Object? payload]) {
    _broadcast(<String, Object?>{
      'event': event,
      'target': null,
      'payload': payload,
    });
  }

  final Set<StreamController<List<int>>> _broadcasters =
      <StreamController<List<int>>>{};

  void _broadcast(Map<String, Object?> frame) {
    final List<int> bytes = utf8.encode('data: ' + jsonEncode(frame) + '\n\n');
    for (final StreamController<List<int>> controller
        in _broadcasters.toList()) {
      if (!controller.isClosed) controller.add(bytes);
    }
  }

  /// 后端 SSE → 浏览器 SSE。
  Future<void> _events(HttpRequest request) async {
    if (request.method != 'GET') return _methodNotAllowed(request);
    final HttpResponse response = request.response;
    response.statusCode = HttpStatus.ok;
    response.headers.set(
      HttpHeaders.contentTypeHeader,
      'text/event-stream; charset=utf-8',
    );
    response.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
    response.headers.set('X-Accel-Buffering', 'no');
    // 关键：SSE 必须关掉输出缓冲。HttpResponse 默认会把不足缓冲区的字节攒起来，
    // 几十字节的事件帧会一直卡着不发出——浏览器侧表现为「连上了但永远收不到事件」。
    response.bufferOutput = false;
    await response.flush();

    final StreamController<List<int>> controller = StreamController<List<int>>();
    _broadcasters.add(controller);
    // 客户端可能已经断开：response.add 会抛，必须就地吞掉，
    // 否则异常会逃到 stream 监听器外面变成未捕获异步异常。
    final StreamSubscription<List<int>> writer = controller.stream.listen(
      (List<int> bytes) {
        try {
          response.add(bytes);
        } catch (_) {
          // 连接已断，等 response.done 收尾
        }
      },
      onError: (Object _) {},
    );
    final Timer keepAlive = Timer.periodic(const Duration(seconds: 20), (_) {
      controller.add(utf8.encode(': keep-alive\n\n'));
    });

    final BackendClient? client = _client();
    StreamSubscription<Map<String, Object?>>? upstream;

    void subscribe(BackendClient target) {
      upstream = target.events().listen(
        (Map<String, Object?> frame) {
          controller.add(utf8.encode('data: ' + jsonEncode(frame) + '\n\n'));
        },
        onError: (Object error) {
          controller.add(
            utf8.encode(
              ': 后端事件流异常 ' + error.toString().replaceAll('\n', ' ') + '\n\n',
            ),
          );
        },
        cancelOnError: false,
      );
    }

    if (client != null) {
      subscribe(client);
    } else {
      controller.add(
        utf8.encode('data: {"event":"host:offline","payload":null}\n\n'),
      );
    }

    // 后端崩溃重连（retry）会换一个新的 BackendClient，而 events() 内部的重连循环
    // 绑的是旧实例。每 3 秒比对一次实例身份，变了就换订阅；否则重连成功后事件永远
    // 收不到（页面不刷新、扫描进度不动）。
    BackendClient? subscribed = client;
    final Timer watcher = Timer.periodic(const Duration(seconds: 3), (Timer _) {
      final BackendClient? now = _client();
      if (identical(now, subscribed)) return;
      subscribed = now;
      unawaited(upstream?.cancel());
      if (now != null) subscribe(now);
    });

    await response.done.catchError((Object _) {});
    keepAlive.cancel();
    watcher.cancel();
    _broadcasters.remove(controller);
    await upstream?.cancel();
    await writer.cancel();
    await controller.close();
  }

  /// /a/<encodeURIComponent(绝对路径)>，支持单区间 Range。
  Future<void> _asset(HttpRequest request) async {
    if (request.method != 'GET' && request.method != 'HEAD') {
      return _methodNotAllowed(request);
    }
    // pathSegments 是解码后的：encodeURIComponent('C:/a b/x.mp3') 只会产生一段，
    // 未编码的客户端则会被拆成多段，两种都要能拼回绝对路径。
    final List<String> segments = request.uri.pathSegments;
    if (segments.length < 2) return _fail(request, 400, '缺少文件路径');
    final String path = segments.sublist(1).join('/');
    if (path.isEmpty) return _fail(request, 400, '缺少文件路径');

    FileStat stat;
    try {
      stat = await File(path).stat();
    } catch (error) {
      return _fail(request, 400, '路径无效：' + error.toString());
    }
    if (stat.type != FileSystemEntityType.file) {
      return _fail(request, 404, '文件不存在');
    }
    return _sendFile(request, File(path), stat.size, _contentType(path));
  }

  Future<void> _playerFile(HttpRequest request, String relative) async {
    if (request.method != 'GET' && request.method != 'HEAD') {
      return _methodNotAllowed(request);
    }
    final Uint8List? bytes = await _assets.load(relative);
    if (bytes == null) return _fail(request, 404, '产物缺失：' + relative);
    return _serveBytes(request, bytes, relative);
  }

  /// 把内存里的产物字节写回去（带正确 MIME 与长度）。
  Future<void> _serveBytes(
    HttpRequest request,
    Uint8List bytes,
    String name,
  ) async {
    final HttpResponse response = request.response;
    response.statusCode = HttpStatus.ok;
    response.headers.set(HttpHeaders.contentTypeHeader, _contentType(name));
    response.headers.set(HttpHeaders.cacheControlHeader, 'no-store');
    response.headers.set('Accept-Ranges', 'bytes');
    response.headers.set(
      HttpHeaders.contentLengthHeader,
      bytes.length.toString(),
    );
    if (request.method == 'GET') response.add(bytes);
    await response.close();
  }

  Future<void> _sendFile(
    HttpRequest request,
    File file,
    int length,
    String contentType,
  ) async {
    final HttpResponse response = request.response;
    response.headers.set(HttpHeaders.contentTypeHeader, contentType);
    response.headers.set(HttpHeaders.cacheControlHeader, 'no-store');
    response.headers.set('Accept-Ranges', 'bytes');
    if (length <= 0) {
      response.statusCode = HttpStatus.ok;
      response.headers.set(HttpHeaders.contentLengthHeader, '0');
      await response.close();
      return;
    }

    final String? header = request.headers.value(HttpHeaders.rangeHeader);
    _ByteRange? range;
    if (header != null) {
      range = _parseRange(header, length);
      if (range == null) {
        // 语法合法但不可满足：按 RFC 7233 回 416 并带总长度
        response.statusCode = HttpStatus.requestedRangeNotSatisfiable;
        response.headers.set(
          HttpHeaders.contentRangeHeader,
          'bytes */' + length.toString(),
        );
        response.headers.set(HttpHeaders.contentLengthHeader, '0');
        await response.close();
        return;
      }
      response.statusCode = HttpStatus.partialContent;
      response.headers.set(
        HttpHeaders.contentRangeHeader,
        'bytes ' +
            range.start.toString() +
            '-' +
            range.end.toString() +
            '/' +
            length.toString(),
      );
      response.headers.set(
        HttpHeaders.contentLengthHeader,
        range.length.toString(),
      );
    } else {
      response.statusCode = HttpStatus.ok;
      response.headers.set(
        HttpHeaders.contentLengthHeader,
        length.toString(),
      );
    }

    if (request.method == 'HEAD') {
      await response.close();
      return;
    }

    final int start = range?.start ?? 0;
    final int end = range?.end ?? (length - 1);
    // File.openRead 的 end 是排他的，所以传 end + 1
    await response.addStream(file.openRead(start, end + 1));
    await response.close();
  }

  /// 解析单区间 bytes= 头。返回 null 表示不可满足（回 416）。
  static _ByteRange? _parseRange(String header, int length) {
    if (!header.startsWith('bytes=')) return null;
    final String spec = header.substring(6).trim();
    if (spec.contains(',')) return null; // 只支持单区间
    final int dash = spec.indexOf('-');
    if (dash < 0) return null;
    final String left = spec.substring(0, dash).trim();
    final String right = spec.substring(dash + 1).trim();

    int start;
    int end;
    if (left.isEmpty) {
      // bytes=-N：最后 N 字节
      final int? suffix = int.tryParse(right);
      if (suffix == null || suffix <= 0) return null;
      start = length - suffix;
      if (start < 0) start = 0;
      end = length - 1;
    } else {
      final int? parsedStart = int.tryParse(left);
      if (parsedStart == null || parsedStart < 0 || parsedStart >= length) {
        return null;
      }
      start = parsedStart;
      if (right.isEmpty) {
        end = length - 1;
      } else {
        final int? parsedEnd = int.tryParse(right);
        if (parsedEnd == null || parsedEnd < start) return null;
        end = parsedEnd >= length ? length - 1 : parsedEnd;
      }
    }
    return _ByteRange(start, end);
  }

  static const Map<String, String> _types = <String, String>{
    'html': 'text/html; charset=utf-8',
    'js': 'application/javascript; charset=utf-8',
    'mjs': 'application/javascript; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'json': 'application/json; charset=utf-8',
    'map': 'application/json; charset=utf-8',
    'svg': 'image/svg+xml',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'webp': 'image/webp',
    'gif': 'image/gif',
    'ico': 'image/x-icon',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'otf': 'font/otf',
    'mp3': 'audio/mpeg',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'flac': 'audio/flac',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'opus': 'audio/ogg',
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'mkv': 'video/x-matroska',
    'avi': 'video/x-msvideo',
    'txt': 'text/plain; charset=utf-8',
    'lrc': 'text/plain; charset=utf-8',
    'wasm': 'application/wasm',
    'webmanifest': 'application/manifest+json',
  };

  static String _contentType(String path) {
    final int dot = path.lastIndexOf('.');
    if (dot < 0 || dot == path.length - 1) return 'application/octet-stream';
    final String ext = path.substring(dot + 1).toLowerCase();
    return _types[ext] ?? 'application/octet-stream';
  }

  Future<void> _writeJson(
    HttpRequest request,
    Map<String, Object?> body,
  ) async {
    final HttpResponse response = request.response;
    response.statusCode = HttpStatus.ok;
    response.headers.set(
      HttpHeaders.contentTypeHeader,
      'application/json; charset=utf-8',
    );
    response.headers.set(HttpHeaders.cacheControlHeader, 'no-store');
    response.write(jsonEncode(body));
    await response.close();
  }

  /// 桥通道的业务错误也回 200 + {ok:false,error}：渲染端的 callBridge
  /// 只认信封，不认 HTTP 状态码，回 4xx 反而会让它的 json() 解析失败。
  Future<void> _bridgeError(HttpRequest request, String message) {
    return _writeJson(request, <String, Object?>{'ok': false, 'error': message});
  }

  Future<void> _methodNotAllowed(HttpRequest request) {
    return _fail(request, HttpStatus.methodNotAllowed, '方法不支持');
  }

  Future<void> _fail(HttpRequest request, int status, String message) async {
    final HttpResponse response = request.response;
    response.statusCode = status;
    response.headers.set(
      HttpHeaders.contentTypeHeader,
      'text/plain; charset=utf-8',
    );
    response.write(message);
    await response.close();
  }
}
