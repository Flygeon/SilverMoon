import 'package:flutter/foundation.dart';

import '../models/track.dart';
import '../services/library_service.dart';

/// 本地曲库状态：加载 / 扫描 / 过滤 / 分组 / 排序
class LibraryController extends ChangeNotifier {
  LibraryController({LibraryService? service})
      : service = service ?? LibraryService();

  final LibraryService service;

  List<Track> _tracks = <Track>[];
  bool _scanning = false;
  String? _message;
  String _query = '';
  String _sortKey = 'title';
  bool _sortAsc = true;
  String _viewMode = 'list';

  List<Track> get tracks => _tracks;

  bool get scanning => _scanning;

  String? get message => _message;

  String get query => _query;

  String get sortKey => _sortKey;

  bool get sortAsc => _sortAsc;

  String get viewMode => _viewMode;

  bool get isEmpty => _tracks.isEmpty;

  Future<void> load() async {
    _tracks = await service.load();
    notifyListeners();
  }

  void setQuery(String q) {
    _query = q;
    notifyListeners();
  }

  void setViewMode(String mode) {
    _viewMode = mode;
    notifyListeners();
  }

  void setSort(String key, {bool? asc}) {
    if (_sortKey == key) {
      _sortAsc = asc ?? !_sortAsc;
    } else {
      _sortKey = key;
      _sortAsc = asc ?? true;
    }
    notifyListeners();
  }

  /// 扫描目录（会请求权限）
  Future<void> scan(List<String> dirs, {double minFileSizeMb = 0}) async {
    if (_scanning) return;
    _scanning = true;
    _message = '正在扫描…';
    notifyListeners();
    try {
      final bool ok = await service.ensurePermission();
      if (!ok) {
        _message = '未获得媒体读取权限，无法扫描本地音乐';
        _scanning = false;
        notifyListeners();
        return;
      }
      final List<Track> list = await service.scan(dirs, minFileSizeMb: minFileSizeMb);
      _tracks = list;
      _message = list.isEmpty ? '未找到音频文件' : '已导入 ' + list.length.toString() + ' 首';
    } catch (e) {
      _message = '扫描失败';
    }
    _scanning = false;
    notifyListeners();
  }

  void clearMessage() {
    _message = null;
    notifyListeners();
  }

  /// 过滤 + 排序后的列表
  List<Track> get visible {
    final String q = _query.trim().toLowerCase();
    List<Track> list = _tracks;
    if (q.isNotEmpty) {
      list = list.where((Track t) {
        return t.title.toLowerCase().contains(q) ||
            t.artist.toLowerCase().contains(q) ||
            t.album.toLowerCase().contains(q) ||
            t.displayTitle.toLowerCase().contains(q);
      }).toList();
    }
    final List<Track> sorted = List<Track>.from(list);
    int cmp(Track a, Track b) {
      switch (_sortKey) {
        case 'artist':
          return a.displayArtist.compareTo(b.displayArtist);
        case 'album':
          return a.displayAlbum.compareTo(b.displayAlbum);
        case 'duration':
          return (a.duration?.inMilliseconds ?? 0)
              .compareTo(b.duration?.inMilliseconds ?? 0);
        case 'added':
          return (a.addedAt?.millisecondsSinceEpoch ?? 0)
              .compareTo(b.addedAt?.millisecondsSinceEpoch ?? 0);
        default:
          return a.displayTitle.compareTo(b.displayTitle);
      }
    }

    sorted.sort((Track a, Track b) => _sortAsc ? cmp(a, b) : cmp(b, a));
    return sorted;
  }

  List<Track> get searchResults => visible;

  /// 按专辑分组
  List<({String album, String artist, List<Track> tracks})> get albums {
    final Map<String, List<Track>> map = <String, List<Track>>{};
    for (final Track t in _tracks) {
      map.putIfAbsent(t.albumKey, () => <Track>[]).add(t);
    }
    final List<({String album, String artist, List<Track> tracks})> out =
        <({String album, String artist, List<Track> tracks})>[];
    map.forEach((String key, List<Track> list) {
      out.add((
        album: list.first.displayAlbum,
        artist: list.first.displayArtist,
        tracks: list,
      ));
    });
    out.sort((a, b) => a.album.compareTo(b.album));
    return out;
  }

  /// 按艺术家分组
  List<({String artist, List<Track> tracks})> get artists {
    final Map<String, List<Track>> map = <String, List<Track>>{};
    for (final Track t in _tracks) {
      map.putIfAbsent(t.displayArtist, () => <Track>[]).add(t);
    }
    final List<({String artist, List<Track> tracks})> out =
        <({String artist, List<Track> tracks})>[];
    map.forEach((String key, List<Track> list) {
      out.add((artist: key, tracks: list));
    });
    out.sort((a, b) => a.artist.compareTo(b.artist));
    return out;
  }

  List<String> get folders {
    final Set<String> set = <String>{};
    for (final Track t in _tracks) {
      final String? f = t.folder;
      if (f != null && f.isNotEmpty) set.add(f);
    }
    final List<String> out = set.toList()..sort();
    return out;
  }
}
