import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart';
// 只取需要的几个名字：pointycastle/export.dart 里的 Digest / Hash 会和
// package:crypto 撞名，SecureRandom 之类又和 dart:math 的 Random 同域。
import 'package:pointycastle/api.dart' show KeyParameter, ParametersWithIV;
import 'package:pointycastle/block/aes.dart' show AESEngine;
import 'package:pointycastle/block/modes/cbc.dart' show CBCBlockCipher;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';

/// 在线音源（网易云 / 酷狗）的桥接命令。
///
/// 与桌面端的差别：桌面端把登录凭据放在 Rust 侧（backend/src/netease.rs、
/// backend/src/kugou.rs），完全不进渲染进程；移动端没有 Rust 侧，凭据只能由
/// Dart 自己持有。这里落成 <appSupport>/silvermoon/online-cookies.json，按
/// provider 分桶。
///
/// 这是**明文**存储，强度低于桌面端。接受它的理由：移动端本来就没有可信执行
/// 边界（同一个 Dart 进程既能读凭据也能发请求），再包一层加密等于把钥匙和锁
/// 放一起。要真正隔离得走平台钥匙串（flutter_secure_storage），属于后续加固。
Map<String, Future<Object?> Function(Map<String, dynamic>)> buildOnlineCommands() {
  final _Online online = _Online();
  return <String, Future<Object?> Function(Map<String, dynamic>)>{
    // ---- 网易云 ----
    'netease_song_url': online.neteaseSongUrl,
    'netease_login_qr_key': online.neteaseLoginQrKey,
    'netease_login_qr_check': online.neteaseLoginQrCheck,
    'netease_account': online.neteaseAccount,
    'netease_sms_captcha_sent': online.neteaseSmsCaptchaSent,
    'netease_login_cellphone': online.neteaseLoginCellphone,
    'netease_user_playlists': online.neteaseUserPlaylists,
    'netease_playlist_detail': online.neteasePlaylistDetail,
    'netease_cloud': online.neteaseCloud,
    'netease_song_comments': online.neteaseSongComments,
    'netease_set_song_liked': online.neteaseSetSongLiked,
    'netease_likelist': online.neteaseLikelist,
    'netease_recommend_playlists': online.neteaseRecommendPlaylists,
    'netease_daily_recommend_songs': online.neteaseDailyRecommendSongs,
    'netease_personal_fm': online.neteasePersonalFm,
    'netease_logout': online.neteaseLogout,
    // ---- 酷狗 ----
    'kugou_search': online.kugouSearch,
    'kugou_song_url': online.kugouSongUrl,
    'kugou_cover': online.kugouCover,
    'kugou_rank_list': online.kugouRankList,
    'kugou_rank_songs': online.kugouRankSongs,
    'kugou_playlist_detail': online.kugouPlaylistDetail,
    'kugou_everyday_recommend': online.kugouEverydayRecommend,
    'kugou_login_status': online.kugouLoginStatus,
    'kugou_login_qr_key': online.kugouLoginQrKey,
    'kugou_login_qr_check': online.kugouLoginQrCheck,
    'kugou_captcha_sent': online.kugouCaptchaSent,
    'kugou_login_cellphone': online.kugouLoginCellphone,
    'kugou_sign_in': online.kugouSignIn,
    'kugou_account': online.kugouAccount,
    'kugou_logout': online.kugouLogout,
  };
}

// --------------------------------------------------------------------- 工具

String _s(Object? v, [String fallback = '']) {
  if (v == null) return fallback;
  final String t = '$v';
  return t.isEmpty ? fallback : t;
}

int _i(Object? v, [int fallback = 0]) {
  if (v is int) return v;
  if (v is num) return v.toInt();
  if (v is String) return int.tryParse(v) ?? fallback;
  return fallback;
}

/// Set-Cookie 解析。
///
/// http 包会把多个 Set-Cookie 合并成一个逗号分隔的串，而 Expires 属性本身
/// 也含逗号（Wed, 01 Jan 2025 ...），直接 split(',') 会把日期切碎。
/// 这里改成"从整串里抽 name=value 对，再滤掉属性名"，对两种情形都成立。
const Set<String> _cookieAttrs = <String>{
  'expires', 'path', 'domain', 'max-age', 'secure', 'httponly', 'samesite',
  'version', 'comment',
};

// ------------------------------------------------------------- 凭据与请求层

class _CookieJar {
  _CookieJar(this._file);

  final File _file;
  final Map<String, Map<String, String>> _buckets =
      <String, Map<String, String>>{};
  bool _loaded = false;

  Future<void> ensure() async {
    if (_loaded) return;
    _loaded = true;
    try {
      if (await _file.exists()) {
        final Object? raw = jsonDecode(await _file.readAsString());
        if (raw is Map) {
          raw.forEach((Object? k, Object? v) {
            if (k is String && v is Map) {
              _buckets[k] = v.map(
                (Object? a, Object? b) => MapEntry<String, String>('$a', '$b'),
              );
            }
          });
        }
      }
    } catch (e) {
      debugPrint('在线凭据读取失败: $e');
    }
  }

  Map<String, String> bucket(String provider) =>
      _buckets.putIfAbsent(provider, () => <String, String>{});

  String header(String provider) {
    final Map<String, String> b = _buckets[provider] ?? const <String, String>{};
    if (b.isEmpty) return '';
    return b.entries
        .map((MapEntry<String, String> e) => '${e.key}=${e.value}')
        .join('; ');
  }

  void absorb(String provider, String? raw) {
    if (raw == null || raw.isEmpty) return;
    final Map<String, String> b = bucket(provider);
    final RegExp re = RegExp(r'([A-Za-z0-9_\-]+)=([^;,]+)');
    for (final RegExpMatch m in re.allMatches(raw)) {
      final String name = m.group(1) ?? '';
      final String value = (m.group(2) ?? '').trim();
      if (name.isEmpty || _cookieAttrs.contains(name.toLowerCase())) continue;
      b[name] = value;
    }
  }

  void clear(String provider) => _buckets[provider] = <String, String>{};

  Future<void> save() async {
    try {
      await _file.parent.create(recursive: true);
      await _file.writeAsString(jsonEncode(_buckets));
    } catch (e) {
      debugPrint('在线凭据写入失败: $e');
    }
  }
}

class _Online {
  static const Duration _timeout = Duration(seconds: 20);

  static const String _ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  Future<_CookieJar>? _jarFuture;

  /// 凭据文件要等 path_provider 就绪才能定位，所以整体延迟到第一次请求。
  /// 用 Future 缓存而不是 bool 标志，避免并发请求各建一个 jar。
  Future<_CookieJar> get _cookies => _jarFuture ??= _openJar();

