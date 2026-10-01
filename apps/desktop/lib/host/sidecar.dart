import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

/// sidecar 的地址与令牌，宿主所有 HTTP 调用都用它。
class SidecarEndpoint {
  const SidecarEndpoint({required this.port, required this.token});

  final int port;
  final String token;

  String get origin => 'http://127.0.0.1:' + port.toString();
}

class SidecarException implements Exception {
  SidecarException(this.message);
  final String message;
  @override
  String toString() => 'SidecarException: ' + message;
}

/// Rust 后端（sidecar）的拉起、握手与回收。
///
/// 与 `backend/crates/silvermoon-ipc/src/server.rs` 的约定，改动即破坏：
///   1. 宿主随机生成令牌，经环境变量 `SILVERMOON_TOKEN` 传入；后端要求请求头
///      `X-SilverMoon-Token` 匹配（令牌为空则后端不校验，即独立调试模式）。
///   2. 后端绑 `127.0.0.1:0`，就绪后向 **stdout** 打一行
///      `SILVERMOON_READY {"port":N}`，前缀格式固定。
///   3. **后端在 stdin 到达 EOF 时 exit(0)** —— 所以宿主必须一直持有 stdin；
///      退出时先 `stdin.close()` 触发它自杀，超时再 kill 兜底。
///
/// 握手上限对齐方案 §2.4（15s，失败降级 + 提示）。
class Sidecar {
  Sidecar({
    this.readyTimeout = const Duration(seconds: 15),
    this.exitGrace = const Duration(seconds: 3),
  });

  /// 固定前缀，勿改（脚本侧按前缀解析）。
  static const String readyPrefix = 'SILVERMOON_READY ';

  final Duration readyTimeout;
  final Duration exitGrace;

  Process? _process;
  SidecarEndpoint? _endpoint;
  int? _exitCode;
  final List<String> _stderrTail = <String>[];

  SidecarEndpoint? get endpoint => _endpoint;
  bool get isRunning => _process != null;
  int? get exitCode => _exitCode;

  /// 后端最后几行 stderr，握手失败时用于提示。
  List<String> get stderrTail => List<String>.unmodifiable(_stderrTail);

  /// 每次启动生成新令牌（与 Electron 版一致）。
  static String newToken({int bytes = 24}) {
    final Random rng = Random.secure();
    final StringBuffer out = StringBuffer();
    for (int i = 0; i < bytes; i++) {
      out.write(rng.nextInt(256).toRadixString(16).padLeft(2, '0'));
    }
    return out.toString();
  }

  /// 默认二进制路径：打包后与主程序同级的 `silvermoon-server.exe`；
  /// 开发态回落到 `backend/target/{release,debug}/silvermoon.exe`。
  static String resolveExecutable({
    required String exeDir,
    required String binary,
    required String devBinary,
    String? repoBackendDir,
  }) {
    final String ext = Platform.isWindows ? '.exe' : '';
    final String packaged = _join(exeDir, binary + ext);
    if (File(packaged).existsSync()) return packaged;

    final String? backend = repoBackendDir;
    if (backend != null && backend.isNotEmpty) {
      for (final String profile in <String>['release', 'debug']) {
        final String candidate =
            _join(_join(_join(backend, 'target'), profile), devBinary + ext);
        if (File(candidate).existsSync()) return candidate;
      }
    }
    // 都没找到就返回打包路径，让调用方拿到明确的「文件不存在」错误
    return packaged;
  }

  /// 拉起后端并等待就绪握手。
  ///
  /// [environment] 会与 `SILVERMOON_TOKEN` 合并后传给子进程。数据/缓存目录等
  /// **必须显式传**（SILVERMOON_DATA_DIR / SILVERMOON_CACHE_DIR）：Rust 侧虽然有
  /// `%APPDATA%/<identifier>` 的回退，但显式传参能保证宿主与后端永远看同一个目录，
  /// 也不会因 identifier 变更而静默错位。
  Future<SidecarEndpoint> start({
    required String executable,
    String? token,
    String? workingDirectory,
    Map<String, String>? environment,
    void Function(String line)? onLog,
  }) async {
    if (_process != null) {
      throw SidecarException('sidecar 已在运行');
    }
    if (!File(executable).existsSync()) {
      throw SidecarException('找不到后端可执行文件：' + executable);
    }

    final String effectiveToken = token ?? newToken();
    final Process proc = await Process.start(
      executable,
      const <String>[],
      environment: <String, String>{
        'SILVERMOON_TOKEN': effectiveToken,
        ...?environment,
      },
      includeParentEnvironment: true,
      workingDirectory: workingDirectory,
      runInShell: false,
    );
    _process = proc;
    _exitCode = null;

    final Completer<SidecarEndpoint> ready = Completer<SidecarEndpoint>();

    proc.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
      (String line) {
        if (!ready.isCompleted) {
          final SidecarEndpoint? ep = _parseReady(line, effectiveToken);
          if (ep != null) {
            ready.complete(ep);
            return;
          }
        }
        onLog?.call(line);
      },
      onError: (Object error) {
        if (!ready.isCompleted) {
          ready.completeError(SidecarException('读取后端 stdout 失败：' + error.toString()));
        }
      },
    );

    proc.stderr
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
      (String line) {
        _stderrTail.add(line);
        if (_stderrTail.length > 40) _stderrTail.removeAt(0);
        onLog?.call('[backend] ' + line);
      },
      onError: (Object _) {},
    );

    unawaited(proc.exitCode.then((int code) {
      _exitCode = code;
      _process = null;
      if (!ready.isCompleted) {
        ready.completeError(SidecarException(
          '后端启动即退出（code ' + code.toString() + '）：' + _stderrTail.join(' | '),
        ));
      }
    }));

    try {
      final SidecarEndpoint ep = await ready.future.timeout(readyTimeout);
      _endpoint = ep;
      return ep;
    } on TimeoutException {
      await stop();
      throw SidecarException(
        '后端握手超时（' + readyTimeout.inSeconds.toString() + 's）：' + _stderrTail.join(' | '),
      );
    }
  }

  /// 关闭 stdin 让后端自行退出，超时才强杀。
  Future<void> stop() async {
    final Process? proc = _process;
    _process = null;
    _endpoint = null;
    if (proc == null) return;
    try {
      await proc.stdin.close();
    } catch (_) {
      // 进程可能已经退出
    }
    try {
      await proc.exitCode.timeout(exitGrace);
      return;
    } on TimeoutException {
      proc.kill();
    }
    try {
      await proc.exitCode.timeout(const Duration(seconds: 2));
    } on TimeoutException {
      // 放弃等待，交给操作系统回收
    }
  }

  static SidecarEndpoint? _parseReady(String line, String token) {
    final String trimmed = line.trim();
    if (!trimmed.startsWith(readyPrefix)) return null;
    try {
      final Object? decoded = jsonDecode(trimmed.substring(readyPrefix.length));
      if (decoded is Map) {
        final Object? port = decoded['port'];
        if (port is int) return SidecarEndpoint(port: port, token: token);
      }
    } catch (_) {
      // 首行不是 JSON 就当作普通日志
    }
    return null;
  }
}

String _join(String root, String name) {
  if (root.isEmpty) return name;
  final String sep = Platform.pathSeparator;
  return root.endsWith(sep) ? root + name : root + sep + name;
}
