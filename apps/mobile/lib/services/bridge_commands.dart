import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

import 'bridge_service.dart';
import 'library_service.dart';
import 'web_host_service.dart';

/// 桥上的 Rust 命令表。
///
/// 桌面端有 158 条命令，移动端目前只实现「音乐」这条链路真正用到的那部分：
/// 本地曲库扫描 / 列表 / 元数据 / 收藏 / 播放历史 / 听歌统计。
/// 在线音源与歌词**不在这里** —— 它们由 Vue 前端经 http 通道自己发请求和解析，
/// 所以网易云 / 酷狗 / QQ 音乐的搜索、播放地址、逐字歌词全部自动可用。
Map<String, Future<Object?> Function(Map<String, dynamic>)> buildBridgeCommands({
  required WebHostService host,
  required BridgeService bridge,
}) {
  final _Library lib = _Library(bridge);
  return <String, Future<Object?> Function(Map<String, dynamic>)>{
    // ---- 基础设施 ----
    'app_log': (Map<String, dynamic> a) async {
      debugPrint('[web] ${a['msg']}');
      return null;
    },
    'is_safe_mode': (Map<String, dynamic> a) async => false,
    'clear_thumbnail_cache': (Map<String, dynamic> a) async {
      await lib.clearThumbs();
      return null;
    },
    'thumbnail_cache_path': (Map<String, dynamic> a) async =>
        (await lib.thumbDir()).path,

    // ---- 扫描 ----
    'scan_start': lib.scanStart,
    'scan_status': lib.scanStatus,
    'scan_cancel': lib.scanCancel,

    // ---- 曲库 ----
    'list_files': lib.listFiles,
    'count_files': lib.countFiles,
    'library_counts': lib.counts,
    'get_metadata': lib.metadata,
    'get_song': lib.getSong,
    'get_thumbnail': lib.thumbnail,
    'save_thumbnail': (Map<String, dynamic> a) async => null,

    // ---- 收藏 / 历史 / 统计 ----
    'list_favorites': lib.listFavorites,
    'toggle_favorite': lib.toggleFavorite,
    'list_history': lib.listHistory,
    'record_play': lib.recordPlay,
    'start_play_session': lib.startSession,
    'end_play_session': lib.endSession,
    'get_listen_stats': lib.stats,
    'list_listen_stats': lib.listStats,
    'listen_source_breakdown': lib.sourceBreakdown,
  };
}

// ---------------------------------------------------------------------------

/// 一条本地音频记录。字段名与 @shared/types 的 MediaEntry 严格对齐
/// （Rust 侧 serde rename_all = camelCase），前端直接当对象用。
class _Entry {
  _Entry({
    required this.id,
    required this.path,
    required this.name,
    required this.ext,
    required this.size,
    required this.mtime,
  });

  final String id;
  final String path;
  final String name;
  final String ext;
  final int size;
  final int mtime;

  String? title;
  String? artist;
  String? album;
  int? durationMs;
  int? bitrate;
  bool favorite = false;
  bool hasCover = false;
  String? thumbPath;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'id': id,
        'path': path,
        'name': name,
        'ext': ext,
        'size': size,
        'mtime': mtime,
        'title': title,
        'artist': artist,
        'album': album,
        'durationMs': durationMs,
        'bitrate': bitrate,
        'favorite': favorite,
        'hasCover': hasCover,
        'thumbPath': thumbPath,
      };

  factory _Entry.fromJson(Map<String, dynamic> j) {
    final _Entry e = _Entry(
      id: (j['id'] ?? '').toString(),
      path: (j['path'] ?? '').toString(),
      name: (j['name'] ?? '').toString(),
      ext: (j['ext'] ?? '').toString(),
      size: (j['size'] as num?)?.toInt() ?? 0,
      mtime: (j['mtime'] as num?)?.toInt() ?? 0,
    );
    e.title = j['title'] as String?;
    e.artist = j['artist'] as String?;
    e.album = j['album'] as String?;
    e.durationMs = (j['durationMs'] as num?)?.toInt();
    e.bitrate = (j['bitrate'] as num?)?.toInt();
    e.favorite = j['favorite'] == true;
    e.hasCover = j['hasCover'] == true;
    e.thumbPath = j['thumbPath'] as String?;
    return e;
  }

  /// 前端列表项形状（MediaEntry）。
  Map<String, dynamic> toMediaEntry() => <String, dynamic>{
        'id': id,
        'path': path,
        'parent': p.dirname(path),
        'name': name,
        'ext': ext,
        'type': 'audio',
        'size': size,
        'mtime': mtime,
        'scannedAt': mtime,
        'deleted': 0,
        'title': title,
        'artist': artist,
        'album': album,
        'durationMs': durationMs,
        'width': null,
        'height': null,
        'codec': null,
        'fps': null,
        'takenAt': null,
        'hasCover': hasCover,
        'favorite': favorite,
        'thumbPath': thumbPath,
      };
}