  static Future<_CookieJar> _openJar() async {
    final Directory dir = await getApplicationSupportDirectory();
    final _CookieJar jar =
        _CookieJar(File('${dir.path}/silvermoon/online-cookies.json'));
    await jar.ensure();
    return jar;
  }

  Future<http.Response> _send(
    String provider,
    String method,
    Uri uri, {
    required String referer,
    Map<String, String>? form,
    Map<String, String>? extraHeaders,
    String? jsonBody,
  }) async {
    final _CookieJar jar = await _cookies;
    final Map<String, String> headers = <String, String>{
      'User-Agent': _ua,
      'Referer': referer,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      if (jar.header(provider).isNotEmpty) 'Cookie': jar.header(provider),
      ...?extraHeaders,
    };
    http.Response res;
    if (method == 'POST') {
      if (jsonBody != null) {
        // 酷狗 android 接口的 body 是 JSON，且签名原文包含它的精确文本，
        // 所以这里必须原样发送，不能让 http 包再编码一次。
        headers['Content-Type'] = 'application/json; charset=utf-8';
        res = await http
            .post(uri, headers: headers, body: utf8.encode(jsonBody))
            .timeout(_timeout);
      } else {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        res = await http
            .post(uri, headers: headers, body: form ?? <String, String>{})
            .timeout(_timeout);
      }
    } else {
      res = await http.get(uri, headers: headers).timeout(_timeout);
    }
    jar.absorb(provider, res.headers['set-cookie']);
    return res;
  }

  Object? _decode(http.Response res) {
    if (res.bodyBytes.isEmpty) return null;
    final String text = utf8.decode(res.bodyBytes, allowMalformed: true);
    try {
      return jsonDecode(text);
    } catch (_) {
      throw Exception('上游返回了非 JSON 内容（HTTP ${res.statusCode}）');
    }
  }

  Map<String, dynamic> _decodeMap(http.Response res) {
    final Object? json = _decode(res);
    if (json is Map<String, dynamic>) return json;
    if (json is Map) return json.cast<String, dynamic>();
    throw Exception('上游返回了非对象 JSON');
  }

  // ------------------------------------------------------------- 网易云

  Future<Map<String, dynamic>> _neGet(
    String path, [
    Map<String, String>? query,
  ]) async {
    final Map<String, String> q = <String, String>{...?query};
    final String csrf = (await _cookies).bucket('netease')['__csrf'] ?? '';
    if (csrf.isNotEmpty) q.putIfAbsent('csrf_token', () => csrf);
    final http.Response res = await _send(
      'netease',
      'GET',
      Uri.https('music.163.com', path, q.isEmpty ? null : q),
      referer: 'https://music.163.com/',
    );
    return _decodeMap(res);
  }

  Future<Map<String, dynamic>> _nePost(
    String path,
    Map<String, String> form,
  ) async {
    final Map<String, String> body = <String, String>{...form};
    final String csrf = (await _cookies).bucket('netease')['__csrf'] ?? '';
    if (csrf.isNotEmpty) body.putIfAbsent('csrf_token', () => csrf);
    final http.Response res = await _send(
      'netease',
      'POST',
      Uri.https('music.163.com', path),
      referer: 'https://music.163.com/',
      form: body,
    );
    return _decodeMap(res);
  }

  /// 网易云歌曲条目归一化。新接口用 ar/al，老接口用 artists/album。
  Map<String, Object?> _neSong(Map<dynamic, dynamic> m) {
    final List<dynamic> ars = (m['ar'] as List<dynamic>?) ??
        (m['artists'] as List<dynamic>?) ??
        const <dynamic>[];
    final String artist = ars
        .whereType<Map<dynamic, dynamic>>()
        .map((Map<dynamic, dynamic> a) => _s(a['name']))
        .where((String s) => s.isNotEmpty)
        .join(' / ');
    final Object? album = m['al'] ?? m['album'];
    final String albumName = album is Map ? _s(album['name']) : '';
    final String pic = album is Map ? _s(album['picUrl']) : '';
    return <String, Object?>{
      'id': _i(m['id']),
      'name': _s(m['name']),
      'artist': artist,
      'album': albumName.isEmpty ? null : albumName,
      'picUrl': pic.isEmpty ? null : pic,
    };
  }

  List<Map<String, Object?>> _neComments(Object? raw) {
    if (raw is! List) return <Map<String, Object?>>[];
    return raw.whereType<Map<dynamic, dynamic>>().map((Map<dynamic, dynamic> c) {
      final Object? u = c['user'];
      final Map<String, Object?> user = u is Map
          ? <String, Object?>{
              'userId': _i(u['userId']),
              'nickname': _s(u['nickname']),
              'avatarUrl': _s(u['avatarUrl']),
              'vipType': _i(u['vipType']),
            }
          : <String, Object?>{};
      return <String, Object?>{
        'commentId': _i(c['commentId']),
        'content': _s(c['content']),
        'time': _i(c['time']),
        'likedCount': _i(c['likedCount']),
        'liked': c['liked'] == true,
        'user': user,
        'ipLocation': c['ipLocation'],
      };
    }).toList();
  }

  /// 播放地址。enhance 接口对无版权曲目返回空 url，此时回退到 outer 直链
  /// （它对能播的曲目会 302 到真实地址，对不能播的返回一个很短的占位音频）。
  Future<Object?> neteaseSongUrl(Map<String, dynamic> args) async {
    final List<dynamic> ids =
        (args['ids'] as List<dynamic>?) ?? const <dynamic>[];
    if (ids.isEmpty) return <Map<String, Object?>>[];
    final String list = ids.map((Object? e) => '${_i(e)}').join(',');
    final Map<String, dynamic> json = await _neGet(
      '/api/song/enhance/player/url',
      <String, String>{'ids': '[$list]', 'br': '320000'},
    );
    final List<dynamic> data =
        (json['data'] as List<dynamic>?) ?? const <dynamic>[];
    final Map<int, String> resolved = <int, String>{};
    for (final dynamic item in data) {
      if (item is! Map) continue;
      resolved[_i(item['id'])] = _s(item['url']);
    }
    final List<Map<String, Object?>> out = <Map<String, Object?>>[];
    for (final dynamic raw in ids) {
      final int id = _i(raw);
      String url = resolved[id] ?? '';
      if (url.isEmpty) {
        url = 'https://music.163.com/song/media/outer/url?id=$id.mp3';
      }
      out.add(<String, Object?>{'id': id, 'url': url});
    }
    return out;
  }

  Future<Object?> neteaseLoginQrKey(Map<String, dynamic> args) async {
    final Map<String, dynamic> json =
        await _nePost('/api/login/qrcode/unikey', <String, String>{'type': '1'});
    final String key = _s(json['unikey']);
    if (key.isEmpty) {
      throw Exception('获取二维码失败：${_s(json['message'], '上游未返回 unikey')}');
    }
    return key;
  }

