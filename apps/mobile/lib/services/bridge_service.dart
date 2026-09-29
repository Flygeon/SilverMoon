import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:webview_flutter/webview_flutter.dart';

import 'web_host_service.dart';

/// WebView 里 Vue 前端推送过来的播放器状态快照。
@immutable
class PlayerSnapshot {
  const PlayerSnapshot({
    required this.hasTrack,
    required this.playing,
    required this.title,
    required this.artist,
    required this.coverUrl,
    required this.positionMs,
    required this.durationMs,
  });

  final bool hasTrack;
  final bool playing;
  final String title;
  final String artist;
  final String coverUrl;
  final int positionMs;
  final int durationMs;

  static const PlayerSnapshot empty = PlayerSnapshot(
    hasTrack: false,
    playing: false,
    title: '',
    artist: '',
    coverUrl: '',
    positionMs: 0,
    durationMs: 0,
  );

  factory PlayerSnapshot.fromJson(Map<String, dynamic> j) => PlayerSnapshot(
        hasTrack: j['hasTrack'] == true,
        playing: j['playing'] == true,
        title: (j['title'] ?? '').toString(),
        artist: (j['artist'] ?? '').toString(),
        coverUrl: (j['coverUrl'] ?? '').toString(),
        positionMs: (j['positionMs'] as num?)?.toInt() ?? 0,
        durationMs: (j['durationMs'] as num?)?.toInt() ?? 0,
      );
}

/// 桌面端渲染进程访问宿主环境的唯一接缝是 `window.__SILVERMOON__`，
/// 它下面有 invoke / invokeBatch / call 三个方法。这里在 Dart 侧实现同一套语义，
/// 于是 `apps/desktop` 的 Vue 代码可以**一行不改**地跑在 WebView 里。
///
/// 通道协议（与 `src/mobile/shim.ts` 约定）：
///   JS → Dart  {"id": n, "kind": "invoke|invokeBatch|call|emitTo", ...}
///   JS → Dart  {"kind": "event", "event": "...", "payload": {...}}
///   Dart → JS  window.__SM_REPLY__(id, replyJson)
///   Dart → JS  window.__SM_EVENT__(name, payloadJson)
class BridgeService {
  BridgeService({required this.host});

  final WebHostService host;

  final http.Client _client = http.Client();

  /// 播放器状态：由 Vue 侧的 pinia store 深度监听后推过来，供原生迷你播放器与
  /// 后续的通知栏/耳机线控使用。
  final ValueNotifier<PlayerSnapshot> player =
      ValueNotifier<PlayerSnapshot>(PlayerSnapshot.empty);

  /// Web 前端是否已完成首次挂载。
  final ValueNotifier<bool> webReady = ValueNotifier<bool>(false);

  /// 最近一次未实现的桥调用，便于在设置页里诊断。
  final ValueNotifier<String?> lastUnimplemented = ValueNotifier<String?>(null);

  WebViewController? _controller;

  /// 内存中的 JSON 存储：文件名 -> 键值表。与桌面端 `ipc/store.ts` 语义一致，
  /// set 之后要显式 save 才落盘。
  final Map<String, Map<String, Object?>> _stores = <String, Map<String, Object?>>{};
  final Set<String> _dirty = <String>{};
  String? _appDataDir;

  void attach(WebViewController controller) {
    _controller = controller;
  }

  Future<void> dispose() async {
    _client.close();
  }

  // ------------------------------------------------------------ 入口与出口

  /// 处理来自 WebView 的一条消息。协议里 request 与 event 混在一个通道，
  /// 靠 kind 区分：有 id 的必须回包，没有 id 的是单向事件。
  Future<void> handleMessage(String raw) async {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(raw) as Map<String, dynamic>;
    } catch (e) {
      debugPrint('bridge 收到非法 JSON: $e');
      return;
    }

    final String kind = (msg['kind'] ?? '').toString();

    if (kind == 'event') {
      _handleEvent(msg);
      return;
    }

