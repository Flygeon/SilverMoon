import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../bridge/backend_client.dart';
import '../bridge/event_bus.dart';
import '../features/library/library_api.dart';
import 'app_config.dart';
import 'app_paths.dart';
import 'json_store.dart';
import 'sidecar.dart';

enum HostStatus { idle, starting, ready, failed }

/// 宿主生命周期控制器。
///
/// 顺序对齐 Electron `electron/main.ts`：数据目录 → 旧数据迁移 → 拉起 sidecar
/// → 建命令客户端 → 订阅事件 → 探活。任何一步失败都**不阻断界面**：
/// 状态留在 [status] 与 [error]，界面降级展示并提供 [retry]。
///
/// 与后端的握手细节见 [Sidecar] 的类注释（stdin EOF 即退出那条尤其关键）。
class HostController extends ChangeNotifier {
  HostController(this.config);

  final AppConfig config;

  final StreamController<BackendEvent> _bus =
      StreamController<BackendEvent>.broadcast();

  HostStatus _status = HostStatus.idle;
  String? _error;
  Sidecar? _sidecar;
  BackendClient? _client;
  LibraryApi? _library;
  JsonStore? _store;
  HostPaths? _paths;
  StreamSubscription<Map<String, Object?>>? _events;
  bool _disposed = false;

  HostStatus get status => _status;
  String? get error => _error;
  BackendClient? get client => _client;
  LibraryApi? get library => _library;
  JsonStore? get store => _store;
  HostPaths? get paths => _paths;
  bool get isReady => _status == HostStatus.ready;

  /// 后端事件流（已解析为 [BackendEvent]，target 过滤交给订阅方）。
  Stream<BackendEvent> get events => _bus.stream;

  /// 启动链路；重复调用安全（已就绪时直接返回）。
  Future<void> start() async {
    if (_status == HostStatus.starting || _status == HostStatus.ready) return;
    _status = HostStatus.starting;
    _error = null;
    _notify();

    try {
      final HostPaths paths = HostPaths(config.identifier);
      if (paths.appDataRoot.isEmpty) {
        throw StateError('读取不到 APPDATA，无法定位应用数据目录');
      }
      paths.ensureDataDirs();
      _paths = paths;
      _migrateLegacy(paths);
      _store = JsonStore(paths.dataDir);

      final String exe = Sidecar.resolveExecutable(
        exeDir: File(Platform.resolvedExecutable).parent.path,
        binary: config.sidecarBinary,
        devBinary: config.sidecarDevBinary,
        repoBackendDir: _findRepoBackend(),
      );
      final Sidecar sidecar = Sidecar();
      _sidecar = sidecar;
      final SidecarEndpoint endpoint = await sidecar.start(
        executable: exe,
        workingDirectory: File(exe).parent.path,
        // 与 Electron 版 sidecar.ts 传的同一组变量；少传 DATA_DIR 会让后端
        // 走自己的回退路径，库与设置就可能指向别处。
        environment: <String, String>{
          'SILVERMOON_DATA_DIR': paths.dataDir,
          'SILVERMOON_CACHE_DIR': paths.cacheDir,
          'RUST_BACKTRACE': kDebugMode ? '1' : '0',
        },
        onLog: (String line) => debugPrint('[backend] ' + line),
      );

      final BackendClient client = BackendClient(endpoint: endpoint);
      _client = client;
      _library = LibraryApi(client);
      _events = client.events().listen(
        _onFrame,
        onError: (Object error) => debugPrint('[host] 事件流异常：' + error.toString()),
      );

      if (!await client.health()) {
        throw StateError('后端健康检查未通过（' + endpoint.origin + '）');
      }
      _status = HostStatus.ready;
      debugPrint('[host] 后端就绪：' + endpoint.origin);
    } catch (error) {
      _status = HostStatus.failed;
      _error = error.toString();
      await _teardown();
      debugPrint('[host] 启动失败：' + _error!);
    }
    _notify();
  }

  /// 停止后端并保留已落盘的设置（退出时用）。
  Future<void> stop() async {
    await _teardown();
    _status = HostStatus.idle;
    _notify();
  }

  Future<void> retry() async {
    await stop();
    await start();
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_teardown().whenComplete(() {
      if (!_bus.isClosed) _bus.close();
    }));
    super.dispose();
  }

  Future<void> _teardown() async {
    await _events?.cancel();
    _events = null;
    _client?.close();
    _client = null;
    _library = null;
    _store?.flushAll();
    final Sidecar? sidecar = _sidecar;
    _sidecar = null;
    await sidecar?.stop();
  }

  void _onFrame(Map<String, Object?> frame) {
    final BackendEvent? event = BackendEvent.fromFrame(frame);
    if (event == null || _bus.isClosed) return;
    _bus.add(event);
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// 首次启动把旧项目 LumiLuna 的数据整目录复制过来。
  ///
  /// 只在「新目录还不存在」且「旧目录存在」时执行一次，**只读旧目录、绝不删改**，
  /// 失败也不阻断启动（与 Electron config.ts 的 migrateLegacyData 同语义）。
  void _migrateLegacy(HostPaths paths) {
    final String legacyId = config.legacyIdentifier;
    if (legacyId.isEmpty) return;
    if (Directory(paths.dataDir).existsSync()) return;
    final Directory legacy = Directory(paths.legacyDataDir(legacyId));
    if (!legacy.existsSync()) return;
    try {
      _copyTree(legacy, Directory(paths.dataDir));
      debugPrint('[host] 已迁移旧数据：' + legacy.path);
    } catch (error) {
      debugPrint('[host] 旧数据迁移失败（不阻断启动）：' + error.toString());
    }
  }

  /// 递归复制目录；不跟随符号链接（与 Electron 版一致，避免成环）。
  void _copyTree(Directory from, Directory to) {
    to.createSync(recursive: true);
    for (final FileSystemEntity entity in from.listSync(followLinks: false)) {
      final String target = to.path + Platform.pathSeparator + _basename(entity.path);
      if (entity is Directory) {
        _copyTree(entity, Directory(target));
      } else if (entity is File) {
        entity.copySync(target);
      }
    }
  }

  /// 开发态定位 `backend/`：从工作目录与可执行文件目录分别向上找 `backend/Cargo.toml`。
  static String? _findRepoBackend() {
    final List<String> starts = <String>[
      Directory.current.path,
      File(Platform.resolvedExecutable).parent.path,
    ];
    for (final String start in starts) {
      Directory dir = Directory(start);
      for (int depth = 0; depth < 6; depth++) {
        final String candidate = dir.path + Platform.pathSeparator + 'backend';
        if (File(candidate + Platform.pathSeparator + 'Cargo.toml').existsSync()) {
          return candidate;
        }
        final Directory parent = dir.parent;
        if (parent.path == dir.path) break;
        dir = parent;
      }
    }
    return null;
  }
}

String _basename(String path) {
  final int index = path.lastIndexOf(RegExp(r'[\\/]'));
  return index < 0 ? path : path.substring(index + 1);
}