  /// 扫码轮询。800 等待 / 801 已扫码 / 802 确认中 / 803 成功。
  /// 803 时上游会下发 MUSIC_U，已在 _send 里吸收，这里负责落盘。
  Future<Object?> neteaseLoginQrCheck(Map<String, dynamic> args) async {
    final String key = _s(args['key']);
    if (key.isEmpty) throw Exception('缺少二维码 key');
    final Map<String, dynamic> json = await _nePost(
      '/api/login/qrcode/client/login',
      <String, String>{'key': key, 'type': '1'},
    );
    final int code = _i(json['code'], 800);
    if (code == 803) await (await _cookies).save();
    return <String, Object?>{
      'code': code,
      'nickname': json['nickname'],
      'avatarUrl': json['avatarUrl'],
    };
  }

  Future<Object?> neteaseAccount(Map<String, dynamic> args) async {
    final Map<String, dynamic> json = await _neGet('/api/nuser/account/get');
    final Object? profile = json['profile'];
    if (profile is! Map) return null;
    return <String, Object?>{
      'userId': _i(profile['userId']),
      'nickname': _s(profile['nickname']),
      'avatarUrl': _s(profile['avatarUrl']),
    };
  }

  Future<Object?> neteaseSmsCaptchaSent(Map<String, dynamic> args) async {
    final String phone = _s(args['phone']);
    if (phone.isEmpty) throw Exception('缺少手机号');
    final String ctcode = _s(args['ctcode'], '86');
    final Map<String, dynamic> json = await _nePost(
      '/api/sms/captcha/sent',
      <String, String>{'cellphone': phone, 'ctcode': ctcode},
    );
    if (_i(json['code']) != 200) {
      throw Exception('验证码发送失败：${_s(json['message'], '未知错误')}');
    }
    return null;
  }

  Future<Object?> neteaseLoginCellphone(Map<String, dynamic> args) async {
    final Map<String, dynamic> json = await _nePost(
      '/api/login/cellphone',
      <String, String>{
        'phone': _s(args['phone']),
        'captcha': _s(args['captcha']),
        'countrycode': _s(args['ctcode'], '86'),
        'rememberLogin': 'true',
      },
    );
    if (_i(json['code']) != 200) {
      throw Exception('登录失败：${_s(json['message'], '未知错误')}');
    }
    await (await _cookies).save();
    return neteaseAccount(<String, dynamic>{});
  }

  Future<Object?> neteaseUserPlaylists(Map<String, dynamic> args) async {
    final Map<String, dynamic> json = await _neGet('/api/user/playlist', <String, String>{
      'offset': '${_i(args['offset'])}',
      'limit': '${_i(args['limit'], 100)}',
    });
    final List<dynamic> list =
        (json['playlist'] as List<dynamic>?) ?? const <dynamic>[];
    return list.whereType<Map<dynamic, dynamic>>().map((Map<dynamic, dynamic> m) {
      return <String, Object?>{
        'id': _i(m['id']),
        'name': _s(m['name']),
        'coverUrl': _s(m['coverImgUrl']),
        'trackCount': _i(m['trackCount']),
      };
    }).toList();
  }

  Future<Object?> neteasePlaylistDetail(Map<String, dynamic> args) async {
    final Map<String, dynamic> json = await _neGet('/api/v6/playlist/detail', <String, String>{
      'id': '${_i(args['id'])}',
      'n': '1000',
    });
    final Object? pl = json['playlist'];
    if (pl is! Map) return <Object?>[];
    final List<dynamic> tracks =
        (pl['tracks'] as List<dynamic>?) ?? const <dynamic>[];
    return tracks
        .whereType<Map<dynamic, dynamic>>()
        .map(_neSong)
        .toList();
  }

  Future<Object?> neteaseCloud(Map<String, dynamic> args) async {
    final Map<String, dynamic> json = await _neGet('/api/v1/cloud', <String, String>{
      'offset': '${_i(args['offset'])}',
      'limit': '${_i(args['limit'], 50)}',
    });
    final List<dynamic> data =
        (json['data'] as List<dynamic>?) ?? const <dynamic>[];
    return <String, Object?>{
      'songs': data.whereType<Map<dynamic, dynamic>>().map(_neSong).toList(),
      'hasMore': json['hasMore'] == true,
      'count': _i(json['count']),
    };
  }

  Future<Object?> neteaseSongComments(Map<String, dynamic> args) async {
    final int id = _i(args['id']);
    final Map<String, dynamic> json = await _neGet(
      '/api/v1/resource/comments/R_SO_4_$id',
      <String, String>{
        'offset': '${_i(args['offset'])}',
        'limit': '${_i(args['limit'], 20)}',
      },
    );
    return <String, Object?>{
      'total': _i(json['total']),
      'more': json['more'] == true,
      'comments': _neComments(json['comments']),
      'hotComments': _neComments(json['hotComments']),
    };
  }

  Future<Object?> neteaseSetSongLiked(Map<String, dynamic> args) async {
    final Map<String, dynamic> json = await _neGet('/api/radio/like', <String, String>{
      'trackId': '${_i(args['id'])}',
      'like': args['like'] == true ? 'true' : 'false',
      'alg': 'itembased',
      'time': '3',
    });
    if (_i(json['code']) != 200) {
      throw Exception('操作失败：${_s(json['message'], '未知错误')}');
    }
    return null;
  }

  Future<Object?> neteaseLikelist(Map<String, dynamic> args) async {
    final Map<String, dynamic> json = await _neGet('/api/song/like/get', <String, String>{
      'uid': '${_i(args['uid'])}',
    });
    final List<dynamic> ids =
        (json['ids'] as List<dynamic>?) ?? const <dynamic>[];
    return ids.map((Object? e) => _i(e)).toList();
  }

  Future<Object?> neteaseRecommendPlaylists(Map<String, dynamic> args) async {
    final Map<String, dynamic> json = await _neGet('/api/personalized/playlist', <String, String>{
      'limit': '${_i(args['limit'], 20)}',
    });
    final List<dynamic> result =
        (json['result'] as List<dynamic>?) ?? const <dynamic>[];
    return result.whereType<Map<dynamic, dynamic>>().map((Map<dynamic, dynamic> m) {
      return <String, Object?>{
        'id': _i(m['id']),
        'name': _s(m['name']),
        'picUrl': _s(m['picUrl']),
        'playCount': _i(m['playCount']),
        'copywriter': _s(m['copywriter']),
      };
    }).toList();
  }

  Future<Object?> neteaseDailyRecommendSongs(Map<String, dynamic> args) async {
    final Map<String, dynamic> json =
        await _neGet('/api/discovery/recommend/songs');
    final Object? data = json['data'];
    final List<dynamic> daily = data is Map
        ? ((data['dailySongs'] as List<dynamic>?) ?? const <dynamic>[])
        : const <dynamic>[];
    return daily.whereType<Map<dynamic, dynamic>>().map(_neSong).toList();
  }

