import '../models/track.dart';
import 'music_api.dart';

/// 在线音源统一门面：搜索 / 播放直链 / 歌词 / 歌单 / 榜单。
///
/// 设计取舍（已实测）：
/// - 网易云官方公开接口全部可用：搜索、详情、歌词（含逐字 yrc）、outer 播放直链、
///   歌单详情、排行榜、评论。
/// - 酷狗官方搜索 songsearch.kugou.com 与歌词 krcs/lyrics 可用（KRC 逐字），
///   但 wwwapi.kugou.com 的 play/getdata 需要签名，常返回 err_code=30020，
///   因此播放直链回退到 Meting 的签名直链。
/// - Meting 聚合（默认 api.i-meto.com）作为兜底：netease / kugou 两路可用，
///   其返回的 url/pic/lrc 均为带签名直链，必须原样使用。
class MusicRepository {
  MusicRepository({ApiClient? client}) : api = client ?? ApiClient() {
    netease = NeteaseApi(api);
    kugou = KugouApi(api);
    meting = MetingApi(api);
  }

  final ApiClient api;
  late final NeteaseApi netease;
  late final KugouApi kugou;
  late final MetingApi meting;

  /// Meting 使用的后端音源
  String metingServer = 'netease';

  Future<List<Track>> search(MusicServer server, String keyword, {int limit = 30}) async {
    final String kw = keyword.trim();
    if (kw.isEmpty) return const <Track>[];
    try {
      if (server == MusicServer.netease) return await netease.search(kw, limit: limit);
      if (server == MusicServer.kugou) return await kugou.search(kw, limit: limit);
      return await meting.search(kw, server: metingServer);
    } catch (e) {
      return const <Track>[];
    }
  }

  /// 解析可播放直链（本地文件直接返回路径）
  Future<String?> resolvePlayUrl(Track t) async {
    if (t.isLocal) return t.filePath;
    try {
      if (t.server == MusicServer.meting) {
        if (t.url != null && t.url!.isNotEmpty) return t.url;
        return null;
      }
      if (t.server == MusicServer.netease) {
        final String key = t.sourceKey ?? '';
        if (key.isEmpty) return null;
        final String direct = netease.playUrl(key);
        if (await api.probeAudio(direct)) return direct;
        final String? alt = await _metingFallbackUrl(t, 'netease');
        return alt ?? direct;
      }
      if (t.server == MusicServer.kugou) {
        final List<String> parts = (t.sourceKey ?? '').split('|');
        final String hash = parts.isNotEmpty ? parts[0] : '';
        final String hq = parts.length > 1 && parts[1].isNotEmpty ? parts[1] : hash;
        final String albumId = parts.length > 2 ? parts[2] : '';
        if (hash.isEmpty) return null;
        final String? u = await kugou.playUrl(hq, albumId);
        if (u != null && await api.probeAudio(u)) return u;
        final String? alt = await _metingFallbackUrl(t, 'kugou');
        if (alt != null) return alt;
        return await kugou.playUrl(hash, albumId);
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  Future<String?> _metingFallbackUrl(Track t, String server) async {
    try {
      final String q = (t.title + ' ' + t.artist).trim();
      if (q.isEmpty) return null;
      final List<Track> list = await meting.search(q, server: server);
      if (list.isEmpty) return null;
      Track hit = list.first;
      for (final Track e in list) {
        if (e.title.trim() == t.title.trim()) {
          hit = e;
          break;
        }
      }
      final String? u = hit.url;
      if (u == null || u.isEmpty) return null;
      return u;
    } catch (e) {
      return null;
    }
  }

  /// 歌词：网易云优先逐字 yrc；酷狗取 KRC 逐字；其余走 Meting 签名 lrc。
  Future<RawLyric?> fetchLyric(Track t) async {
    if (t.isLocal) return null;
    try {
      if (t.server == MusicServer.netease) {
        final String key = t.sourceKey ?? '';
        if (key.isNotEmpty) {
          final RawLyric? l = await netease.lyric(key);
          if (l != null && !l.isEmpty) return l;
        }
      } else if (t.server == MusicServer.kugou) {
        final List<String> parts = (t.sourceKey ?? '').split('|');
        final String hash = parts.isNotEmpty ? parts[0] : '';
        if (hash.isNotEmpty) {
          final RawLyric? l = await kugou.lyric(hash, durationSec: t.duration?.inSeconds);
          if (l != null && !l.isEmpty) return l;
        }
      } else if (t.server == MusicServer.meting) {
        final String? src = t.lyricText;
        if (src != null && src.isNotEmpty) {
          final String? text = await meting.lrcText(src);
          if (text != null && text.trim().isNotEmpty) {
            return RawLyric(text: text, format: 'lrc');
          }
        }
      }
    } catch (e) {
      // 落到通用兜底
    }
    return _metingFallbackLyric(t);
  }

  Future<RawLyric?> _metingFallbackLyric(Track t) async {
    try {
      final String q = (t.title + ' ' + t.artist).trim();
      if (q.isEmpty) return null;
      final List<Track> list = await meting.search(q, server: metingServer);
      for (final Track e in list) {
        final String? src = e.lyricText;
        if (src == null || src.isEmpty) continue;
        final String? text = await meting.lrcText(src);
        if (text != null && text.trim().isNotEmpty) {
          return RawLyric(text: text, format: 'lrc');
        }
      }
    } catch (e) {
      // 忽略
    }
    return null;
  }

  /// 推荐歌单（网易云热门）
  Future<List<OnlinePlaylist>> featuredPlaylists({int limit = 30}) async {
    try {
      return await netease.hotPlaylists(limit: limit);
    } catch (e) {
      return const <OnlinePlaylist>[];
    }
  }

  /// 排行榜（网易云官方榜）
  Future<List<OnlinePlaylist>> rankings() async {
    try {
      return await netease.toplists();
    } catch (e) {
      return const <OnlinePlaylist>[];
    }
  }

  /// 歌单曲目
  Future<List<Track>> playlistTracks(OnlinePlaylist p) async {
    try {
      if (p.server == MusicServer.meting) {
        return await meting.playlist(p.id, server: metingServer);
      }
      final ({String name, String? cover, List<Track> tracks})? r =
          await netease.playlist(p.id);
      return r?.tracks ?? const <Track>[];
    } catch (e) {
      return const <Track>[];
    }
  }

  /// 评论（仅网易云）
  Future<List<({String user, String content, int liked})>> comments(Track t,
      {int limit = 30}) async {
    if (t.server != MusicServer.netease) {
      return const <({String user, String content, int liked})>[];
    }
    final String key = t.sourceKey ?? '';
    if (key.isEmpty) return const <({String user, String content, int liked})>[];
    try {
      return await netease.comments(key, limit: limit);
    } catch (e) {
      return const <({String user, String content, int liked})>[];
    }
  }
}
