import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/track.dart';
import '../services/bridge_online.dart';
import '../services/music_repository.dart';

/// 在线音乐状态：搜索 / 推荐歌单 / 排行榜 / 歌单详情 / 账号 / 每日推荐 / 签到。
///
/// 账号部分走 [OnlineMusicService]（与桥接共用同一个实例，cookie jar 是同一份），
/// 搜索与播放直链走 [MusicRepository]。两者是历史遗留的两套实现，后续会合并。
class OnlineController extends ChangeNotifier {
  OnlineController({MusicRepository? repository, OnlineMusicService? online})
      : repository = repository ?? MusicRepository(),
        online = online ?? OnlineMusicService();

  final MusicRepository repository;
  final OnlineMusicService online;

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

  // ---- 账号 ----
  Map<String, Object?>? _account;
  bool _accountLoaded = false;
  int _signedDays = 0;
  String? _signInMessage;

  // ---- 每日推荐 ----
  List<Track> _daily = <Track>[];
  bool _loadingDaily = false;

  // ---- 我的音乐 ----
  List<OnlinePlaylist> _myPlaylists = <OnlinePlaylist>[];
  bool _loadingMine = false;
  List<Track> _cloud = <Track>[];
  bool _loadingCloud = false;
  /// 已红心的 songId 集合。网易云只提供 id 列表，没有对应的歌曲详情接口，
  /// 所以这里只用来标心，不做成一个可播放的歌单。
  Set<String> _liked = <String>{};
  /// 操作类反馈（红心失败等），与加载错误分开，免得把列表清空。
  String? _notice;

  // ---- 扫码登录 ----
  String _qrKey = '';
  String? _qrContent;
  int _qrStatus = 0;
  bool _startingQr = false;
  String? _loginError;

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

  Map<String, Object?>? get account => _account;
  bool get loggedIn => _account != null;
  bool get accountLoaded => _accountLoaded;
  int get signedDays => _signedDays;
  String? get signInMessage => _signInMessage;
  List<Track> get daily => _daily;
  bool get loadingDaily => _loadingDaily;
  List<OnlinePlaylist> get myPlaylists => _myPlaylists;
  bool get loadingMine => _loadingMine;
  List<Track> get cloud => _cloud;
  bool get loadingCloud => _loadingCloud;
  String? get notice => _notice;

  bool isLiked(Track t) {
    final String id = t.sourceKey ?? '';
    return id.isNotEmpty && _liked.contains(id);
  }
  String? get qrContent => _qrContent;
  int get qrStatus => _qrStatus;
  bool get startingQr => _startingQr;
  String? get loginError => _loginError;

  /// Meting 是聚合源，没有账号体系。
  bool get supportsAccount => _server != MusicServer.meting;

  String get serverLabel => _server.label;

  String get accountName => _str(_account?['nickname'], '未命名用户');

  /// 酷狗用 avatar，网易云用 avatarUrl，这里统一。
  String get accountAvatar =>
      _str(_account?['avatarUrl'] ?? _account?['avatar'], '');