class _ScanJob {
  _ScanJob(this.id);

  final String id;
  String stage = 'pending';
  int done = 0;
  int total = 0;
  int added = 0;
  int updated = 0;
  int removed = 0;
  String currentPath = '';
  String? error;
  bool cancelled = false;

  Map<String, dynamic> toJson() => <String, dynamic>{
        'jobId': id,
        'stage': stage,
        'done': done,
        'total': total,
        'percent': total == 0 ? 0 : (done * 100 ~/ total),
        'currentPath': currentPath,
        'added': added,
        'updated': updated,
        'removed': removed,
        'error': error,
      };
}

class _Library {
  _Library(this.bridge);

  final BridgeService bridge;

  final Map<String, _Entry> _entries = <String, _Entry>{};
  final Map<String, _ScanJob> _jobs = <String, _ScanJob>{};
  final Map<String, int> _history = <String, int>{};
  bool _loaded = false;

  // ------------------------------------------------------------ 持久化

  Future<Directory> _dir() async {
    final Directory base = await getApplicationSupportDirectory();
    final Directory d = Directory(p.join(base.path, 'silvermoon'));
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  Future<File> _libFile() async =>
      File(p.join((await _dir()).path, 'mobile-library.json'));

  Future<File> _favFile() async =>
      File(p.join((await _dir()).path, 'mobile-favorites.json'));

  Future<File> _hisFile() async =>
      File(p.join((await _dir()).path, 'mobile-history.json'));

  Future<Directory> thumbDir() async {
    final Directory d = Directory(p.join((await _dir()).path, 'thumbs'));
    if (!await d.exists()) await d.create(recursive: true);
    return d;
  }

  Future<void> clearThumbs() async {
    final Directory d = await thumbDir();
    if (await d.exists()) {
      await d.delete(recursive: true);
      await d.create(recursive: true);
    }
  }

  Future<void> _ensureLoaded() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final File f = await _libFile();
      if (await f.exists()) {
        final Object? j = jsonDecode(await f.readAsString());
        if (j is List) {
          for (final dynamic raw in j) {
            if (raw is Map) {
              final _Entry e = _Entry.fromJson(Map<String, dynamic>.from(raw));
              _entries[e.id] = e;
            }
          }
        }
      }
    } catch (err) {
      debugPrint('曲库读取失败: $err');
    }
    try {
      final File f = await _favFile();
      if (await f.exists()) {
        final Object? j = jsonDecode(await f.readAsString());
        if (j is List) {
          for (final dynamic id in j) {
            _entries[id.toString()]?.favorite = true;
          }
        }
      }
    } catch (_) {}
    try {
      final File f = await _hisFile();
      if (await f.exists()) {
        final Object? j = jsonDecode(await f.readAsString());
        if (j is Map) {
          j.forEach((Object? k, Object? v) {
            _history[k.toString()] = (v as num?)?.toInt() ?? 0;
          });
        }
      }
    } catch (_) {}
  }

  Future<void> _persist() async {
    try {
      final File f = await _libFile();
      await f.writeAsString(
        jsonEncode(_entries.values.map((_Entry e) => e.toJson()).toList()),
      );
      final File ff = await _favFile();
      await ff.writeAsString(jsonEncode(_entries.values
          .where((_Entry e) => e.favorite)
          .map((_Entry e) => e.id)
          .toList()));
      final File fh = await _hisFile();
      await fh.writeAsString(jsonEncode(_history));
    } catch (err) {
      debugPrint('曲库写入失败: $err');
    }
  }

  // ------------------------------------------------------------ 扫描

  String _idFor(String path) => md5.convert(utf8.encode(path)).toString();

  Future<Object?> scanStart(Map<String, dynamic> args) async {
    await _ensureLoaded();
    final Map<String, dynamic> config = args['config'] is Map
        ? Map<String, dynamic>.from(args['config'] as Map)
        : <String, dynamic>{};
    final List<String> dirs =
        ((config['dirs'] as List<dynamic>?) ?? const <dynamic>[])
            .map((dynamic e) => e.toString())
            .toList();
    final int maxDepth = (config['maxDepth'] as num?)?.toInt() ?? 12;

    final String jobId = 'mob-${DateTime.now().microsecondsSinceEpoch}';
    final _ScanJob job = _ScanJob(jobId);
    _jobs[jobId] = job;
    unawaited(_runScan(job, dirs, maxDepth));
    return <String, dynamic>{'jobId': jobId};
  }

  Future<void> _runScan(_ScanJob job, List<String> dirs, int maxDepth) async {
    job.stage = 'enumerate';
    try {
      final List<String> roots = dirs.isEmpty ? await _defaultDirs() : dirs;
      final List<File> files = <File>[];
      for (final String root in roots) {
        if (job.cancelled) break;
        final Directory d = Directory(root);
        if (!await d.exists()) continue;
        try {
          await for (final FileSystemEntity e
              in d.list(recursive: true, followLinks: false)) {
            if (job.cancelled) break;
            if (e is! File) continue;
            final String lower = e.path.toLowerCase();
            if (lower.contains('/android/data/')) continue;
            final int dot = lower.lastIndexOf('.');
            if (dot < 0) continue;
            if (!kAudioExtensions.contains(lower.substring(dot))) continue;
            files.add(e);
          }
        } catch (err) {
          debugPrint('扫描 $root 失败: $err');
        }
      }
      if (job.cancelled) {
        job.stage = 'cancelled';
        return;
      }

      job.total = files.length;
      job.stage = 'parse';

      final Set<String> alive = <String>{};
      final Directory thumbs = await thumbDir();
      // 元数据 + 内嵌封面抽取分批丢进 isolate，避免几万次同步 IO 卡住 UI。
      // 注意：无法解析的文件会被 isolate 跳过，所以必须按 filePath 对齐而不是下标。
      const int batch = 120;
      for (int i = 0; i < files.length; i += batch) {
        if (job.cancelled) {
          job.stage = 'cancelled';
          return;
        }
        final int end = (i + batch) > files.length ? files.length : (i + batch);
        final List<File> slice = files.sublist(i, end);
        final List<String> paths =
            slice.map((File f) => f.path).toList(growable: false);
        final Map<String, dynamic> result = await compute(
          scanAudioBatchInIsolate,
          <String, dynamic>{
            'paths': paths,
            'ids': paths.map(_idFor).toList(growable: false),
            'thumbDir': thumbs.path,
          },
        );
        final List<dynamic> items =
            (result['items'] as List<dynamic>?) ?? const <dynamic>[];
        for (final dynamic raw in items) {
          if (raw is! Map) continue;
          final Map<String, dynamic> meta = Map<String, dynamic>.from(raw);
          final String path = (meta['filePath'] ?? '').toString();
          if (path.isEmpty) continue;
          final String id = _idFor(path);
          alive.add(id);
          final _Entry? existing = _entries[id];
          final _Entry entry;
          if (existing == null) {
            entry = _Entry(
              id: id,
              path: path,
              name: p.basename(path),
              ext: p.extension(path).toLowerCase(),
              size: 0,
              mtime: 0,
            );
            job.added++;
          } else {
            entry = existing;
            job.updated++;
          }
          entry.title = _str(meta['title']);
          entry.artist = _str(meta['artist']);
          entry.album = _str(meta['album']);
          entry.durationMs = (meta['durationMs'] as num?)?.toInt();
          entry.bitrate = (meta['bitrate'] as num?)?.toInt();
          entry.size = (meta['size'] as num?)?.toInt() ?? entry.size;
          entry.mtime = (meta['mtime'] as num?)?.toInt() ?? entry.mtime;
          entry.hasCover = meta['hasCover'] == true;
          entry.thumbPath = meta['thumbPath'] as String?;
          _entries[id] = entry;
        }
        job.done = end;
        job.currentPath = paths.isEmpty ? '' : paths.last;
        _publish(job);
      }

      job.stage = 'store';
      final List<String> gone =
          _entries.keys.where((String id) => !alive.contains(id)).toList();
      for (final String id in gone) {
        _entries.remove(id);
        job.removed++;
      }
      await _persist();
      job.stage = 'done';
      _publish(job);
    } catch (err) {
      job.stage = 'error';
      job.error = err.toString();
      _publish(job);
    }
  }

  String? _str(Object? v) {
    if (v == null) return null;
    final String s = v.toString().trim();
    return s.isEmpty ? null : s;
  }

  Future<List<String>> _defaultDirs() async {
    final List<String> out = <String>[];
    if (Platform.isAndroid) {
      const String base = '/storage/emulated/0';
      out.addAll(<String>[
        '$base/Music',
        '$base/Download',
        '$base/Netease/CloudMusic/Music',
        '$base/qqmusic/song',
        '$base/kugou/down_data',
        '$base/kugou/down_kg',
        '$base/Android/media',
      ]);
    }
    try {
      final Directory docs = await getApplicationDocumentsDirectory();
      out.add(docs.path);
    } catch (_) {}
    return out;
  }

  void _publish(_ScanJob job) {
    // 前端是轮询 scan_status 的，这里额外推一次事件，让进度条更跟手
    unawaited(bridge.emit('scan:progress', job.toJson()));
  }

  Future<Object?> scanStatus(Map<String, dynamic> args) async {
    final _ScanJob? job = _jobs[(args['jobId'] ?? '').toString()];
    return job?.toJson();
  }

  Future<Object?> scanCancel(Map<String, dynamic> args) async {
    final _ScanJob? job = _jobs[(args['jobId'] ?? '').toString()];
    if (job != null) job.cancelled = true;
    return null;
  }

  // ------------------------------------------------------------ 查询

  Future<Object?> listFiles(Map<String, dynamic> args) async {
    await _ensureLoaded();
    final Map<String, dynamic> q = args['query'] is Map
        ? Map<String, dynamic>.from(args['query'] as Map)
        : args;

    Iterable<_Entry> list = _entries.values;
    final String type = (q['type'] ?? '').toString();
    if (type.isNotEmpty && type != 'audio') return <dynamic>[];

    final String search = (q['search'] ?? '').toString().trim().toLowerCase();
    if (search.isNotEmpty) {
      list = list.where((_Entry e) {
        final String hay = '${e.title ?? ''} ${e.artist ?? ''} '
            '${e.album ?? ''} ${e.name}';
        return hay.toLowerCase().contains(search);
      });
    }
    final int minSize = (q['minSize'] as num?)?.toInt() ?? 0;
    if (minSize > 0) list = list.where((_Entry e) => e.size >= minSize);

    final List<_Entry> sorted = list.toList();
    final String sortBy = (q['sortBy'] ?? 'title').toString();
    final bool desc = q['desc'] == true;

    int cmp(_Entry a, _Entry b) {
      switch (sortBy) {
        case 'name':
          return a.name.toLowerCase().compareTo(b.name.toLowerCase());
        case 'mtime':
          return a.mtime.compareTo(b.mtime);
        case 'size':
          return a.size.compareTo(b.size);
        default:
          final String ta = (a.title ?? a.name).toLowerCase();
          final String tb = (b.title ?? b.name).toLowerCase();
          return ta.compareTo(tb);
      }
    }

    sorted.sort((_Entry a, _Entry b) => desc ? cmp(b, a) : cmp(a, b));

    final int offset = (q['offset'] as num?)?.toInt() ?? 0;
    final int limit = (q['limit'] as num?)?.toInt() ?? 2000;
    final int from = offset.clamp(0, sorted.length).toInt();
    final int to = (from + limit).clamp(0, sorted.length).toInt();
    return sorted.sublist(from, to).map((_Entry e) => e.toMediaEntry()).toList();
  }

  Future<Object?> countFiles(Map<String, dynamic> args) async {
    await _ensureLoaded();
    return _entries.length;
  }

  Future<Object?> counts(Map<String, dynamic> args) async {
    await _ensureLoaded();
    return <String, dynamic>{
      'all': _entries.length,
      'audio': _entries.length,
      'image': 0,
      'video': 0,
      'book': 0,
      'favorite': _entries.values.where((_Entry e) => e.favorite).length,
    };
  }

  Future<Object?> metadata(Map<String, dynamic> args) async {
    await _ensureLoaded();
    final String fileId = (args['fileId'] ?? args['id'] ?? '').toString();
    final _Entry? e = _entries[fileId];
    if (e == null) return null;
    return <String, dynamic>{
      'fileId': e.id,
      'title': e.title ?? p.basenameWithoutExtension(e.name),
      'artist': e.artist,
      'albumArtist': e.artist,
      'album': e.album,
      'genre': null,
      'year': null,
      'trackNo': null,
      'discNo': null,
      'durationMs': e.durationMs,
      'bitrate': e.bitrate,
      'sampleRate': null,
      'channels': null,
      'width': null,
      'height': null,
      'orientation': null,
      'codec': null,
      'fps': null,
      'takenAt': null,
      'camera': null,
      'lens': null,
      'iso': null,
      'exposure': null,
      'fNumber': null,
      'focalLength': null,
      'gpsLat': null,
      'gpsLng': null,
      'author': null,
      'publisher': null,
      'language': null,
      'pageCount': null,
      'chapterCount': null,
      'hasCover': e.hasCover,
      'hasLyrics': _hasLyric(e.path),
    };
  }

  bool _hasLyric(String path) {
    final int dot = path.lastIndexOf('.');
    final String base = dot > 0 ? path.substring(0, dot) : path;
    for (final String ext in <String>['.lrc', '.krc', '.txt']) {
      if (File('$base$ext').existsSync()) return true;
    }
    return false;
  }

  Future<Object?> getSong(Map<String, dynamic> args) async {
    await _ensureLoaded();
    final String fileId = (args['fileId'] ?? args['id'] ?? '').toString();
    final _Entry? e = _entries[fileId];
    if (e == null) return null;
    final int dot = e.path.lastIndexOf('.');
    final String base = dot > 0 ? e.path.substring(0, dot) : e.path;
    String? lyrics;
    for (final String ext in <String>['.lrc', '.txt']) {
      final File f = File('$base$ext');
      if (await f.exists()) {
        lyrics = await f.readAsString();
        break;
      }
    }
    return <String, dynamic>{
      'file': <String, dynamic>{
        'id': e.id,
        'path': e.path,
        'parent': p.dirname(e.path),
        'name': e.name,
        'ext': e.ext,
        'type': 'audio',
        'size': e.size,
        'mtime': e.mtime,
        'scanned_at': e.mtime,
        'deleted': 0,
      },
      'meta': await metadata(<String, dynamic>{'fileId': fileId}),
      'coverBase64': null,
      'lyrics': lyrics,
    };
  }

  Future<Object?> thumbnail(Map<String, dynamic> args) async {
    await _ensureLoaded();
    final String fileId = (args['fileId'] ?? args['id'] ?? '').toString();
    final _Entry? e = _entries[fileId];
    if (e == null || !e.hasCover) return null;
    return <String, dynamic>{'path': e.thumbPath ?? e.path};
  }

  // ------------------------------------------------------------ 收藏 / 历史

  Future<Object?> listFavorites(Map<String, dynamic> args) async {
    await _ensureLoaded();
    return _entries.values
        .where((_Entry e) => e.favorite)
        .map((_Entry e) => e.toMediaEntry())
        .toList();
  }

  Future<Object?> toggleFavorite(Map<String, dynamic> args) async {
    await _ensureLoaded();
    final String fileId = (args['fileId'] ?? args['id'] ?? '').toString();
    final _Entry? e = _entries[fileId];
    if (e == null) return null;
    final Object? forced = args['favorite'];
    e.favorite = forced is bool ? forced : !e.favorite;
    await _persist();
    return e.favorite;
  }

  Future<Object?> listHistory(Map<String, dynamic> args) async {
    await _ensureLoaded();
    return _history.keys
        .map((String id) => _entries[id])
        .whereType<_Entry>()
        .map((_Entry e) => e.toMediaEntry())
        .toList();
  }

  Future<Object?> recordPlay(Map<String, dynamic> args) async {
    await _ensureLoaded();
    final String fileId = (args['fileId'] ?? args['id'] ?? '').toString();
    if (fileId.isEmpty) return null;
    _history[fileId] = (_history[fileId] ?? 0) + 1;
    await _persist();
    return null;
  }

  Future<Object?> startSession(Map<String, dynamic> args) async => null;

  Future<Object?> endSession(Map<String, dynamic> args) async {
    final String fileId = (args['fileId'] ?? args['id'] ?? '').toString();
    if (fileId.isNotEmpty) {
      _history[fileId] = (_history[fileId] ?? 0) + 1;
      await _persist();
    }
    return null;
  }

  Future<Object?> stats(Map<String, dynamic> args) async {
    await _ensureLoaded();
    int total = 0;
    for (final int v in _history.values) {
      total += v;
    }
    return <String, dynamic>{
      'totalPlays': total,
      'trackCount': _history.length,
      'libraryCount': _entries.length,
      'favoriteCount': _entries.values.where((_Entry e) => e.favorite).length,
    };
  }

  Future<Object?> listStats(Map<String, dynamic> args) async {
    await _ensureLoaded();
    final List<Map<String, dynamic>> out = <Map<String, dynamic>>[];
    _history.forEach((String id, int plays) {
      final _Entry? e = _entries[id];
      if (e == null) return;
      out.add(<String, dynamic>{
        'fileId': id,
        'title': e.title ?? p.basenameWithoutExtension(e.name),
        'artist': e.artist,
        'plays': plays,
      });
    });
    out.sort((Map<String, dynamic> a, Map<String, dynamic> b) =>
        (b['plays'] as int).compareTo(a['plays'] as int));
    return out;
  }

  Future<Object?> sourceBreakdown(Map<String, dynamic> args) async {
    await _ensureLoaded();
    return <dynamic>[
      <String, dynamic>{'source': 'local', 'count': _entries.length},
    ];
  }
}
