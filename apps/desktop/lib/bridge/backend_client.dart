import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../host/sidecar.dart';

/// 后端统一回复信封：`{ ok, data?, error? }`。
///
/// 形状由 `crates/silvermoon-ipc/src/server.rs` 的 handle_command / handle_batch 固定，
/// 三种失败都走同一信封（401 令牌无效 / 400 参数缺失 / 404 未知命令）。
class BackendReply {
  const BackendReply({required this.ok, this.data, this.error, this.statusCode});

  final bool ok;
  final Object? data;
  final String? error;
  final int? statusCode;

  /// 失败时抛出**原始错误字符串**——业务代码靠字符串前缀判断
  /// （如 [WENKU8_LOGIN_CANCELLED]、[PIXIV_LOGIN_CANCELLED]），不能包成对象。
  Object? unwrap() {
    if (ok) return data;
    throw BackendError(error ?? '未知后端错误');
  }
}

/// 后端返回的业务错误。`toString()` 就是后端原始字符串，保证前缀判断可用。
class BackendError implements Exception {
  BackendError(this.message);

  final String message;

  @override
  String toString() => message;
}

/// Rust 后端的 HTTP 命令客户端。
///
/// 对应 `crates/silvermoon-ipc/src/server.rs`：
///   * `POST /cmd`   `{cmd, args}` → `{ok, data|error}`
///   * `POST /batch` `{calls:[{cmd,args}]}` → `{ok, data:[{ok,data}|{ok,error}]}`，上限 256 条
///   * `GET  /events` SSE，每帧只有 `data:`（内容是后端 JSON 字符串）
///   * `GET  /health`
/// 全部要求请求头 `X-SilverMoon-Token` 等于后端环境变量 `SILVERMOON_TOKEN`。
class BackendClient {
  BackendClient({
    required this.endpoint,
    HttpClient? client,
    this.timeout = const Duration(seconds: 30),
  }) : _client = client ?? HttpClient() {
    _client.connectionTimeout = const Duration(seconds: 5);
  }

  final SidecarEndpoint endpoint;
  final Duration timeout;
  final HttpClient _client;

  Uri _uri(String path) => Uri.parse(endpoint.origin + path);

  /// 单条命令。
  Future<BackendReply> invoke(
    String cmd, [
    Map<String, Object?> args = const <String, Object?>{},
  ]) {
    return _postJson('/cmd', <String, Object?>{'cmd': cmd, 'args': args});
  }

  /// 批量命令：一次往返多条，逐条独立成败，结果与入参按下标一一对应。
  ///
  /// 只有**整通道失败**（网络、令牌、超限）才会让所有条目一起失败 ——
  /// 与服务端 handle_batch 的语义一致，不能因一条失败中断整批。
  Future<List<BackendReply>> batch(List<Map<String, Object?>> calls) async {
    final BackendReply reply =
        await _postJson('/batch', <String, Object?>{'calls': calls});
    if (!reply.ok && reply.data is! List) {
      return calls
          .map((Map<String, Object?> _) => BackendReply(
                ok: false,
                error: reply.error,
                statusCode: reply.statusCode,
              ))
          .toList();
    }
    final Object? data = reply.data;
    if (data is! List) return <BackendReply>[];
    return data.map((Object? item) {
      if (item is Map) {
        final Object? error = item['error'];
        return BackendReply(
          ok: item['ok'] == true,
          data: item['data'],
          error: error is String ? error : null,
        );
      }
      return const BackendReply(ok: false, error: '批量结果格式错误');
    }).toList();
  }

  /// 就绪探针（`GET /health`）。
  Future<bool> health() async {
    try {
      final HttpClientRequest req = await _client.getUrl(_uri('/health'));
      // 后端 /health 目前不校验令牌，但这里不假设它永远不校验。
      req.headers.set('X-SilverMoon-Token', endpoint.token);
      final HttpClientResponse res = await req.close().timeout(timeout);
      await res.drain<void>();
      return res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// 订阅后端事件流。断线后自动重连（宿主退出时由上层取消订阅）。
  ///
  /// SSE 规范：空行是分帧边界，`data:` 多行用 \n 拼接；`:...` 是 keep-alive 注释，
  /// 后端用了 `KeepAlive::default()`，所以必须忽略而不是当帧处理。
  Stream<Map<String, Object?>> events({
    Duration retryDelay = const Duration(seconds: 2),
  }) async* {
    while (true) {
      try {
        final HttpClientRequest req = await _client.getUrl(_uri('/events'));
        req.headers.set('X-SilverMoon-Token', endpoint.token);
        req.headers.set(HttpHeaders.acceptHeader, 'text/event-stream');
        final HttpClientResponse res = await req.close();
        if (res.statusCode != 200) {
          throw StateError('事件流 HTTP ' + res.statusCode.toString());
        }

        final StringBuffer frame = StringBuffer();
        await for (final String line
            in res.transform(utf8.decoder).transform(const LineSplitter())) {
          if (line.isEmpty) {
            if (frame.isNotEmpty) {
              final Map<String, Object?>? decoded = _decodeFrame(frame.toString());
              if (decoded != null) yield decoded;
              frame.clear();
            }
            continue;
          }
          if (line.startsWith(':')) continue;
          if (line.startsWith('data:')) {
            final String chunk = line.substring(5);
            if (frame.isNotEmpty) frame.write('\n');
            frame.write(chunk.startsWith(' ') ? chunk.substring(1) : chunk);
          }
        }
      } catch (_) {
        // 断线或后端重启：走下面的退避重连
      }
      await Future<void>.delayed(retryDelay);
    }
  }

  void close() => _client.close(force: true);

  Future<BackendReply> _postJson(String path, Map<String, Object?> body) async {
    try {
      final HttpClientRequest req = await _client.postUrl(_uri(path)).timeout(timeout);
      req.headers.contentType = ContentType.json;
      req.headers.set('X-SilverMoon-Token', endpoint.token);
      final List<int> payload = utf8.encode(jsonEncode(body));
      req.headers.contentLength = payload.length;
      req.add(payload);
      final HttpClientResponse res = await req.close().timeout(timeout);
      final String text = await res.transform(utf8.decoder).join().timeout(timeout);
      return _decode(res.statusCode, text);
    } catch (error) {
      return BackendReply(ok: false, error: '与后端通信失败：' + error.toString());
    }
  }

  static BackendReply _decode(int status, String text) {
    if (text.isEmpty) {
      return BackendReply(
        ok: false,
        error: '后端返回空响应（HTTP ' + status.toString() + '）',
        statusCode: status,
      );
    }
    try {
      final Object? decoded = jsonDecode(text);
      if (decoded is Map) {
        final Object? error = decoded['error'];
        return BackendReply(
          ok: decoded['ok'] == true,
          data: decoded['data'],
          error: error is String ? error : null,
          statusCode: status,
        );
      }
    } catch (_) {
      // 落到下面的「不是 JSON」
    }
    return BackendReply(ok: false, error: '后端响应不是 JSON：' + text, statusCode: status);
  }

  static Map<String, Object?>? _decodeFrame(String raw) {
    try {
      final Object? decoded = jsonDecode(raw);
      if (decoded is Map) return decoded.cast<String, Object?>();
    } catch (_) {
      // 非 JSON 帧直接丢弃
    }
    return null;
  }
}