    final int? id = (msg['id'] as num?)?.toInt();
    Map<String, dynamic> reply;
    try {
      final Object? data = await _dispatch(kind, msg);
      reply = <String, dynamic>{'ok': true, 'data': data};
    } catch (e) {
      reply = <String, dynamic>{'ok': false, 'error': _plainError(e)};
    }
    if (id != null) await _reply(id, reply);
  }

  void _handleEvent(Map<String, dynamic> msg) {
    final String event = (msg['event'] ?? '').toString();
    final Object? payload = msg['payload'];
    switch (event) {
      case 'player:state':
        if (payload is Map) {
          player.value =
              PlayerSnapshot.fromJson(Map<String, dynamic>.from(payload));
        }
        break;
      case 'app:ready':
        webReady.value = true;
        break;
      default:
        debugPrint('bridge 未处理的事件: $event');
    }
  }

  Future<Object?> _dispatch(String kind, Map<String, dynamic> msg) async {
    switch (kind) {
      case 'invoke':
        return _invoke(
          (msg['cmd'] ?? '').toString(),
          _asMap(msg['args']),
        );
      case 'invokeBatch':
        final List<dynamic> calls =
            (msg['calls'] as List<dynamic>?) ?? const <dynamic>[];
        final List<Map<String, dynamic>> out = <Map<String, dynamic>>[];
        for (final dynamic c in calls) {
          final Map<String, dynamic> call = _asMap(c);
          final String cmd = (call['cmd'] ?? '').toString();
          try {
            final Object? data = await _invoke(cmd, _asMap(call['args']));
            out.add(<String, dynamic>{'ok': true, 'data': data});
          } catch (e) {
            out.add(<String, dynamic>{'ok': false, 'error': _plainError(e)});
          }
        }
        return out;
      case 'call':
        return _call(
          (msg['channel'] ?? '').toString(),
          _asMap(msg['payload']),
        );
      case 'emitTo':
        // 移动端只有一个窗口，跨窗口事件直接丢弃
        return null;
      default:
        throw BridgeError('未知的桥调用类型: $kind');
    }
  }

  Future<void> _reply(int id, Map<String, dynamic> reply) async {
    final String payload = jsonEncode(reply);
    // 两层 encode：外层产出 JS 字符串字面量，内层是真正的 JSON 文本
    await _controller?.runJavaScript(
      'window.__SM_REPLY__ && window.__SM_REPLY__($id, ${jsonEncode(payload)});',
    );
  }

  /// Dart → JS 事件（原生媒体按钮、扫描进度等）。
  Future<void> emit(String event, Object? payload) async {
    await _controller?.runJavaScript(
      'window.__SM_EVENT__ && window.__SM_EVENT__('
      '${jsonEncode(event)}, ${jsonEncode(jsonEncode(payload))});',
    );
  }

  // ---------------------------------------------------------------- 主进程能力

  Future<Object?> _call(String channel, Map<String, dynamic> payload) async {
    switch (channel) {
      case 'http':
        return _http(payload);
      case 'fs':
        return _fs(payload);
      case 'store':
        return _store(payload);
      case 'path':
        return _path(payload);
      case 'app':
        return _app(payload);
      case 'opener':
        return null;
      case 'dialog':
        // 移动端不弹原生文件对话框；返回「用户取消」，调用方本就按取消处理
        return null;
      default:
        throw BridgeError('未实现的通道: $channel');
    }
  }

  /// 带 CORS 豁免的 fetch：第三方音乐接口不允许浏览器直连，这里由 Dart 网络栈发起。
  Future<Map<String, dynamic>> _http(Map<String, dynamic> payload) async {
    final String url = (payload['url'] ?? '').toString();
    if (url.isEmpty) throw BridgeError('http 调用缺少 url');
    final String method =
        (payload['method'] ?? 'GET').toString().toUpperCase();

    final http.Request req = http.Request(method, Uri.parse(url));
    final List<dynamic> headers =
        (payload['headers'] as List<dynamic>?) ?? const <dynamic>[];
    for (final dynamic h in headers) {
      if (h is List && h.length >= 2) {
        final String k = h[0].toString();
        final String v = h[1].toString();
        if (k.isNotEmpty) req.headers[k] = v;
      }
    }

    final Object? body = payload['body'];
    if (body is String && body.isNotEmpty && method != 'GET' && method != 'HEAD') {
      req.body = body;
    }

    final http.StreamedResponse resp =
        await _client.send(req).timeout(const Duration(seconds: 30));
    final List<int> bytes = await resp.stream.toBytes();

    // 文本响应直接给字符串（省掉一次 base64 膨胀）；二进制给 base64，
    // 由垫片还原成 Uint8Array，这样 `toBytes()` 拿到的仍是真正的字节。
    final String ctype =
        (resp.headers[HttpHeaders.contentTypeHeader] ?? '').toLowerCase();
    final bool textual = ctype.contains('json') ||
        ctype.contains('text') ||
        ctype.contains('xml') ||
        ctype.contains('javascript') ||
        ctype.contains('x-www-form-urlencoded') ||
        ctype.isEmpty;

    Object bodyOut;
    if (textual) {
      bodyOut = utf8.decode(bytes, allowMalformed: true);
    } else {
      bodyOut = <String, dynamic>{'__b64': base64Encode(bytes)};
    }

    return <String, dynamic>{
      'status': resp.statusCode,
      'statusText': resp.reasonPhrase ?? '',
      'url': url,
      'headers': resp.headers.entries
          .map((MapEntry<String, String> e) => <String>[e.key, e.value])
          .toList(),
      'body': bodyOut,
    };
  }

  Future<Object?> _fs(Map<String, dynamic> payload) async {
    final String op = (payload['op'] ?? '').toString();
    final String path = (payload['path'] ?? '').toString();
    switch (op) {
      case 'readFile':
        final Uint8List bytes = await File(path).readAsBytes();
        return <String, dynamic>{'__b64': base64Encode(bytes)};
      case 'readFileBase64':
        final Uint8List bytes = await File(path).readAsBytes();
        return base64Encode(bytes);
      case 'writeFile':
        await File(path).writeAsBytes(_decodeBytes(payload['data']));
        return null;
      case 'writeFileBase64':
        await File(path)
            .writeAsBytes(base64Decode((payload['data'] ?? '').toString()));
        return null;
      case 'readTextFile':
        return File(path).readAsString();
      case 'writeTextFile':
        await File(path)
            .writeAsString((payload['contents'] ?? '').toString());
        return null;
      case 'exists':
        return File(path).existsSync() || Directory(path).existsSync();
      case 'mkdir':
        await Directory(path).create(
          recursive: payload['recursive'] == true,
        );
        return null;
      case 'remove':
        final FileSystemEntityType t =
            await FileSystemEntity.type(path, followLinks: false);
        if (t == FileSystemEntityType.directory) {
          await Directory(path).delete(recursive: payload['recursive'] == true);
        } else if (t == FileSystemEntityType.file) {
          await File(path).delete();
        }
        return null;
      case 'copyFile':
        await File((payload['from'] ?? '').toString())
            .copy((payload['to'] ?? '').toString());
        return null;
      case 'rename':
        await File((payload['from'] ?? '').toString())
            .rename((payload['to'] ?? '').toString());
        return null;
      case 'stat':
        final FileSystemEntityType t =
            await FileSystemEntity.type(path, followLinks: true);
        if (t == FileSystemEntityType.notFound) {
          throw BridgeError('文件不存在: $path');
        }
        final bool isDir = t == FileSystemEntityType.directory;
        final FileStat st = isDir
            ? await Directory(path).stat()
            : await File(path).stat();
        return <String, dynamic>{
          'isFile': !isDir,
          'isDirectory': isDir,
          'size': st.size,
          'mtime': st.modified.millisecondsSinceEpoch,
        };
      case 'readDir':
        final List<Map<String, dynamic>> out = <Map<String, dynamic>>[];
        await for (final FileSystemEntity e
            in Directory(path).list(followLinks: false)) {
          final bool isDir = e is Directory;
          out.add(<String, dynamic>{
            'name': p.basename(e.path),
            'isFile': !isDir,
            'isDirectory': isDir,
          });
        }
        return out;
      default:
        throw BridgeError('未实现的 fs 操作: $op');
    }
  }

  Future<Object?> _store(Map<String, dynamic> payload) async {
    final String op = (payload['op'] ?? '').toString();
    final String file = (payload['file'] ?? '').toString();
    if (op == 'path') return _storePathAsync(file);

    final Map<String, Object?> data = await _loadStore(file);
    switch (op) {
      case 'get':
        return data[(payload['key'] ?? '').toString()];
      case 'set':
        data[(payload['key'] ?? '').toString()] = payload['value'];
        _dirty.add(file);
        return null;
      case 'delete':
        final bool had = data.remove((payload['key'] ?? '').toString()) != null;
        if (had) _dirty.add(file);
        return had;
      case 'has':
        return data.containsKey((payload['key'] ?? '').toString());
      case 'keys':
        return data.keys.toList();
      case 'values':
        return data.values.toList();
      case 'entries':
        return data.entries
            .map((MapEntry<String, Object?> e) => <Object?>[e.key, e.value])
            .toList();
      case 'length':
        return data.length;
      case 'clear':
        data.clear();
        _dirty.add(file);
        return null;
      case 'reset':
        data.clear();
        _stores.remove(file);
        _dirty.remove(file);
        await _deleteStoreFile(file);
        return null;
      case 'reload':
        _stores.remove(file);
        _dirty.remove(file);
        await _loadStore(file);
        return null;
      case 'save':
        await _saveStore(file);
        return null;
      case 'close':
        await _saveStore(file);
        return null;
      default:
        throw BridgeError('未实现的 store 操作: $op');
    }
  }

  Future<Object?> _path(Map<String, dynamic> payload) async {
    final String op = (payload['op'] ?? '').toString();
    switch (op) {
      case 'appDataDir':
        return _appDir();
      case 'appCacheDir':
        return (await getApplicationCacheDirectory()).path;
      case 'appConfigDir':
        return _appDir();
      case 'appLogDir':
        return _appDir();
      case 'homeDir':
        return _appDir();
      case 'tempDir':
        return Directory.systemTemp.path;
      case 'join':
        final List<dynamic> parts =
            (payload['paths'] as List<dynamic>?) ?? const <dynamic>[];
        return p.joinAll(parts.map((dynamic e) => e.toString()).toList());
      case 'normalize':
        return p.normalize((payload['path'] ?? '').toString());
      case 'dirname':
        return p.dirname((payload['path'] ?? '').toString());
      case 'basename':
        final String? ext = payload['ext'] as String?;
        final String path = (payload['path'] ?? '').toString();
        return ext == null ? p.basename(path) : p.basenameWithoutExtension(path);
      case 'extname':
        return p.extension((payload['path'] ?? '').toString());
      default:
        throw BridgeError('未实现的 path 操作: $op');
    }
  }

  Future<Object?> _app(Map<String, dynamic> payload) async {
    final String op = (payload['op'] ?? '').toString();
    switch (op) {
      case 'version':
        return '0.0.1';
      case 'name':
        return 'SilverMoon';
      case 'hostVersion':
        return 'flutter-mobile';
      case 'exit':
        return null;
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ Rust 命令

  Future<Object?> _invoke(String cmd, Map<String, dynamic> args) async {
    final Future<Object?> Function(Map<String, dynamic>)? handler = _commands[cmd];
    if (handler == null) {
      lastUnimplemented.value = cmd;
      throw BridgeError('移动端尚未实现命令: $cmd');
    }
    return handler(args);
  }

  /// Rust 命令表。由 bridge_commands.dart 注入，避免这个文件继续膨胀。
  Map<String, Future<Object?> Function(Map<String, dynamic>)> _commands =
      <String, Future<Object?> Function(Map<String, dynamic>)>{};

  void registerCommands(
    Map<String, Future<Object?> Function(Map<String, dynamic>)> commands,
  ) {
    _commands = <String, Future<Object?> Function(Map<String, dynamic>)>{
      ..._commands,
      ...commands,
    };
  }

  // ------------------------------------------------------------------ 存储实现

  Future<String> _appDir() async {
    final String? cached = _appDataDir;
    if (cached != null) return cached;
    final Directory dir = await getApplicationSupportDirectory();
    final Directory sm = Directory(p.join(dir.path, 'silvermoon'));
    if (!await sm.exists()) await sm.create(recursive: true);
    _appDataDir = sm.path;
    return sm.path;
  }

  Future<Map<String, Object?>> _loadStore(String file) async {
    final Map<String, Object?>? cached = _stores[file];
    if (cached != null) return cached;
    final Map<String, Object?> data = <String, Object?>{};
    try {
      final File f = File(await _storePathAsync(file));
      if (await f.exists()) {
        final Object? decoded = jsonDecode(await f.readAsString());
        if (decoded is Map) {
          data.addAll(decoded.map(
            (Object? k, Object? v) => MapEntry<String, Object?>(k.toString(), v),
          ));
        }
      }
    } catch (e) {
      debugPrint('store 读取 $file 失败: $e');
    }
    _stores[file] = data;
    return data;
  }

  Future<String> _storePathAsync(String file) async =>
      p.join(await _appDir(), file);

  Future<void> _saveStore(String file) async {
    if (!_dirty.contains(file)) return;
    final Map<String, Object?> data = _stores[file] ?? <String, Object?>{};
    try {
      final File f = File(await _storePathAsync(file));
      await f.writeAsString(jsonEncode(data), flush: true);
      _dirty.remove(file);
    } catch (e) {
      debugPrint('store 写入 $file 失败: $e');
    }
  }

  Future<void> _deleteStoreFile(String file) async {
    try {
      final File f = File(await _storePathAsync(file));
      if (await f.exists()) await f.delete();
    } catch (_) {
      // 删不掉就算了，下次写入会覆盖
    }
  }

  // ------------------------------------------------------------------ 小工具

  Map<String, dynamic> _asMap(Object? v) =>
      v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};

  Uint8List _decodeBytes(Object? v) {
    if (v is Map && v['__b64'] is String) {
      return base64Decode(v['__b64'] as String);
    }
    if (v is String) return base64Decode(v);
    if (v is List) return Uint8List.fromList(v.cast<int>());
    return Uint8List(0);
  }

  /// 桥上的错误会以字符串原样抛回 JS（桌面端有靠前缀判断错误的协议，
  /// 例如 `[WENKU8_LOGIN_CANCELLED]`），所以不能包一层 Dart 的异常格式。
  String _plainError(Object e) =>
      e is BridgeError ? e.message : e.toString().replaceFirst('Exception: ', '');
}

/// 桥层业务错误。message 会原样回传给 JS。
class BridgeError implements Exception {
  BridgeError(this.message);

  final String message;

  @override
  String toString() => message;
}
