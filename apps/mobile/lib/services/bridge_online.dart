import 'dart:convert';

import 'package:http/http.dart' as http;

/// 在线音源命令。
///
/// 桌面端这几条在 Rust 里实现，动机是绕 CORS 与统一保管登录凭据。
/// 移动端没有 Rust 侧，这里直接用 Dart 的网络栈 —— 效果等价，
/// 而且请求由 Dart 发起，CORS 天然不存在。
///
/// 注意：**歌词不在这里**。QQ 音乐 QRC 与酷狗 KRC 的解密、逐字对齐
/// 全部由 Vue 侧经 http 通道完成，所以逐字歌词不需要额外命令。
Map<String, Future<Object?> Function(Map<String, dynamic>)> buildOnlineCommands() {
  final _Online api = _Online();
  return <String, Future<Object?> Function(Map<String, dynamic>)>{
    'netease_song_url': api.neteaseSongUrl,
    'kugou_search': api.kugouSearch,
    'kugou_song_url': api.kugouSongUrl,
    'kugou_cover': api.kugouCover,
  };
}

class _Online {
  final http.Client _client = http.Client();

  /// 上游对无 UA 的请求会直接拒绝或返回空列表，必须伪装成浏览器。
  static const Map<String, String> _browserHeaders = <String, String>{
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/120.0.0.0 Mobile Safari/537.36',
  };

  Future<http.Response> _get(String url, {Map<String, String>? headers}) {
    final Map<String, String> h = <String, String>{
      ..._browserHeaders,
      ...?headers,
    };
    return _client
        .get(Uri.parse(url), headers: h)
        .timeout(const Duration(seconds: 20));
  }

  String _text(http.Response resp) =>
      utf8.decode(resp.bodyBytes, allowMalformed: true);

  /// 网易云播放地址。
  ///
  /// 走官方 outer 直链：它 302 跳到 CDN，<audio> 自己会跟随跳转。
  /// 不要在这里把音频下载下来再转 dataURL —— 一首歌几十 MB，内存直接爆。
  Future<Object?> neteaseSongUrl(Map<String, dynamic> args) async {
    final List<dynamic> ids =
        (args['ids'] as List<dynamic>?) ?? const <dynamic>[];
    return ids.map((dynamic raw) {
      final int id = (raw as num).toInt();
      return <String, dynamic>{
        'id': id,
        'url': 'https://music.163.com/song/media/outer/url?id=$id.mp3',
      };
    }).toList();
  }

  /// 酷狗搜索：返回上游原始 JSON，交给前端 utils/kugou.ts 归一化
  /// （上游存在新旧两套字段形态，归一化逻辑本来就只在前端一处）。
  Future<Object?> kugouSearch(Map<String, dynamic> args) async {
    final String keyword = (args['keyword'] ?? '').toString();
    if (keyword.isEmpty) {
      return <String, dynamic>{
        'data': <String, dynamic>{'lists': <dynamic>[]},
      };
    }
    final int page = (args['page'] as num?)?.toInt() ?? 1;
    final int pagesize = (args['pagesize'] as num?)?.toInt() ?? 30;
    final Uri uri =
        Uri.https('songsearch.kugou.com', '/song_search_v2', <String, String>{
      'keyword': keyword,
      'page': '$page',
      'pagesize': '$pagesize',
      'platform': 'WebFilter',
      'userid': '-1',
      'clientver': '2000',
      'iscorrection': '1',
      'privilege_filter': '0',
      'filter': '10',
    });
    final http.Response resp = await _get(uri.toString());
    if (resp.statusCode != 200) {
      throw StateError('酷狗搜索失败: HTTP ${resp.statusCode}');
    }
    return jsonDecode(_text(resp));
  }

  /// 酷狗播放地址。
  ///
  /// 上游这条接口对未登录/无版权内容会返回 err_code（实测 30020），
  /// 此时**必须抛错**而不是返回空 url —— 抛错才能让前端走 Meting 回退链，
  /// 返回空串会让播放器卡在一个永远加载不出来的地址上。
  Future<Object?> kugouSongUrl(Map<String, dynamic> args) async {
    final String hash = (args['hash'] ?? '').toString();
    if (hash.isEmpty) throw StateError('kugou_song_url 缺少 hash');
    final String albumId = (args['albumId'] ?? '').toString();

    final Uri uri = Uri.https('wwwapi.kugou.com', '/yy/index.php',
        <String, String>{
          'r': 'play/getdata',
          'hash': hash,
          if (albumId.isNotEmpty) 'album_id': albumId,
          'dfid': '-',
          'appid': '1014',
          'mid': '0',
          'platid': '4',
        });

    final http.Response resp = await _get(
      uri.toString(),
      headers: <String, String>{
        'Referer': 'https://www.kugou.com/',
        'Cookie': 'kg_mid=0; kg_dfid=0',
      },
    );
    if (resp.statusCode != 200) {
      throw StateError('酷狗播放地址解析失败: HTTP ${resp.statusCode}');
    }

    final Object? decoded = jsonDecode(_text(resp));
    if (decoded is! Map) {
      throw StateError('酷狗播放地址解析失败: 响应不是对象');
    }
    final Map<String, dynamic> data = decoded['data'] is Map
        ? Map<String, dynamic>.from(decoded['data'] as Map)
        : <String, dynamic>{};
    final String url = (data['play_url'] ?? '').toString();
    if (url.isEmpty) {
      final Object? code = decoded['err_code'] ?? decoded['status'];
      throw StateError('酷狗未返回播放地址 (err_code=$code)');
    }
    return <String, dynamic>{
      'url': url,
      'quality': (data['audio_name'] ?? '').toString(),
      'trial': data['is_free_part'] == 1,
    };
  }

  /// 酷狗封面。上游图床不返回 CORS 头，WebView 里 <img> 直连会被拦，
  /// 所以由 Dart 取回来转成 dataURL。
  Future<Object?> kugouCover(Map<String, dynamic> args) async {
    final String url = (args['url'] ?? '').toString();
    if (url.isEmpty) return '';
    final http.Response resp = await _get(
      url,
      headers: <String, String>{'Referer': 'https://www.kugou.com/'},
    );
    if (resp.statusCode != 200) {
      throw StateError('封面下载失败: HTTP ${resp.statusCode}');
    }
    final String mime =
        (resp.headers['content-type'] ?? 'image/jpeg').split(';').first;
    return 'data:$mime;base64,${base64Encode(resp.bodyBytes)}';
  }
}
