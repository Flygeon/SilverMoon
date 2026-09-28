import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;

import '../models/track.dart';

/// 在线音源原始歌词（text 为原文；translation 为同时间戳翻译轨）
class RawLyric {
  RawLyric({required this.text, required this.format, this.translation});

  final String text;

  /// lrc | yrc | krc | ttml
  final String format;

  final String? translation;

  bool get isEmpty => text.trim().isEmpty;
}

class ApiException implements Exception {
  ApiException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// 把 http:// 升级成 https://（Android/iOS 默认禁止明文，封面尤其容易踩）
String? upgradeHttp(String? url) {
  if (url == null || url.isEmpty) return null;
  if (url.startsWith('http://')) return 'https://' + url.substring(7);
  return url;
}

/// 去掉 HTML 实体与标签（评论接口会返回 <br> 之类）
String stripHtml(String s) => s
    .replaceAll(RegExp(r'<br\s*/?>', caseSensitive: false), '\n')
    .replaceAll(RegExp(r'<[^>]*>'), '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .trim();

class ApiClient {
  ApiClient({http.Client? client}) : _client = client ?? http.Client();

  final http.Client _client;

  static const String userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  static const Duration defaultTimeout = Duration(seconds: 15);

  Map<String, String> _headers(Map<String, String>? extra) {
    final Map<String, String> h = <String, String>{'User-Agent': userAgent};
    if (extra != null) h.addAll(extra);
    return h;
  }

  /// 统一用 UTF-8 解码 bodyBytes：多数音源返回 text/plain 无 charset，
  /// 若用 response.body 会按 latin1 解码导致中文乱码。
  Future<String> getText(String url, {Map<String, String>? headers, Duration? timeout}) async {
    final http.Response r = await _client
        .get(Uri.parse(url), headers: _headers(headers))
        .timeout(timeout ?? defaultTimeout);
    if (r.statusCode >= 400) {
      throw ApiException('HTTP ' + r.statusCode.toString());
    }
    return utf8.decode(r.bodyBytes, allowMalformed: true);
  }

  Future<dynamic> getJson(String url, {Map<String, String>? headers, Duration? timeout}) async {
    final String text = await getText(url, headers: headers, timeout: timeout);
    try {
      return jsonDecode(text);
    } catch (_) {
      throw ApiException('响应不是合法 JSON');
    }
  }

  Future<Map<String, dynamic>?> getJsonObject(String url,
      {Map<String, String>? headers, Duration? timeout}) async {
    final dynamic j = await getJson(url, headers: headers, timeout: timeout);
    if (j is Map) return Map<String, dynamic>.from(j);
    return null;
  }

  Future<List<dynamic>?> getJsonArray(String url,
      {Map<String, String>? headers, Duration? timeout}) async {
    final dynamic j = await getJson(url, headers: headers, timeout: timeout);
    if (j is List) return j;
    return null;
  }

  /// 探测一个音频直链是否可用（Range 请求只取前 1KB）
  Future<bool> probeAudio(String url) async {
    try {
      final http.Request req = http.Request('GET', Uri.parse(url));
      req.headers.addAll(_headers(<String, String>{'Range': 'bytes=0-1023'}));
      final http.StreamedResponse r = await _client.send(req).timeout(defaultTimeout);
      final String ct = (r.headers['content-type'] ?? '').toLowerCase();
      if (r.statusCode >= 400) return false;
      if (ct.contains('text/html') || ct.contains('application/json')) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  void close() => _client.close();
}

// ============================================================== 网易云

class NeteaseApi {
  NeteaseApi(this._api);

  final ApiClient _api;

  static const String _base = 'https://music.163.com';
  static const Map<String, String> _headers = <String, String>{
    'Referer': 'https://music.163.com/',
    'Cookie': 'appver=8.7.01; os=pc;',
  };

  Track _track(Map<String, dynamic> s) {
    final List<dynamic> artists = (s['artists'] as List<dynamic>?) ??
        (s['ar'] as List<dynamic>?) ??
        const <dynamic>[];
    final String artist = artists
        .whereType<Map>()
        .map((Map e) => (e['name'] ?? '').toString())
        .where((String n) => n.isNotEmpty)
        .join(' / ');
    final Object? albumRaw = s['album'] ?? s['al'];
    String album = '';
    String? cover;
    if (albumRaw is Map) {
      album = (albumRaw['name'] ?? '').toString();
      cover = upgradeHttp((albumRaw['picUrl'] ?? albumRaw['picUrl_str'])?.toString());
    }
    final Object? dur = s['duration'] ?? s['dt'];
    final String id = (s['id'] ?? '').toString();
    return Track(
      id: 'netease:' + id,
      title: (s['name'] ?? '').toString(),
      artist: artist,
      album: album,
      coverUrl: cover,
      duration: dur is num ? Duration(milliseconds: dur.toInt()) : null,
      server: MusicServer.netease,
      sourceKey: id,
    );
  }

  /// 搜索：type=1 单曲
  Future<List<Track>> search(String keyword, {int limit = 30, int offset = 0}) async {
    final String url = _base +
        '/api/search/get?s=' +
        Uri.encodeQueryComponent(keyword) +
        '&type=1&limit=' +
        limit.toString() +
        '&offset=' +
        offset.toString();
    final Map<String, dynamic>? j = await _api.getJsonObject(url, headers: _headers);
    final Object? result = j?['result'];
    if (result is! Map) return const <Track>[];
    final List<dynamic> songs = (result['songs'] as List<dynamic>?) ?? const <dynamic>[];
    return songs.whereType<Map>().map((Map e) => _track(Map<String, dynamic>.from(e))).toList();
  }

  /// 歌曲详情（批量）
  Future<List<Track>> songDetail(List<String> ids) async {
    if (ids.isEmpty) return const <Track>[];
    final String url = _base + '/api/song/detail?ids=[' + ids.join(',') + ']';
    final Map<String, dynamic>? j = await _api.getJsonObject(url, headers: _headers);
    final List<dynamic> songs = (j?['songs'] as List<dynamic>?) ?? const <dynamic>[];
    return songs.whereType<Map>().map((Map e) => _track(Map<String, dynamic>.from(e))).toList();
  }

  /// 歌词：优先逐字 yrc，其次 lrc，附翻译轨
  Future<RawLyric?> lyric(String songId) async {
    final String url = _base + '/api/song/lyric?id=' + songId + '&lv=1&kv=1&tv=-1&yv=1';
    final Map<String, dynamic>? j = await _api.getJsonObject(url, headers: _headers);
    if (j == null) return null;
    String? pick(Object? v) {
      if (v is Map) {
        final Object? l = v['lyric'];
        if (l is String && l.trim().isNotEmpty) return l;
      }
      return null;
    }

    final String? yrc = pick(j['yrc']);
    final String? lrc = pick(j['lrc']);
    final String? tlyric = pick(j['tlyric']);
    if (yrc != null) return RawLyric(text: yrc, format: 'yrc', translation: tlyric);
    if (lrc != null) return RawLyric(text: lrc, format: 'lrc', translation: tlyric);
    return null;
  }

  /// 播放直链：官方 outer 接口（会 302 到 CDN）
  String playUrl(String songId) => _base + '/song/media/outer/url?id=' + songId + '.mp3';

  /// 歌单详情
  Future<({String name, String? cover, List<Track> tracks})?> playlist(String id) async {
    final String url = _base + '/api/playlist/detail?id=' + id;
    final Map<String, dynamic>? j = await _api.getJsonObject(url, headers: _headers);
    final Object? result = j?['result'];
    if (result is! Map) return null;
    final List<dynamic> tracks = (result['tracks'] as List<dynamic>?) ?? const <dynamic>[];
    return (
      name: (result['name'] ?? '歌单').toString(),
      cover: upgradeHttp(result['coverImgUrl']?.toString()),
      tracks: tracks
          .whereType<Map>()
          .map((Map e) => _track(Map<String, dynamic>.from(e)))
          .toList(),
    );
  }

  /// 排行榜列表
  Future<List<OnlinePlaylist>> toplists() async {
    final Map<String, dynamic>? j =
        await _api.getJsonObject(_base + '/api/toplist', headers: _headers);
    final List<dynamic> list = (j?['list'] as List<dynamic>?) ?? const <dynamic>[];
    return list.whereType<Map>().map((Map e) {
      final Map<String, dynamic> m = Map<String, dynamic>.from(e);
      return OnlinePlaylist(
        server: MusicServer.netease,
        id: (m['id'] ?? '').toString(),
        name: (m['name'] ?? '').toString(),
        coverUrl: upgradeHttp(m['coverImgUrl']?.toString()),
        trackCount: (m['trackCount'] as num?)?.toInt(),
        creator: '官方榜',
      );
    }).toList();
  }

  /// 热门歌单（分类页，取前 N 个）
  Future<List<OnlinePlaylist>> hotPlaylists({int limit = 30}) async {
    final String url = _base +
        '/api/playlist/list?cat=全部&order=hot&offset=0&limit=' +
        limit.toString() +
        '&total=true';
    final Map<String, dynamic>? j = await _api.getJsonObject(url, headers: _headers);
    final List<dynamic> list = (j?['playlists'] as List<dynamic>?) ?? const <dynamic>[];
    return list.whereType<Map>().map((Map e) {
      final Map<String, dynamic> m = Map<String, dynamic>.from(e);
      return OnlinePlaylist(
        server: MusicServer.netease,
        id: (m['id'] ?? '').toString(),
        name: (m['name'] ?? '').toString(),
        coverUrl: upgradeHttp(m['coverImgUrl']?.toString()),
        trackCount: (m['trackCount'] as num?)?.toInt(),
        creator: (m['creator'] is Map) ? (m['creator']['nickname'] ?? '').toString() : null,
      );
    }).toList();
  }

  /// 评论（R_SO_4_<songId>）
  Future<List<({String user, String content, int liked})>> comments(String songId,
      {int limit = 30}) async {
    final String url = _base +
        '/api/v1/resource/comments/R_SO_4_' +
        songId +
        '?limit=' +
        limit.toString() +
        '&offset=0';
    final Map<String, dynamic>? j = await _api.getJsonObject(url, headers: _headers);
    final List<dynamic> hot = (j?['hotComments'] as List<dynamic>?) ?? const <dynamic>[];
    final List<dynamic> all = (j?['comments'] as List<dynamic>?) ?? const <dynamic>[];
    final List<dynamic> merged = <dynamic>[...hot, ...all];
    return merged.whereType<Map>().map((Map e) {
      final Map<String, dynamic> m = Map<String, dynamic>.from(e);
      final Object? user = m['user'];
      return (
        user: user is Map ? (user['nickname'] ?? '匿名').toString() : '匿名',
        content: stripHtml((m['content'] ?? '').toString()),
        liked: (m['likedCount'] as num?)?.toInt() ?? 0,
      );
    }).toList();
  }
}

// ================================================================ 酷狗

class KugouApi {
  KugouApi(this._api);

  final ApiClient _api;

  static const Map<String, String> _headers = <String, String>{
    'Referer': 'https://www.kugou.com/',
  };

  static String _newMid() {
    final Random r = Random();
    final StringBuffer sb = StringBuffer();
    for (int i = 0; i < 32; i++) {
      sb.write(r.nextInt(16).toRadixString(16));
    }
    return sb.toString();
  }

  /// 搜索（songsearch.kugou.com，无需签名）
  Future<List<Track>> search(String keyword, {int limit = 30, int page = 1}) async {
    final String url = 'https://songsearch.kugou.com/song_search_v2?keyword=' +
        Uri.encodeQueryComponent(keyword) +
        '&page=' +
        page.toString() +
        '&pagesize=' +
        limit.toString() +
        '&platform=WebFilter&userid=-1&clientver=2000&iscorrection=1&privilege_filter=0';
    final Map<String, dynamic>? j = await _api.getJsonObject(url, headers: _headers);
    final Object? data = j?['data'];
    if (data is! Map) return const <Track>[];
    final List<dynamic> lists = (data['lists'] as List<dynamic>?) ?? const <dynamic>[];
    return lists.whereType<Map>().map((Map e) {
      final Map<String, dynamic> m = Map<String, dynamic>.from(e);
      final String hash = (m['FileHash'] ?? '').toString();
      final String hq = (m['HQFileHash'] ?? '').toString();
      final String albumId = (m['AlbumID'] ?? '').toString();
      final String img = (m['Image'] ?? '').toString().replaceAll('{size}', '480');
      final Object? dur = m['Duration'];
      return Track(
        id: 'kugou:' + hash,
        title: (m['SongName'] ?? '').toString(),
        artist: (m['SingerName'] ?? '').toString(),
        album: (m['AlbumName'] ?? '').toString(),
        coverUrl: upgradeHttp(img.isEmpty ? null : img),
        duration: dur is num ? Duration(seconds: dur.toInt()) : null,
        server: MusicServer.kugou,
        sourceKey: hash + '|' + (hq.isEmpty ? hash : hq) + '|' + albumId,
      );
    }).toList();
  }

  /// 播放直链（wwwapi.kugou.com，部分网络/时期会返回 err_code=30020）
  Future<String?> playUrl(String hash, String albumId) async {
    final String mid = _newMid();
    final String url = 'https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=' +
        hash +
        '&album_id=' +
        albumId +
        '&mid=' +
        mid +
        '&platid=4&_=' +
        DateTime.now().millisecondsSinceEpoch.toString();
    try {
      final Map<String, dynamic>? j = await _api.getJsonObject(url, headers: <String, String>{
        'Referer': 'https://www.kugou.com/',
        'Cookie': 'kg_mid=' + mid + '; kg_dfid=0;',
      });
      final Object? data = j?['data'];
      if (data is Map) {
        final Object? play = data['play_url'];
        if (play is String && play.isNotEmpty) return upgradeHttp(play);
      }
    } catch (_) {
      // 忽略，交由上层回退到 Meting
    }
    return null;
  }

  /// 歌词：krcs 搜索 + lyrics 下载（KRC 逐字，base64）
  Future<RawLyric?> lyric(String hash, {int? durationSec}) async {
    try {
      final String sUrl = 'https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=' +
          (durationSec ?? 0).toString() +
          '&hash=' +
          hash +
          '&album_audio_id=';
      final Map<String, dynamic>? sj = await _api.getJsonObject(sUrl, headers: _headers);
      final List<dynamic> cands = (sj?['candidates'] as List<dynamic>?) ?? const <dynamic>[];
      if (cands.isEmpty) return null;
      final Map<String, dynamic> c = Map<String, dynamic>.from(cands.first as Map);
      final String id = (c['id'] ?? '').toString();
      final String accesskey = (c['accesskey'] ?? '').toString();
      if (id.isEmpty || accesskey.isEmpty) return null;

      final String dUrl = 'https://lyrics.kugou.com/download?ver=1&client=pc&id=' +
          id +
          '&accesskey=' +
          accesskey +
          '&fmt=krc&charset=utf8';
      final Map<String, dynamic>? dj = await _api.getJsonObject(dUrl, headers: _headers);
      final Object? content = dj?['content'];
      if (content is String && content.isNotEmpty) {
        return RawLyric(text: content, format: 'krc');
      }
    } catch (_) {
      // 忽略
    }
    return null;
  }
}

// ============================================================== Meting

/// Meting 聚合（默认 api.i-meto.com）。返回的 url/pic/lrc 都是**带签名的直链**，
/// 必须原样使用，不能自己拼。
class MetingApi {
  MetingApi(this._api, {this.baseUrl = defaultBase});

  final ApiClient _api;

  static const String defaultBase = 'https://api.i-meto.com/meting/api';

  static const List<String> fallbackBases = <String>[
    'https://api.i-meto.com/meting/api',
  ];

  String baseUrl;

  String _u(String server, String type, String id) =>
      baseUrl + '?server=' + server + '&type=' + type + '&id=' + Uri.encodeQueryComponent(id);

  List<Track> _parse(List<dynamic> arr, MusicServer server) {
    final List<Track> out = <Track>[];
    for (final dynamic e in arr) {
      if (e is! Map) continue;
      final Map<String, dynamic> m = Map<String, dynamic>.from(e);
      final String url = (m['url'] ?? '').toString();
      final String title = (m['title'] ?? '').toString();
      if (title.isEmpty) continue;
      String? sourceKey;
      try {
        sourceKey = Uri.parse(url).queryParameters['id'];
      } catch (_) {
        sourceKey = null;
      }
      final Object? dur = m['duration'];
      out.add(Track(
        id: 'meting:' + server.id + ':' + (sourceKey ?? title),
        title: title,
        artist: (m['author'] ?? '').toString(),
        coverUrl: upgradeHttp((m['pic'] ?? '').toString()),
        url: url.isEmpty ? null : url,
        server: MusicServer.meting,
        sourceKey: sourceKey,
        lyricText: (m['lrc'] ?? '').toString().isEmpty ? null : (m['lrc'] ?? '').toString(),
        duration: dur is num ? Duration(seconds: dur.toInt()) : null,
      ));
    }
    return out;
  }

  Future<List<Track>> search(String keyword, {String server = 'netease'}) async {
    final List<dynamic>? arr = await _api.getJsonArray(_u(server, 'search', keyword));
    if (arr == null) return const <Track>[];
    return _parse(arr, MusicServer.fromId(server) ?? MusicServer.netease);
  }

  Future<List<Track>> playlist(String id, {String server = 'netease'}) async {
    final List<dynamic>? arr = await _api.getJsonArray(_u(server, 'playlist', id));
    if (arr == null) return const <Track>[];
    return _parse(arr, MusicServer.fromId(server) ?? MusicServer.netease);
  }

  /// 拉取签名 lrc 直链内容
  Future<String?> lrcText(String signedUrl) async {
    try {
      final String t = await _api.getText(signedUrl);
      return t.trim().isEmpty ? null : t;
    } catch (_) {
      return null;
    }
  }
}