  Future<Object?> neteasePersonalFm(Map<String, dynamic> args) async {
    final Map<String, dynamic> json = await _neGet('/api/radio/get');
    final List<dynamic> data =
        (json['data'] as List<dynamic>?) ?? const <dynamic>[];
    return data.whereType<Map<dynamic, dynamic>>().map(_neSong).toList();
  }

  Future<Object?> neteaseLogout(Map<String, dynamic> args) async {
    try {
      await _neGet('/api/logout');
    } catch (e) {
      // 上游偶尔 4xx；本地凭据该清还是要清，不能因为一次失败就退不出去
      debugPrint('网易云登出请求失败: $e');
    }
    final _CookieJar jar = await _cookies;
    jar.clear('netease');
    await jar.save();
    return null;
  }

  // --------------------------------------------------------------- 酷狗

  Future<Object?> kugouSearch(Map<String, dynamic> args) async {
    final http.Response res = await _send(
      'kugou',
      'GET',
      Uri.https('songsearch.kugou.com', '/song_search_v2', <String, String>{
        'keyword': _s(args['keyword']),
        'page': '${_i(args['page'], 1)}',
        'pagesize': '${_i(args['pagesize'], 30)}',
        'showtype': '0',
        'filter': '10',
      }),
      referer: 'https://www.kugou.com/',
    );
    // 上游存在新旧两套字段形态，归一化统一由前端 utils/kugou.ts 负责
    return _decode(res);
  }

  Future<Object?> kugouSongUrl(Map<String, dynamic> args) async {
    final String hash = _s(args['hash']);
    if (hash.isEmpty) throw Exception('缺少 hash');
    final String albumId = _s(args['albumId']);
    final String albumAudioId = _s(args['albumAudioId']);
    final http.Response res = await _send(
      'kugou',
      'GET',
      Uri.https('wwwapi.kugou.com', '/yy/index.php', <String, String>{
        'r': 'play/getdata',
        'hash': hash,
        if (albumId.isNotEmpty) 'album_id': albumId,
        if (albumAudioId.isNotEmpty) 'album_audio_id': albumAudioId,
      }),
      referer: 'https://www.kugou.com/',
    );
    final Map<String, dynamic> json = _decodeMap(res);
    final Object? data = json['data'];
    final String url = data is Map ? _s(data['play_url']) : '';
    if (url.isEmpty) {
      // 上游只给 status=0 / err_code=30020（版权或会员限制）。
      // 抛出去让前端回退到 Meting，比返回空 URL 更容易定位。
      throw Exception('酷狗未返回播放地址（可能无版权或需要会员）');
    }
    final int bitrate = data is Map ? _i(data['bitrate']) : 0;
    final String quality =
        bitrate >= 900 ? 'flac' : (bitrate >= 256 ? '320' : '128');
    return <String, Object?>{
      'url': url,
      'quality': quality,
      'trial': false,
    };
  }

  /// 酷狗图床不返回 CORS 头，WebView 直连 fetch 会被拦，所以在这里转成 dataURL。
  Future<Object?> kugouCover(Map<String, dynamic> args) async {
    final String url = _s(args['url']);
    if (url.isEmpty) return '';
    try {
      final http.Response res = await http.get(
        Uri.parse(url),
        headers: <String, String>{'User-Agent': _ua, 'Referer': 'https://www.kugou.com/'},
      ).timeout(_timeout);
      if (res.statusCode != 200 || res.bodyBytes.isEmpty) return '';
      final String mime =
          res.headers['content-type']?.split(';').first ?? 'image/jpeg';
      return 'data:$mime;base64,${base64Encode(res.bodyBytes)}';
    } catch (e) {
      debugPrint('酷狗封面代理失败: $e');
      return '';
    }
  }

  /// 排行榜列表。上游 v5 接口返回 data.info[]，字段归一化交给前端。
  Future<Object?> kugouRankList(Map<String, dynamic> args) async {
    final http.Response res = await _send(
      'kugou',
      'GET',
      Uri.https('mobiles.kugou.com', '/api/v5/rank/list', <String, String>{
        'json': 'true',
        'page': '1',
        'pagesize': '100',
      }),
      referer: 'https://www.kugou.com/',
    );
    return _decode(res);
  }

  Future<Object?> kugouRankSongs(Map<String, dynamic> args) async {
    final http.Response res = await _send(
      'kugou',
      'GET',
      Uri.https('mobiles.kugou.com', '/api/v5/rank/song', <String, String>{
        'json': 'true',
        'rankid': _s(args['rankCid']),
        'page': '${_i(args['page'], 1)}',
        'pagesize': '${_i(args['pagesize'], 30)}',
      }),
      referer: 'https://www.kugou.com/',
    );
    return _decode(res);
  }

  Future<Object?> kugouPlaylistDetail(Map<String, dynamic> args) async {
    final String id = _s(args['id']);
    if (id.isEmpty) throw Exception('缺少歌单 id');
    final http.Response res = await _send(
      'kugou',
      'GET',
      Uri.parse('https://m.kugou.com/plist/list/$id?json=true'),
      referer: 'https://m.kugou.com/',
    );
    return _decode(res);
  }

  /// 每日推荐。上游 everydayrec 域名在部分网络下不可达，这里退到
  /// m.kugou.com 的推荐歌单列表（返回歌单而非歌曲，前端按歌单渲染）。
  Future<Object?> kugouEverydayRecommend(Map<String, dynamic> args) async {
    final http.Response res = await _send(
      'kugou',
      'GET',
      Uri.parse('https://m.kugou.com/plist/index?json=true'),
      referer: 'https://m.kugou.com/',
    );
    return _decode(res);
  }

  List<String> _signedDays(_CookieJar jar) {
    final String raw = jar.bucket('kugou-signin')['days'] ?? '';
    if (raw.isEmpty) return <String>[];
    return raw.split(',');
  }

  Map<String, Object?> _kugouProfile(_CookieJar jar) {
    final Map<String, String> b = jar.bucket('kugou');
    String nickname = b['nickname'] ?? '';
    try {
      nickname = Uri.decodeComponent(nickname);
    } catch (_) {
      // 上游没编码过就原样用
    }
    return <String, Object?>{
      'userid': _i(b['userid']),
      'nickname': nickname,
      'avatar': '',
      'vipType': _i(b['vip_type']),
    };
  }

  bool _kugouLoggedIn(_CookieJar jar) {
    final Map<String, String> b = jar.bucket('kugou');
    return _s(b['token']).isNotEmpty && _s(b['userid']).isNotEmpty;
  }