  void setServer(MusicServer s) {
    if (_server == s) return;
    _server = s;
    _results = <Track>[];
    _error = null;
    _account = null;
    _accountLoaded = false;
    _daily = <Track>[];
    _signInMessage = null;
    notifyListeners();
    if (s != MusicServer.meting) {
      // 换平台要重新认一次账号，但不要把 UI 卡住 —— 失败就按未登录处理
      unawaited(loadAccount());
    }
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
    if (!_accountLoaded) unawaited(loadAccount());
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

  // ============================================================ 账号

  Future<void> loadAccount() async {
    if (!supportsAccount) {
      _account = null;
      _accountLoaded = true;
      notifyListeners();
      return;
    }
    try {
      if (_server == MusicServer.netease) {
        final Object? a = await online.neteaseAccount(<String, dynamic>{});
        _account = a is Map ? Map<String, Object?>.from(a) : null;
      } else {
        final Object? st = await online.kugouLoginStatus(<String, dynamic>{});
        if (st is Map) {
          final Object? p = st['profile'];
          _account = p is Map ? Map<String, Object?>.from(p) : null;
          _signedDays = _int(st['signedDays'], 0);
        } else {
          _account = null;
        }
      }
    } catch (e) {
      _account = null;
    }
    _accountLoaded = true;
    notifyListeners();
    if (_account != null) {
      unawaited(loadDaily());
      unawaited(loadLikes());
      unawaited(loadMyPlaylists());
      unawaited(loadCloud());
    }
  }

  Future<void> loadDaily() async {
    if (_server != MusicServer.netease || _account == null) return;
    _loadingDaily = true;
    notifyListeners();
    try {
      final Object? r =
          await online.neteaseDailyRecommendSongs(<String, dynamic>{});
      _daily = r is List
          ? r.whereType<Map<dynamic, dynamic>>().map(_trackFromNe).toList()
          : <Track>[];
    } catch (e) {
      _daily = <Track>[];
    }
    _loadingDaily = false;
    notifyListeners();
  }

  Future<void> signIn() async {
    if (_server != MusicServer.kugou || _account == null) return;
    try {
      final Object? r = await online.kugouSignIn(<String, dynamic>{});
      final Map<String, Object?> m =
          r is Map ? Map<String, Object?>.from(r) : <String, Object?>{};
      final bool ok = m['ok'] == true;
      _signInMessage = _str(m['message'], ok ? '签到成功' : '签到失败');
      if (ok) _signedDays += 1;
    } catch (e) {
      _signInMessage = '签到失败：$e';
    }
    notifyListeners();
  }

  Future<void> logout() async {
    try {
      if (_server == MusicServer.netease) {
        await online.neteaseLogout(<String, dynamic>{});
      } else {
        await online.kugouLogout(<String, dynamic>{});
      }
    } catch (e) {
      // 上游失败也要把本地状态清掉，否则界面停在「已登录」出不去
    }
    _account = null;
    _daily = <Track>[];
    _signedDays = 0;
    _signInMessage = null;
    notifyListeners();
  }

  // ============================================================ 扫码登录

  /// 取一个二维码（网易云只有 unikey，要自己拼登录链接；酷狗直接给 url）。
  Future<void> startQrLogin() async {
    _startingQr = true;
    _qrStatus = 0;
    _loginError = null;
    _qrContent = null;
    _qrKey = '';
    notifyListeners();
    try {
      if (_server == MusicServer.netease) {
        final Object? key = await online.neteaseLoginQrKey(<String, dynamic>{});
        _qrKey = _str(key, '');
        if (_qrKey.isEmpty) throw Exception('上游没有返回二维码');
        _qrContent = 'https://music.163.com/login?codekey=$_qrKey';
      } else {
        final Object? r = await online.kugouLoginQrKey(<String, dynamic>{});
        final Map<String, Object?> m =
            r is Map ? Map<String, Object?>.from(r) : <String, Object?>{};
        _qrKey = _str(m['key'], '');
        _qrContent = _str(m['url'], '');
        if (_qrContent!.isEmpty) throw Exception('上游没有返回二维码');
      }
    } catch (e) {
      _loginError = '获取二维码失败：$e';
    }
    _startingQr = false;
    notifyListeners();
  }

  /// 轮询一次扫码状态，返回 true 表示登录成功（调用方应停止轮询）。
  Future<bool> pollQrLogin() async {
    if (_qrKey.isEmpty) return false;
    try {
      if (_server == MusicServer.netease) {
        final Object? r = await online
            .neteaseLoginQrCheck(<String, dynamic>{'key': _qrKey});
        final int code = r is Map ? _int(r['code'], 800) : 800;
        _qrStatus = code;
        notifyListeners();
        if (code == 803) {
          await loadAccount();
          return true;
        }
      } else {
        final Object? r = await online
            .kugouLoginQrCheck(<String, dynamic>{'key': _qrKey});
        final int st = r is Map ? _int(r['status'], 1) : 1;
        _qrStatus = st;
        notifyListeners();
        if (st == 4) {
          await loadAccount();
          return true;
        }
      }
    } catch (e) {
      _loginError = '$e';
      notifyListeners();
      return true;
    }
    return false;
  }

  /// 二维码状态文案。两个平台的编码不同，在这里抹平。
  String get qrStatusText {
    if (_server == MusicServer.netease) {
      if (_qrStatus == 801) return '已扫码，请在手机上确认';
      if (_qrStatus == 802) return '确认中…';
      if (_qrStatus == 800 && _qrContent != null) return '请用 App 扫描二维码';
      return '请用 App 扫描二维码';
    }
    if (_qrStatus == 2) return '已扫码，请在手机上确认';
    return '请用 App 扫描二维码';
  }

  // ============================================================ 我的音乐

  /// 我创建/收藏的歌单。酷狗没有对应的公开接口，只做网易云。
  Future<void> loadMyPlaylists() async {
    if (_server != MusicServer.netease || _account == null) {
      _myPlaylists = <OnlinePlaylist>[];
      notifyListeners();
      return;
    }
    _loadingMine = true;
    notifyListeners();
    try {
      final Object? r = await online
          .neteaseUserPlaylists(<String, dynamic>{'limit': 100});
      _myPlaylists = r is List
          ? r.whereType<Map<dynamic, dynamic>>().map(_playlistFromNe).toList()
          : <OnlinePlaylist>[];
    } catch (e) {
      _myPlaylists = <OnlinePlaylist>[];
    }
    _loadingMine = false;
    notifyListeners();
  }

  Future<void> loadCloud() async {
    if (_server != MusicServer.netease || _account == null) {
      _cloud = <Track>[];
      notifyListeners();
      return;
    }
    _loadingCloud = true;
    notifyListeners();
    try {
      final Object? r = await online.neteaseCloud(<String, dynamic>{'limit': 100});
      final Object? songs = r is Map ? r['songs'] : null;
      _cloud = songs is List
          ? songs.whereType<Map<dynamic, dynamic>>().map(_trackFromNe).toList()
          : <Track>[];
    } catch (e) {
      _cloud = <Track>[];
    }
    _loadingCloud = false;
    notifyListeners();
  }

  /// 拉一次红心列表。登录后调用，用于给列表里的歌标心。
  Future<void> loadLikes() async {
    if (_server != MusicServer.netease || _account == null) return;
    final int uid = _int(_account?['userId'], 0);
    if (uid == 0) return;
    try {
      final Object? r = await online.neteaseLikelist(<String, dynamic>{'uid': uid});
      _liked = r is List
          ? r.map((Object? e) => e.toString()).toSet()
          : <String>{};
    } catch (e) {
      _liked = <String>{};
    }
    notifyListeners();
  }

  Future<void> toggleLike(Track t) async {
    final String id = t.sourceKey ?? '';
    if (id.isEmpty || _server != MusicServer.netease || _account == null) {
      return;
    }
    final bool next = !_liked.contains(id);
    try {
      await online
          .neteaseSetSongLiked(<String, dynamic>{'id': id, 'like': next});
      if (next) {
        _liked.add(id);
      } else {
        _liked.remove(id);
      }
      _notice = next ? '已加入我喜欢的音乐' : '已取消喜欢';
    } catch (e) {
      _notice = '$e';
    }
    notifyListeners();
  }

  void clearNotice() {
    _notice = null;
    notifyListeners();
  }

  // ------------------------------------------------------------ 工具

  OnlinePlaylist _playlistFromNe(Map<dynamic, dynamic> m) => OnlinePlaylist(
        server: MusicServer.netease,
        id: _str(m['id'], ''),
        name: _str(m['name'], '未命名歌单'),
        coverUrl: m['coverUrl']?.toString(),
        trackCount: _int(m['trackCount'], 0),
      );

  /// 桥接侧返回的网易云歌曲形态（{id,name,artist,album,picUrl}）转成 Track。
  /// id 约定与 music_api 一致：'netease:<songId>'。
  Track _trackFromNe(Map<dynamic, dynamic> m) {
    final String id = _str(m['id'], '');
    return Track(
      id: 'netease:$id',
      title: _str(m['name'], '未知曲目'),
      artist: _str(m['artist'], ''),
      album: _str(m['album'], ''),
      coverUrl: m['picUrl']?.toString(),
      server: MusicServer.netease,
      sourceKey: id,
    );
  }

  static String _str(Object? v, String fallback) {
    if (v == null) return fallback;
    final String s = v.toString().trim();
    return s.isEmpty ? fallback : s;
  }

  static int _int(Object? v, int fallback) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    return int.tryParse(v?.toString() ?? '') ?? fallback;
  }
}
