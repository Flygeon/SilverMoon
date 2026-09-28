import 'package:flutter/foundation.dart';

import '../models/track.dart';
import '../services/music_repository.dart';

/// 在线音乐状态：搜索 / 推荐歌单 / 排行榜 / 歌单详情
class OnlineController extends ChangeNotifier {
  OnlineController({MusicRepository? repository})
      : repository = repository ?? MusicRepository();

  final MusicRepository repository;

  MusicServer _server = MusicServer.netease;
  String _keyword = '';
  List<Track> _results = <Track>[];
  List<OnlinePlaylist> _featured = <OnlinePlaylist>[];
  List<OnlinePlaylist> _rankings = <OnlinePlaylist>[];
  List<Track> _playlistTracks = <Track>[];
  OnlinePlaylist? _openedPlaylist;
  bool _loading = false;
  bool _loadingPlaylist = false;
  String? _error;

  MusicServer get server => _server;

  String get keyword => _keyword;

  List<Track> get results => _results;

  List<OnlinePlaylist> get featured => _featured;

  List<OnlinePlaylist> get rankings => _rankings;

  List<Track> get playlistTracks => _playlistTracks;

  OnlinePlaylist? get openedPlaylist => _openedPlaylist;

  bool get loading => _loading;

  bool get loadingPlaylist => _loadingPlaylist;

  String? get error => _error;

  void setServer(MusicServer s) {
    if (_server == s) return;
    _server = s;
    _results = <Track>[];
    _error = null;
    notifyListeners();
  }

  Future<void> search(String keyword) async {
    _keyword = keyword.trim();
    if (_keyword.isEmpty) {
      _results = <Track>[];
      notifyListeners();
      return;
    }
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      final List<Track> r = await repository.search(_server, _keyword, limit: 40);
      _results = r;
      if (r.isEmpty) _error = '没有找到结果';
    } catch (e) {
      _error = '搜索失败，请检查网络';
      _results = <Track>[];
    }
    _loading = false;
    notifyListeners();
  }

  Future<void> loadHome() async {
    _loading = true;
    notifyListeners();
    try {
      final List<OnlinePlaylist> f = await repository.featuredPlaylists();
      final List<OnlinePlaylist> r = await repository.rankings();
      _featured = f;
      _rankings = r;
    } catch (e) {
      _error = '加载在线内容失败';
    }
    _loading = false;
    notifyListeners();
  }

  Future<void> openPlaylist(OnlinePlaylist p) async {
    _openedPlaylist = p;
    _playlistTracks = <Track>[];
    _loadingPlaylist = true;
    notifyListeners();
    try {
      _playlistTracks = await repository.playlistTracks(p);
    } catch (e) {
      _playlistTracks = <Track>[];
    }
    _loadingPlaylist = false;
    notifyListeners();
  }

  void closePlaylist() {
    _openedPlaylist = null;
    _playlistTracks = <Track>[];
    notifyListeners();
  }
}