  Future<Object?> kugouLoginStatus(Map<String, dynamic> args) async {
    final _CookieJar jar = await _cookies;
    final bool loggedIn = _kugouLoggedIn(jar);
    return <String, Object?>{
      'loggedIn': loggedIn,
      'profile': loggedIn ? _kugouProfile(jar) : null,
      'signedDays': _signedDays(jar),
    };
  }

  /// 二维码 key 与内容。参数取自桌面端 vendored 的 kugou_server crate
  /// （backend/kugou_server/src/modules/login.rs 的 handle_qr_key）。
  Future<Object?> kugouLoginQrKey(Map<String, dynamic> args) async {
    final http.Response res = await _send(
      'kugou',
      'GET',
      Uri.https('login-user.kugou.com', '/v2/qrcode', <String, String>{
        'appid': '1001',
        'type': '1',
        'plat': '4',
        'qrcode_txt': 'https://h5.kugou.com/apps/loginQRCode/html/index.html?appid=3116&',
        'srcappid': '2919',
      }),
      referer: 'https://www.kugou.com/',
    );
    final Map<String, dynamic> json = _decodeMap(res);
    final Object? data = json['data'];
    final String key = data is Map ? _s(data['qrcode']) : '';
    if (key.isEmpty) {
      throw Exception('获取酷狗二维码失败（error_code=${_i(json['error_code'])}）');
    }
    return <String, Object?>{
      'key': key,
      'url': 'https://h5.kugou.com/apps/loginQRCode/html/index.html?qrcode=$key',
    };
  }

  /// 扫码轮询。status: 1 等待 / 2 已扫码 / 4 成功 / 0 过期。
  Future<Object?> kugouLoginQrCheck(Map<String, dynamic> args) async {
    final String key = _s(args['key']);
    if (key.isEmpty) throw Exception('缺少二维码 key');
    final http.Response res = await _send(
      'kugou',
      'GET',
      Uri.https('login-user.kugou.com', '/v2/get_userinfo_qrcode', <String, String>{
        'plat': '4',
        'appid': '3116',
        'srcappid': '2919',
        'qrcode': key,
      }),
      referer: 'https://www.kugou.com/',
    );
    final Map<String, dynamic> json = _decodeMap(res);
    final Object? data = json['data'];
    final int status = data is Map ? _i(data['status']) : 0;
    final _CookieJar jar = await _cookies;
    if (status == 4 && data is Map) {
      final Map<String, String> b = jar.bucket('kugou');
      b['token'] = _s(data['token']);
      b['userid'] = _s(data['userid']);
      if (_s(data['vip_token']).isNotEmpty) b['vip_token'] = _s(data['vip_token']);
      if (data['vip_type'] != null) b['vip_type'] = _s(data['vip_type']);
      await jar.save();
    }
    final bool loggedIn = _kugouLoggedIn(jar);
    return <String, Object?>{
      'status': status,
      'loggedIn': loggedIn,
      'profile': loggedIn ? _kugouProfile(jar) : null,
    };
  }

  // ── 酷狗 android 端签名 ─────────────────────────────────────────────
  //
  // 桌面端这三个命令由 vendored 的 kugou_server 以 android 模式发出。先前判断
  // 「移动端做不了」是错的，错在两处：
  //   1. mid 不是注册来的。device.rs:49 init_device_info() 本地生成 guid
  //      （util.rs:221 getGuid），再 mid = md5(guid) 当大整数转十进制
  //      （util.rs:216 / crypto.rs:262）。全程无网络、无加密。
  //   2. android 模式**不加密 body**。request.rs:520-537 只做两件事：给参数加一个
  //      signature，再补 dfid/clienttime/mid 三个头。body 是明文 JSON。
  //
  // 所以 captcha_sent 与 sign_in 可以完整移植。真正需要 AES/RSA 的只有
  // login_cellphone（login.rs:143 aes_hex + login.rs:187 rsa_pk），见下。

  /// helper.rs:4 概念版盐值。
  static const String _kgRoute = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA';

  static final Random _kgRng = Random();

  /// util.rs:35 random_guid_part：((65536*(1+rand))|0).toString(16).substring(1)。
  /// 取值落在 65536..131071，十六进制是 5 位，砍掉首位正好 4 位。
  static String _kgGuidPart() =>
      (65536 + _kgRng.nextInt(65536)).toRadixString(16).substring(1);

  /// util.rs:221 getGuid：八段拼成 UUID 形状。
  static String _kgGuid() {
    final String a = _kgGuidPart();
    final String b = _kgGuidPart();
    final String c = _kgGuidPart();
    final String d = _kgGuidPart();
    final String e = _kgGuidPart();
    final String f = _kgGuidPart();
    final String g = _kgGuidPart();
    final String h = _kgGuidPart();
    return '$a$b-$c-$d-$e-$f$g$h';
  }

  /// util.rs:216 calculateMid：md5 hex 当大整数读，再转十进制字符串。
  static String _kgMidOf(String guid) => BigInt.parse(
        md5.convert(utf8.encode(guid)).toString(),
        radix: 16,
      ).toString();

  /// 设备身份要跨启动稳定，否则每次冷启动都是一个新设备。
  Future<String> _kgMid(_CookieJar jar) async {
    final Map<String, String> b = jar.bucket('kugou-device');
    String mid = _s(b['mid']);
    if (mid.isEmpty) {
      final String guid = _s(b['guid']).isEmpty ? _kgGuid() : _s(b['guid']);
      b['guid'] = guid;
      mid = _kgMidOf(guid);
      b['mid'] = mid;
      await jar.save();
    }
    return mid;
  }

  /// helper.rs:13 params_joined_sorted：按键排序后拼 key=value，无分隔符。
  static String _kgJoinSorted(Map<String, Object?> params) {
    final List<String> keys = params.keys.toList()..sort();
    return keys.map((String k) {
      final Object? v = params[k];
      final String vs = (v is Map || v is List) ? _kgJson(v) : '$v';
      return '$k=$vs';
    }).join();
  }

  /// 复刻 serde_json 的紧凑输出。kugou_server 刻意没开 preserve_order
  /// （Cargo.toml:11），所以 Value::Object 是 BTreeMap，键是**排序**的；
  /// Dart 的 Map 保持插入顺序，不显式排序就会拼出不同的签名原文。
  static String _kgJson(Object? v) {
    if (v is Map) {
      final List<String> keys = v.keys.map((Object? k) => '$k').toList()..sort();
      return '{' +
          keys.map((String k) => '${jsonEncode(k)}:${_kgJson(v[k])}').join(',') +
          '}';
    }
    if (v is List) return '[' + v.map(_kgJson).join(',') + ']';
    return jsonEncode(v);
  }

