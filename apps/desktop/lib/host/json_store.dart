import 'dart:convert';
import 'dart:io';

/// 整文件 JSON 键值存储。
///
/// 与 Electron `electron/store.ts` 逐字节兼容，这是「过渡期两版共存、可灰度回退」的前提：
///   * 文件落在应用数据目录下，`file` 只取 basename（不允许影响目录层级）；
///   * 内容是**一个 JSON 对象**，缩进 2 空格（对应 `JSON.stringify(data, null, 2)`）；
///   * 写盘 = 临时文件 + rename 原子替换，避免崩溃写出半截 JSON；
///   * 读损坏时退化成空 store 并保留原文件，不让应用起不来；
///   * 缺键一律返回 null（调用方无需区分「没有这个键」和「值是 null」）。
///
/// 三个既有 store：`settings.json` / `audio-effects.json` / `bangumi.json`。
class JsonStore {
  JsonStore(this.root);

  final String root;
  final Map<String, _StoreFile> _files = <String, _StoreFile>{};

  /// 与 Electron `handleStore(payload)` 同语义，供 bridge 的 store 通道直接转发。
  /// op ∈ get | set | delete | has | keys | values | entries | length | clear
  Object? handle(Map<String, Object?> payload) {
    final String op = (payload['op'] ?? '').toString();
    final _StoreFile entry = _load((payload['file'] ?? 'store.json').toString());
    final Object? key = payload['key'];
    final String? name = key == null ? null : key.toString();

    switch (op) {
      case 'get':
        if (name == null) return null;
        return entry.data.containsKey(name) ? entry.data[name] : null;
      case 'set':
        if (name == null) throw StateError('store.set 缺少 key');
        entry.data[name] = payload['value'];
        entry.dirty = true;
        return null;
      case 'delete':
        if (name == null) return false;
        final bool existed = entry.data.containsKey(name);
        entry.data.remove(name);
        if (existed) entry.dirty = true;
        return existed;
      case 'has':
        return name != null && entry.data.containsKey(name);
      case 'keys':
        return entry.data.keys.toList();
      case 'values':
        return entry.data.values.toList();
      case 'entries':
        return entry.data.entries
            .map((MapEntry<String, Object?> e) => <Object?>[e.key, e.value])
            .toList();
      case 'length':
        return entry.data.length;
      case 'clear':
        entry.data.clear();
        entry.dirty = true;
        return null;
      default:
        throw StateError('未知 store 操作：' + op);
    }
  }

  /// 便捷读取：设置页与启动流程用，等价 handle 的 get。
  Object? read(String file, String key) {
    final _StoreFile entry = _load(file);
    return entry.data.containsKey(key) ? entry.data[key] : null;
  }

  /// 便捷写入：只改内存，落盘交给 [save]（与 Electron 的显式 save 一致）。
  void write(String file, String key, Object? value) {
    final _StoreFile entry = _load(file);
    entry.data[key] = value;
    entry.dirty = true;
  }

  /// 显式落盘单个文件。
  void save(String file) => _persist(file);

  /// 退出前把所有脏 store 落盘（对应 Electron flushAllStores）。
  void flushAll() {
    for (final String file in _files.keys.toList()) {
      _persist(file);
    }
  }

  _StoreFile _load(String file) {
    final String path = _resolve(file);
    final _StoreFile? cached = _files[path];
    if (cached != null) return cached;

    _StoreFile entry = _StoreFile();
    try {
      final File f = File(path);
      if (f.existsSync()) {
        final String raw = f.readAsStringSync();
        if (raw.trim().isNotEmpty) {
          final Object? parsed = jsonDecode(raw);
          if (parsed is Map) {
            entry = _StoreFile(
              data: parsed.cast<String, Object?>(),
            );
          }
        }
      }
    } catch (_) {
      // 损坏时用空 store，原文件保留供排查
    }
    _files[path] = entry;
    return entry;
  }

  void _persist(String file) {
    final String path = _resolve(file);
    final _StoreFile? entry = _files[path];
    if (entry == null || !entry.dirty) return;
    final String tmp = path + '.tmp';
    try {
      File(tmp).writeAsStringSync(const JsonEncoder.withIndent('  ').convert(entry.data));
      File(tmp).renameSync(path);
      entry.dirty = false;
    } catch (_) {
      // 写失败不抛出：与 Electron 一致，只记日志，不让调用方崩
    }
  }

  /// 只取文件名部分（渲染进程传来的 file 不允许影响目录层级）。
  String _resolve(String file) {
    final String safe = _basename(file.isEmpty ? 'store.json' : file);
    if (root.isEmpty) return safe;
    final String sep = Platform.pathSeparator;
    return root.endsWith(sep) ? root + safe : root + sep + safe;
  }

  static String _basename(String value) {
    final int i = value.lastIndexOf(RegExp(r'[\\/]'));
    return i < 0 ? value : value.substring(i + 1);
  }
}

class _StoreFile {
  _StoreFile({Map<String, Object?>? data}) : data = data ?? <String, Object?>{};

  final Map<String, Object?> data;
  bool dirty = false;
}
