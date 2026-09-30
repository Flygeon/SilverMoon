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
  bool _qrExpired = false;
  bool _qrScanned = false;
  String? _loginError;
  /// 连续轮询失败次数。切后台再回来时在途请求会失败，偶发一次不算错误。
  int _pollFailures = 0;
  /// 首页请求代次：切平台后旧响应回来必须丢弃，否则会覆盖新平台的列表。
  int _homeToken = 0;

  // ---- 手机号登录 ----
  String _phone = '';
  String _smsCode = '';
  bool _sendingSms = false;
  int _smsCooldown = 0;
  bool _phoneLoggingIn = false;
  String? _phoneError;
  Timer? _smsTimer;

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
    // 每个平台的推荐 / 榜单不是同一批数据：切平台必须清空并重新拉，
    // 否则会继续显示上一个平台的内容（「切到酷狗还是网易云歌单」的成因）。
    _featured = <OnlinePlaylist>[];
    _rankings = <OnlinePlaylist>[];
    _myPlaylists = <OnlinePlaylist>[];
    _cloud = <Track>[];
    _liked = <String>{};
    _playlistTracks = <Track>[];
    _openedPlaylist = null;
    _homeToken++;
    _resetPhoneLogin();
    notifyListeners();
    // 账号与首页一起重拉；loadHome 末尾会按需再拉一次账号，两者幂等。
    unawaited(loadHome());
    if (s != MusicServer.meting) unawaited(loadAccount());
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

  /// 首页推荐 / 榜单。**按当前平台取**：网易云走官方接口，酷狗走 plist/index
  /// 与 rank/list，Meting 是聚合搜索源、没有歌单接口，保持空列表。
  Future<void> loadHome() async {
    final int token = ++_homeToken;
    final MusicServer s = _server;
    _loading = true;
    _error = null;
    notifyListeners();
    try {
      List<OnlinePlaylist> f = <OnlinePlaylist>[];
      List<OnlinePlaylist> r = <OnlinePlaylist>[];
      if (s == MusicServer.netease) {
        f = await repository.featuredPlaylists();
        r = await repository.rankings();
      } else if (s == MusicServer.kugou) {
        f = await _kugouFeaturedPlaylists();
        r = await _kugouRankings();
      }
      if (token != _homeToken) return;
      _featured = f;
      _rankings = r;
    } catch (e) {
      if (token != _homeToken) return;
      _error = '加载在线内容失败';
      _featured = <OnlinePlaylist>[];
      _rankings = <OnlinePlaylist>[];
    }
    if (token != _homeToken) return;
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
      // MusicRepository.playlistTracks 只实现了网易云 / Meting；酷狗的榜单与
      // 歌单都在桥接侧（kugouRankSongs / kugouPlaylistDetail），在这里分流。
      _playlistTracks = p.server == MusicServer.kugou
          ? await _kugouPlaylistTracks(p.id)
          : await repository.playlistTracks(p);
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
    if (!supportsAccount) {
      _loginError = '${_server.label} 是聚合搜索源，没有账号体系';
      notifyListeners();
      return;
    }
    _startingQr = true;
    _qrStatus = 0;
    _qrExpired = false;
    _qrScanned = false;
    _pollFailures = 0;
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

  /// 轮询一次扫码状态，返回 true 表示可以停止轮询（成功或不可恢复）。
  ///
  /// 单次失败**不再**终止轮询。iOS 上的真实流程是：截图二维码 → 切到官方
  /// App 扫码 → 再切回来。切走期间在途 HTTP 请求会失败，而旧实现直接在
  /// catch 里 return true，轮询就此停死 —— 这就是「授权完成返回后没触发
  /// 登录」。现在改成累计失败：连续 4 次才报错停下。
  Future<bool> pollQrLogin() async {
    if (_qrKey.isEmpty) return false;
    try {
      if (_server == MusicServer.netease) {
        final Object? r = await online
            .neteaseLoginQrCheck(<String, dynamic>{'key': _qrKey});
        final int code = r is Map ? _int(r['code'], 800) : 800;
        _qrStatus = code;
        _qrScanned = code == 802;
        _pollFailures = 0;
        if (code == 800) {
          // 二维码过期，停止轮询（对应桌面端的 timeout 分支）。
          _qrExpired = true;
          notifyListeners();
          return true;
        }
        notifyListeners();
        if (code == 803) return _finishLogin();
      } else {
        final Object? r = await online
            .kugouLoginQrCheck(<String, dynamic>{'key': _qrKey});
        final int st = r is Map ? _int(r['status'], 1) : 1;
        _qrStatus = st;
        _qrScanned = st == 2 || st == 803;
        _pollFailures = 0;
        if (st == 0 || st == 800) {
          _qrExpired = true;
          notifyListeners();
          return true;
        }
        notifyListeners();
        if (st == 4) return _finishLogin();
      }
    } catch (e) {
      _pollFailures++;
      if (_pollFailures >= 4) {
        _loginError = '网络异常：${_cleanErr(e)}';
        notifyListeners();
        return true;
      }
    }
    return false;
  }

  /// 扫码成功（803 / 4）之后：账号信息真的拿到了才算登录完成。
  Future<bool> _finishLogin() async {
    await loadAccount();
    if (_account == null) {
      // 上游偶尔延迟下发凭据，再给一次机会。
      await Future<void>.delayed(const Duration(milliseconds: 600));
      await loadAccount();
    }
    if (_account == null) {
      _loginError = '已授权，但账号信息获取失败，请重新登录';
    } else {
      _loginError = null;
    }
    notifyListeners();
    return true;
  }

  /// 二维码状态文案。两个平台编码不同，在这里抹平。
  ///
  /// 网易云走明文 weapi（type=1）：800 过期 / 801 等待 / 802 待确认。桌面端
  /// 注释写的「800 等待 / 801 已扫码」是 eapi（type=3）的语义，别照抄。
  String get qrStatusText {
    if (_qrExpired) return '二维码已过期，请点击刷新';
    if (_server == MusicServer.netease) {
      if (_qrStatus == 803) return '登录成功';
      if (_qrScanned) return '已扫码，请在手机上确认';
      return '请用「网易云音乐」App 扫描二维码';
    }
    if (_qrStatus == 4) return '登录成功';
    if (_qrScanned) return '已扫码，请在手机上确认';
    return '请用「酷狗音乐」App 扫描二维码';
  }

  bool get qrExpired => _qrExpired;

  /// 二维码过期后重新取一张。
  Future<void> refreshQr() => startQrLogin();

  // ------------------------------------------------------------ 手机号登录

  String get phone => _phone;
  int get smsCooldown => _smsCooldown;
  bool get sendingSms => _sendingSms;
  bool get phoneLoggingIn => _phoneLoggingIn;
  String? get phoneError => _phoneError;

  void setPhone(String v) {
    _phone = v;
    _phoneError = null;
    notifyListeners();
  }

  void setSmsCode(String v) {
    _smsCode = v;
    notifyListeners();
  }

  /// 发送短信验证码。两个平台接口名不同、语义一致；成功后起 60s 倒计时。
  Future<void> sendSmsCode() async {
    if (_sendingSms || _smsCooldown > 0 || !supportsAccount) return;
    final String p = _phone.trim();
    if (!RegExp(r'^\d{11}$').hasMatch(p)) {
      _phoneError = '请输入 11 位手机号';
      notifyListeners();
      return;
    }
    _phoneError = null;
    _sendingSms = true;
    notifyListeners();
    try {
      if (_server == MusicServer.netease) {
        await online.neteaseSmsCaptchaSent(
            <String, dynamic>{'phone': p, 'ctcode': '86'});
      } else {
        await online.kugouCaptchaSent(<String, dynamic>{'mobile': p});
      }
      _smsCooldown = 60;
      _smsTimer?.cancel();
      _smsTimer = Timer.periodic(const Duration(seconds: 1), (Timer t) {
        _smsCooldown--;
        if (_smsCooldown <= 0) {
          t.cancel();
          _smsTimer = null;
        }
        notifyListeners();
      });
    } catch (e) {
      _phoneError = _cleanErr(e);
    }
    _sendingSms = false;
    notifyListeners();
  }

  /// 手机号 + 验证码登录。返回 true 表示已登录。
  Future<bool> loginWithPhone() async {
    if (_phoneLoggingIn || !supportsAccount) return false;
    final String p = _phone.trim();
    final String code = _smsCode.trim();
    if (!RegExp(r'^\d{11}$').hasMatch(p)) {
      _phoneError = '请输入 11 位手机号';
      notifyListeners();
      return false;
    }
    if (code.isEmpty) {
      _phoneError = '请输入验证码';
      notifyListeners();
      return false;
    }
    _phoneError = null;
    _phoneLoggingIn = true;
    notifyListeners();
    bool ok = false;
    try {
      if (_server == MusicServer.netease) {
        await online.neteaseLoginCellphone(
            <String, dynamic>{'phone': p, 'captcha': code, 'ctcode': '86'});
      } else {
        await online.kugouLoginCellphone(
            <String, dynamic>{'mobile': p, 'code': code});
      }
      await loadAccount();
      ok = _account != null;
      if (!ok) _phoneError = '登录成功但账号信息获取失败，请重试';
    } catch (e) {
      _phoneError = _cleanErr(e);
    }
    _phoneLoggingIn = false;
    notifyListeners();
    return ok;
  }

  void _resetPhoneLogin() {
    _phone = '';
    _smsCode = '';
    _phoneError = null;
    _sendingSms = false;
    _phoneLoggingIn = false;
    _smsCooldown = 0;
    _smsTimer?.cancel();
    _smsTimer = null;
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

  // ------------------------------------------------ 酷狗首页 / 歌单 / 曲目

  /// 酷狗「推荐歌单」：m.kugou.com/plist/index 返回的是**歌单**列表，不是歌曲。
  /// id 用 encode_id（上游短链）：直接拿 specialid 请求详情页会被 301 走。
  Future<List<OnlinePlaylist>> _kugouFeaturedPlaylists() async {
    final Object? r = await online.kugouEverydayRecommend(<String, dynamic>{});
    final List<OnlinePlaylist> out = <OnlinePlaylist>[];
    for (final Map<dynamic, dynamic> m in _kgPlistInfo(r)) {
      String id = _str(m['encode_id'], '');
      // 个别条目没有短链，退回数字 specialid（那条详情页会多一次 301 跳转）。
      if (id.isEmpty) id = _str(m['specialid'], '');
      if (id.isEmpty) continue;
      out.add(OnlinePlaylist(
        server: MusicServer.kugou,
        id: id,
        name: _str(m['specialname'], '未命名歌单'),
        coverUrl: _kgCover(m['imgurl']),
        trackCount: _int(m['songcount'], 0),
        creator: _str(m['username'], ''),
      ));
    }
    return out;
  }

  /// 酷狗排行榜：mobiles.kugou.com/api/v5/rank/list 的 data.info。
  Future<List<OnlinePlaylist>> _kugouRankings() async {
    final Object? r = await online.kugouRankList(<String, dynamic>{});
    final List<OnlinePlaylist> out = <OnlinePlaylist>[];
    for (final Map<dynamic, dynamic> m in _kgRankInfo(r)) {
      final String id = _str(m['rankid'], '');
      if (id.isEmpty) continue;
      out.add(OnlinePlaylist(
        server: MusicServer.kugou,
        id: id,
        name: _str(m['rankname'], '未命名榜单'),
        coverUrl: _kgCover(m['imgurl']),
        creator: _str(m['update_frequency'], ''),
      ));
    }
    return out;
  }

  /// 酷狗歌单 / 榜单取曲。榜单 id 是纯数字（rankid），推荐歌单是短链
  /// （encode_id，见 _kugouFeaturedPlaylists），据此决定走哪个接口。
  Future<List<Track>> _kugouPlaylistTracks(String id) async {
    final bool isRank = RegExp(r'^\d+$').hasMatch(id);
    final Object? r = isRank
        ? await online.kugouRankSongs(<String, dynamic>{
            'rankCid': id,
            'rankid': id,
            'page': 1,
            'pagesize': 100,
          })
        : await online.kugouPlaylistDetail(<String, dynamic>{'id': id});
    final List<Map<dynamic, dynamic>> items =
        isRank ? _kgRankInfo(r) : _kgPlistSongs(r);
    return items.map(_trackFromKg).toList();
  }

  /// 酷狗歌曲形态（filename / hash / album_id / duration）转 Track。
  /// filename 一般是「歌手 - 歌名」，没有分隔符时整串当歌名。
  /// sourceKey 约定与 music_api.dart 的 KugouApi.search 一致：hash|hq|albumId，
  /// 播放直链要靠它（music_repository.dart 的 kugou 分支按 | 切分）。
  Track _trackFromKg(Map<dynamic, dynamic> m) {
    final String hash = _str(m['hash'], '');
    final String albumId = _str(m['album_id'], '');
    final String file = _str(m['filename'], '');
    final int sep = file.indexOf(' - ');
    String artist = sep > 0 ? file.substring(0, sep) : '';
    String title = sep > 0 ? file.substring(sep + 3) : file;
    if (title.isEmpty) title = _str(m['songname'], '未知曲目');
    if (artist.isEmpty) artist = _str(m['singername'], '');
    final int secs = _int(m['duration'], 0);
    return Track(
      id: 'kugou:$hash',
      title: title,
      artist: artist,
      album: '',
      duration: secs > 0 ? Duration(seconds: secs) : null,
      server: MusicServer.kugou,
      sourceKey: '$hash|$hash|$albumId',
    );
  }

  /// plist/index → plist.list.info（推荐歌单条目）。
  static List<Map<dynamic, dynamic>> _kgPlistInfo(Object? r) {
    if (r is! Map) return const <Map<dynamic, dynamic>>[];
    final Object? plist = r['plist'];
    if (plist is! Map) return const <Map<dynamic, dynamic>>[];
    return _kgInfo(plist['list']);
  }

  /// plist/list/<id> → list.list.info（歌单曲目）。
  static List<Map<dynamic, dynamic>> _kgPlistSongs(Object? r) {
    if (r is! Map) return const <Map<dynamic, dynamic>>[];
    return _kgInfo(r['list']);
  }

  static List<Map<dynamic, dynamic>> _kgInfo(Object? list) {
    if (list is! Map) return const <Map<dynamic, dynamic>>[];
    final Object? inner = list['list'] is Map ? list['list'] : list;
    if (inner is! Map) return const <Map<dynamic, dynamic>>[];
    final Object? info = inner['info'];
    return info is List
        ? info.whereType<Map<dynamic, dynamic>>().toList()
        : const <Map<dynamic, dynamic>>[];
  }

  /// rank/list 与 rank/song 都在 data.info 下。
  static List<Map<dynamic, dynamic>> _kgRankInfo(Object? r) {
    if (r is! Map) return const <Map<dynamic, dynamic>>[];
    final Object? data = r['data'];
    if (data is! Map) return const <Map<dynamic, dynamic>>[];
    final Object? info = data['info'];
    return info is List
        ? info.whereType<Map<dynamic, dynamic>>().toList()
        : const <Map<dynamic, dynamic>>[];
  }

  /// 酷狗封面 url 带 {size} 占位（music_api.dart 处理搜索封面时同样替换）。
  static String? _kgCover(Object? v) {
    final String s = _str(v, '');
    return s.isEmpty ? null : s.replaceAll('{size}', '240');
  }

  @override
  void dispose() {
    _smsTimer?.cancel();
    super.dispose();
  }

  static String _cleanErr(Object e) {
    final String s = e.toString();
    return s.startsWith('Exception: ') ? s.substring(11) : s;
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