  /// helper.rs:35 signature_android_params：md5(ROUTE + 排序参数 + body + ROUTE)。
  static String _kgSign(Map<String, Object?> params, String body) => md5
      .convert(utf8.encode('$_kgRoute${_kgJoinSorted(params)}$body$_kgRoute'))
      .toString();

  /// 以 android 模式发一个酷狗网关请求。
  ///
  /// 参数进 query（request.rs:343 serialize_params），body 单独发 JSON
  /// （request.rs:67 用 json_stringify 序列化）。
  Future<Map<String, dynamic>> _kgAndroid(
    String path,
    Map<String, Object?> params, {
    Map<String, Object?>? body,
    String host = 'gateway.kugou.com',
    Map<String, String>? headers,
  }) async {
    final _CookieJar jar = await _cookies;
    final Map<String, String> ck = jar.bucket('kugou');
    final String mid = await _kgMid(jar);
    final String dfid = _s(ck['dfid']);
    final String token = _s(ck['token']);
    final int userid = _i(ck['userid']);
    final int clienttime = DateTime.now().millisecondsSinceEpoch ~/ 1000;

    // request.rs:466-494：默认参数在前，请求参数覆盖在后。
    final Map<String, Object?> signed = <String, Object?>{
      'dfid': dfid,
      'mid': mid,
      'uuid': '-',
      'appid': 3116,
      'clientver': 11440,
      'clienttime': clienttime,
      if (token.isNotEmpty) 'token': token,
      if (userid != 0) 'userid': userid,
      ...params,
    };
    final String bodyText = body == null ? '' : _kgJson(body);
    signed['signature'] = _kgSign(signed, bodyText);

    final http.Response res = await _send(
      'kugou',
      'POST',
      Uri.https(
        host,
        path,
        signed.map((String k, Object? v) => MapEntry<String, String>(k, '$v')),
      ),
      referer: 'https://www.kugou.com/',
      extraHeaders: <String, String>{
        'mid': mid,
        'dfid': dfid,
        'clienttime': '$clienttime',
        ...?headers,
      },
      jsonBody: bodyText.isEmpty ? null : bodyText,
    );
    return _decodeMap(res);
  }

  static String _kgError(Map<String, dynamic> json, String fallback) {
    final String msg = _s(json['error_msg']);
    return msg.isEmpty ? fallback : msg;
  }

  /// 北京时间的日期，签到接口按天判定。
  static String _chinaDate() {
    final DateTime t = DateTime.now().toUtc().add(const Duration(hours: 8));
    final String m = t.month.toString().padLeft(2, '0');
    final String d = t.day.toString().padLeft(2, '0');
    return '${t.year}-$m-$d';
  }

  /// 发送手机短信验证码。misc.rs:136 → POST /v7/send_mobile_code，
  /// body {businessid:5, mobile, plat:3}，cookie 清空后只留 mid（misc.rs:142-147）。
  Future<Object?> kugouCaptchaSent(Map<String, dynamic> args) async {
    final String mobile = _s(args['mobile']);
    if (mobile.isEmpty) throw Exception('缺少手机号');
    final Map<String, dynamic> json = await _kgAndroid(
      '/v7/send_mobile_code',
      const <String, Object?>{},
      body: <String, Object?>{'businessid': 5, 'mobile': mobile, 'plat': 3},
    );
    final int code = _i(json['error_code'], -1);
    if (_i(json['status']) != 1 && code != 0) {
      throw Exception('验证码发送失败：${_kgError(json, '未知错误')}');
    }
    return null;
  }

  // ── 酷狗登录用的 AES / RSA（crypto.rs 的 Dart 版）────────────────────
  //
  // 手机号登录是唯一一条真正需要加密层的接口：login.rs:143 先用 AES-CBC 加密
  // {mobile, code}，login.rs:187 再用 RSA 把那个 AES 密钥送上去。其余酷狗命令
  // 都只有 md5 签名（见上面的 _kgSign）。

  /// crypto.rs:67 aes_cbc_encrypt：PKCS7 填充，按 key 长度选 AES-128/192/256。
  /// 注意 crypto.rs:292 里 key/iv 是按 **UTF-8 字节**用的，不是十六进制解码。
  static String _kgAesCbcHex(String key, String iv, String data) {
    final Uint8List keyBytes = Uint8List.fromList(utf8.encode(key));
    final Uint8List ivBytes = Uint8List.fromList(utf8.encode(iv));
    final Uint8List plain = Uint8List.fromList(utf8.encode(data));

    // crypto.rs:76-79：pad = bs - (len % bs)，正好整块时补满一整块。
    final int pad = 16 - (plain.length % 16);
    final Uint8List padded = Uint8List(plain.length + pad)
      ..setRange(0, plain.length, plain)
      ..fillRange(plain.length, plain.length + pad, pad);

    final CBCBlockCipher cbc = CBCBlockCipher(AESEngine())
      ..init(
        true,
        ParametersWithIV<KeyParameter>(KeyParameter(keyBytes), ivBytes),
      );
    final Uint8List out = Uint8List(padded.length);
    for (int off = 0; off < padded.length; off += 16) {
      cbc.processBlock(padded, off, out, off);
    }
    return _kgHex(out);
  }

  /// crypto.rs:103 aes_cbc_decrypt + PKCS7 去填充。
  static Uint8List _kgAesCbcDecrypt(String key, String iv, Uint8List ct) {
    final CBCBlockCipher cbc = CBCBlockCipher(AESEngine())
      ..init(
        false,
        ParametersWithIV<KeyParameter>(
          KeyParameter(Uint8List.fromList(utf8.encode(key))),
          Uint8List.fromList(utf8.encode(iv)),
        ),
      );
    final Uint8List out = Uint8List(ct.length);
    for (int off = 0; off < ct.length; off += 16) {
      cbc.processBlock(ct, off, out, off);
    }
    if (out.isEmpty) return out;
    final int pad = out[out.length - 1];
    if (pad < 1 || pad > 16 || pad > out.length) return out;
    return Uint8List.sublistView(out, 0, out.length - pad);
  }

  /// crypto.rs:292 crypto_aes_encrypt(data, None, None)：随机 16 位 tempKey，
  /// key = md5(tempKey)[..32]，iv = key 末 16 位。密钥要跟着请求一起送上去，
  /// 因为上游回传的 secu_params 是用同一个密钥加密的。
  static ({String hex, String key}) _kgAesRandom(String data) {
    final String tk = _kgRandomLower16();
    final String md = md5.convert(utf8.encode(tk)).toString();
    final String key = md.substring(0, 32);
    final String iv = key.substring(key.length - 16);
    return (hex: _kgAesCbcHex(key, iv, data), key: tk);
  }

  /// crypto.rs:315 crypto_aes_decrypt(data_hex, key, None)：key 先 md5 再取前 32 位。
  static Object? _kgAesDecrypt(String hex, String key) {
    final String md = md5.convert(utf8.encode(key)).toString();
    final String realKey = md.substring(0, 32);
    final String realIv = realKey.substring(realKey.length - 16);
    final String text = utf8.decode(
      _kgAesCbcDecrypt(realKey, realIv, _kgUnhex(hex)),
      allowMalformed: true,
    );
    try {
      return jsonDecode(text);
    } catch (_) {
      return text;
    }
  }

  /// crypto.rs:283 概念版（lite）公钥，rsa_pk 用的就是它。
  static const String _kgLiteRsaPem =
      '-----BEGIN PUBLIC KEY-----\n'
      'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB\n'
      '-----END PUBLIC KEY-----';

  /// 解析 crypto.rs:283 的 PEM，取出模数 n 与指数 e。
  ///
  /// pointycastle 4.0.0 把整个 key_parsers 库删了（RSAKeyParser 已不存在），
  /// 所以这里自己走一遍 DER。SubjectPublicKeyInfo 的结构是固定的：
  ///   SEQUENCE { AlgorithmIdentifier, BIT STRING { SEQUENCE { n, e } } }
  static ({BigInt n, BigInt e})? _kgRsaKeyCache;

  static ({BigInt n, BigInt e}) _kgLiteRsaKey() {
    final ({BigInt n, BigInt e})? cached = _kgRsaKeyCache;
    if (cached != null) return cached;

    final String b64 = _kgLiteRsaPem
        .replaceAll('-----BEGIN PUBLIC KEY-----', '')
        .replaceAll('-----END PUBLIC KEY-----', '')
        .replaceAll(RegExp(r'\s'), '');
    final Uint8List der = base64.decode(b64);

    final (int, Uint8List) spki = _Der(der).next();
    final _Der lvl1 = _Der(spki.$2);
    lvl1.next(); // AlgorithmIdentifier
    final (int, Uint8List) bits = lvl1.next();

    // BIT STRING 首字节是「未使用位数」，RSA 恒为 0，后面才是 RSAPublicKey。
    final (int, Uint8List) rsa =
        _Der(Uint8List.sublistView(bits.$2, 1)).next();
    final _Der lvl3 = _Der(rsa.$2);
    final (int, Uint8List) nBytes = lvl3.next();
    final (int, Uint8List) eBytes = lvl3.next();

    final ({BigInt n, BigInt e}) key = (
      n: _kgBytesBigInt(nBytes.$2),
      e: _kgBytesBigInt(eBytes.$2),
    );
    _kgRsaKeyCache = key;
    return key;
  }

  /// crypto.rs:158 rsa_raw_encrypt：**无填充**裸模幂。
  /// 两个容易搞反的地方：输入不足模长时是往**右**补零（CryptoJS 的
  /// Uint8Array(keyLength) 语义，数据放偏移 0），只有输出才是往**左**补零到模长。
  static String _kgRsaRawHex(String data) {
    final ({BigInt n, BigInt e}) key = _kgLiteRsaKey();
    final BigInt n = key.n;
    final int modLen = (n.bitLength + 7) ~/ 8;

    final Uint8List bytes = Uint8List.fromList(utf8.encode(data));
    final Uint8List input = Uint8List(modLen);
    input.setRange(0, bytes.length, bytes);

    return _kgHex(
      _kgBigIntBytes(_kgBytesBigInt(input).modPow(key.e, n), modLen),
    );
  }

  static BigInt _kgBytesBigInt(Uint8List b) {
    BigInt v = BigInt.zero;
    for (final int x in b) {
      v = (v << 8) | BigInt.from(x);
    }
    return v;
  }

  /// 左侧补零到固定长度。
  static Uint8List _kgBigIntBytes(BigInt v, int len) {
    final List<int> rev = <int>[];
    for (BigInt t = v; t > BigInt.zero; t = t >> 8) {
      rev.add((t & BigInt.from(0xff)).toInt());
    }
    final Uint8List raw = Uint8List.fromList(rev.reversed.toList());
    final Uint8List out = Uint8List(len);
    final int take = raw.length < len ? raw.length : len;
    out.setRange(len - take, len, raw.sublist(raw.length - take));
    return out;
  }

  static String _kgHex(List<int> bytes) =>
      bytes.map((int b) => b.toRadixString(16).padLeft(2, '0')).join();

  static Uint8List _kgUnhex(String s) {
    final Uint8List out = Uint8List(s.length ~/ 2);
    for (int i = 0; i < out.length; i++) {
      out[i] = int.parse(s.substring(i * 2, i * 2 + 2), radix: 16);
    }
    return out;
  }

  /// util.rs:11 randomString(len)，字符集 '1234567890A-Z'。
  static String _kgRandomString(int len) {
    const String chars = '1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    return List<String>.generate(
      len,
      (_) => chars[_kgRng.nextInt(chars.length)],
    ).join();
  }

  /// util.rs:18 randomString(16).toLowerCase()，登录时的 AES tempKey。
  static String _kgRandomLower16() => _kgRandomString(16).toLowerCase();

  /// helper.rs:107 signParamsKey：md5(appid + 盐 + clientver + data)。
  static String _kgSignParamsKey(String data) =>
      md5.convert(utf8.encode('3116${_kgRoute}11440$data')).toString();

  /// login.rs:16-19 两个定长 AES 密钥（设备指纹 t1/t2）。
  static const String _kgT1Key = '5e4ef500e9597fe004bd09a46d8add98';
  static const String _kgT1Iv = '04bd09a46d8add98';
  static const String _kgT2Key = 'fd14b35e3f81af3817a20ae7adae7020';
  static const String _kgT2Iv = '17a20ae7adae7020';

  /// 手机号 + 验证码登录。login.rs:139 handle_cellphone。
  ///
  /// 三步：AES 加密 {mobile, code} 当 params，RSA 裸模幂把 AES 密钥当 pk 送上去，
  /// 上游用 secu_params 回一段同一密钥加密的数据，解出来才是真正的 token。
  Future<Object?> kugouLoginCellphone(Map<String, dynamic> args) async {
    final String mobile = _s(args['mobile']);
    final String code = _s(args['code']);
    if (mobile.isEmpty) throw Exception('缺少手机号');
    if (code.isEmpty) throw Exception('缺少验证码');

    final _CookieJar jar = await _cookies;
    final Map<String, String> ck = jar.bucket('kugou');
    final Map<String, String> dev = jar.bucket('kugou-device');
    final String guid = _s(dev['guid']);
    final String devId = _s(dev['dev']);
    const String mac = '02:00:00:00:00:00';
    final int now = DateTime.now().millisecondsSinceEpoch;

    // login.rs:143：params = AES(json({mobile, code}))，密钥随机生成。
    final ({String hex, String key}) enc = _kgAesRandom(
      _kgJson(<String, Object?>{'mobile': mobile, 'code': code}),
    );

    // login.rs:149-160：取前 2 位 + '*****' + 第 11 位（index 10）。
    final String masked = (mobile.length > 2 ? mobile.substring(0, 2) : '') +
        '*****' +
        (mobile.length > 10 ? mobile[10] : '');

    final String dfid =
        _s(ck['dfid']).isNotEmpty ? _s(ck['dfid']) : _kgRandomString(24);

    // login.rs:169-176：t1/t2 是设备指纹，参与上游风控。
    final String t2 = _kgAesCbcHex(
      _kgT2Key,
      _kgT2Iv,
      '$guid|0f607264fc6318a92b9e13c65db7cd3c|$mac|$devId|$now',
    );
    final String t1 = _kgAesCbcHex(_kgT1Key, _kgT1Iv, '|$now');

    final Map<String, Object?> body = <String, Object?>{
      'plat': 1,
      'support_multi': 1,
      't1': t1,
      't2': t2,
      'clienttime_ms': now,
      'mobile': masked,
      'key': _kgSignParamsKey('$now'),
      'pk': _kgRsaRawHex(
        _kgJson(<String, Object?>{'clienttime_ms': now, 'key': enc.key}),
      ).toUpperCase(),
      'params': enc.hex,
      'dfid': dfid,
      'dev': devId,
      'gitversion': '5f0b7c4',
      if (_s(ck['userid']).isNotEmpty) 'userid': _s(ck['userid']),
    };

    final Map<String, dynamic> json = await _kgAndroid(
      '/v7/login_by_verifycode',
      const <String, Object?>{},
      body: body,
      host: 'loginserviceretry.kugou.com',
      headers: <String, String>{
        'support-calm': '1',
        'User-Agent': 'Android16-1070-11440-130-0-LOGIN-wifi',
      },
    );

    if (_i(json['status']) != 1) {
      throw Exception('登录失败：${_kgError(json, '验证码错误或已过期')}');
    }

    final Map<String, dynamic> data =
        (json['data'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};

    // login.rs:205-212：secu_params 才是真正的凭据，用刚才那个 tempKey 解。
    final String secu = _s(data['secu_params']);
    if (secu.isNotEmpty) {
      final Object? got = _kgAesDecrypt(secu, enc.key);
      if (got is Map) {
        got.forEach((Object? k, Object? v) {
          data['$k'] = v;
          ck['$k'] = '$v';
        });
      } else {
        data['token'] = got;
        if (got is String) ck['token'] = got;
      }
    }

    ck['t1'] = _s(data['t1']);
    ck['token'] = _s(data['token']);
    ck['userid'] = _s(data['userid']);
    ck['vip_type'] = _s(data['vip_type']);
    ck['vip_token'] = _s(data['vip_token']);
    await jar.save();
    return _kugouProfile(jar);
  }

  /// 每日签到：先领畅听 VIP，再升概念版。youth.rs:131 / youth.rs:147。
  ///
  /// 两步都必须严格判定（kugou.rs:551 的注释）：升级失败却报成功，会出现
  /// 「提示签到成功但官方只加了畅听 VIP」的假成功。
  Future<Object?> kugouSignIn(Map<String, dynamic> args) async {
    final _CookieJar jar = await _cookies;
    if (!_kugouLoggedIn(jar)) throw Exception('请先登录酷狗账号');
    final String day = _chinaDate();

    final Map<String, dynamic> claim = await _kgAndroid(
      '/youth/v1/recharge/receive_vip_listen_song',
      <String, Object?>{'source_id': 90139, 'receive_day': day},
      body: <String, Object?>{'receive_day': day},
    );
    final int claimErr = _i(claim['error_code'], -1);
    final bool claimOk = _i(claim['status']) == 1 || claimErr == 131001;
    if (!claimOk) {
      if (claimErr == 20028) {
        final String ssa = _s(claim['ssaCode']);
        if (ssa.isNotEmpty) {
          return <String, Object?>{
            'ok': false, 'message': '', 'ssaCode': ssa, 'svip': false,
          };
        }
      }
      return <String, Object?>{
        'ok': false,
        'message': _kgError(claim, '签到失败'),
        'ssaCode': null,
        'svip': false,
      };
    }

    final int userid = _i(jar.bucket('kugou')['userid']);
    Map<String, dynamic> up;
    try {
      up = await _kgAndroid(
        '/youth/v1/listen_song/upgrade_vip_reward',
        <String, Object?>{'kugouid': userid, 'ad_type': 1},
      );
    } catch (e) {
      // 网络层异常不标记成功（kugou.rs:572 同样的处理）
      return <String, Object?>{
        'ok': true,
        'message': '签到成功（畅听 VIP，概念版升级未确认）',
        'ssaCode': null,
        'svip': false,
      };
    }
    final int upErr = _i(up['error_code'], -1);
    final bool upgraded =
        upErr == 20030 || upErr == 131001 || _i(up['status']) == 1;
    if (!upgraded && upErr == 20028) {
      final String ssa = _s(up['ssaCode']);
      if (ssa.isNotEmpty) {
        return <String, Object?>{
          'ok': false, 'message': '', 'ssaCode': ssa, 'svip': false,
        };
      }
    }
    return <String, Object?>{
      'ok': true,
      'message': upgraded ? '签到成功（概念版会员）' : '签到成功（畅听 VIP）',
      'ssaCode': null,
      'svip': upgraded,
    };
  }

  Future<Object?> kugouAccount(Map<String, dynamic> args) async {
    final _CookieJar jar = await _cookies;
    return _kugouLoggedIn(jar) ? _kugouProfile(jar) : null;
  }

  Future<Object?> kugouLogout(Map<String, dynamic> args) async {
    final _CookieJar jar = await _cookies;
    jar.clear('kugou');
    await jar.save();
    return null;
  }
}

/// 极简 DER 读取器：只够把 SubjectPublicKeyInfo 拆成 TLV 序列。
/// pointycastle 4.0.0 删掉了 RSAKeyParser，而这里只需要 n 和 e 两个整数。
class _Der {
  _Der(this._b);

  final Uint8List _b;
  int _i = 0;

  int _readLen() {
    int l = _b[_i++];
    if (l & 0x80 != 0) {
      final int count = l & 0x7f;
      l = 0;
      for (int k = 0; k < count; k++) {
        l = (l << 8) | _b[_i++];
      }
    }
    return l;
  }

  /// 读一个 TLV，返回 (tag, value)。
  (int, Uint8List) next() {
    final int tag = _b[_i++];
    final int len = _readLen();
    final Uint8List v = Uint8List.sublistView(_b, _i, _i + len);
    _i += len;
    return (tag, v);
  }
}
