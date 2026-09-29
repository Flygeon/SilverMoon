import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// 在 127.0.0.1 上起一个只服务本机的 HTTP 服务，供 WebView 使用。
///
/// 两条职责：
/// - `/` 与 `/assets/*`：把 Flutter 资源里的 Vue 移动端产物吐出去，即 WebView 的页面本体
/// - `/asset/<urlencoded 绝对路径>`：把本机媒体文件吐出去，支持 Range（音视频拖动进度必需）
///
/// 之所以用 loopback HTTP 而不是自定义 scheme：Android 要写 shouldInterceptRequest、
/// iOS 要写 WKURLSchemeHandler，两侧都是原生代码；而 loopback 只需纯 Dart，
/// 同时让页面处于正常的 http origin，localStorage / fetch / Worker 的行为都可预期。
class WebHostService {
  HttpServer? _server;

  int get port => _server?.port ?? 0;

  bool get running => _server != null;

  /// 页面根地址，形如 `http://127.0.0.1:53124/`。
  Uri get root => Uri.parse('http://127.0.0.1:$port/');

  /// 本地文件 URL 前缀，垫片会把它拼在 encodeURIComponent(绝对路径) 前面。
  String get assetBase => 'http://127.0.0.1:$port/asset/';

  Future<Uri> start() async {
    if (_server != null) return root;
    final HttpServer server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server = server;
    server.listen(
      _handle,
      onError: (Object e) => debugPrint('webhost 监听异常: $e'),
    );
    return root;
  }

  Future<void> stop() async {
    final HttpServer? s = _server;
    _server = null;
    await s?.close(force: true);
  }

  Future<void> _handle(HttpRequest req) async {
    try {
      final String path = Uri.decodeComponent(req.uri.path);
      if (path.startsWith('/asset/')) {
        await _serveLocalFile(req, path.substring('/asset/'.length));
        return;
      }
      await _serveBundle(req, path);
    } catch (e) {
      debugPrint('webhost 请求失败 ${req.uri}: $e');
      try {
        req.response.statusCode = HttpStatus.internalServerError;
        await req.response.close();
      } catch (_) {
        // 连接已断，忽略
      }
    }
  }

  // ---------------------------------------------------------------- 本地文件

  Future<void> _serveLocalFile(HttpRequest req, String rawPath) async {
    final File file = File(rawPath);
    final HttpResponse res = req.response;

    if (!await file.exists()) {
      res.statusCode = HttpStatus.notFound;
      await res.close();
      return;
    }

    final int total = await file.length();
    if (total == 0) {
      res.headers.set(HttpHeaders.contentTypeHeader, _mimeFor(rawPath));
      res.headers.contentLength = 0;
      await res.close();
      return;
    }

    res.headers.set(HttpHeaders.acceptRangesHeader, 'bytes');
    res.headers.set(HttpHeaders.contentTypeHeader, _mimeFor(rawPath));
    res.headers.set(HttpHeaders.cacheControlHeader, 'no-store');
    res.headers.set(HttpHeaders.accessControlAllowOriginHeader, '*');

    int start = 0;
    int end = total - 1;
    bool partial = false;

    final String? range = req.headers.value(HttpHeaders.rangeHeader);
    if (range != null && range.startsWith('bytes=')) {
      partial = true;
      final String spec = range.substring(6).trim();
      final int dash = spec.indexOf('-');
      if (dash >= 0) {
        final String head = spec.substring(0, dash).trim();
        final String tail = spec.substring(dash + 1).trim();
        if (head.isNotEmpty) {
          start = int.tryParse(head) ?? 0;
          if (tail.isNotEmpty) end = int.tryParse(tail) ?? (total - 1);
        } else if (tail.isNotEmpty) {
          // bytes=-N：最后 N 字节
          final int n = int.tryParse(tail) ?? 0;
          start = n >= total ? 0 : total - n;
        }
      }
    }

    if (start < 0) start = 0;
    if (end > total - 1) end = total - 1;
    if (start > end || start >= total) {
      res.statusCode = HttpStatus.requestedRangeNotSatisfiable;
      res.headers.set(HttpHeaders.contentRangeHeader, 'bytes */$total');
      await res.close();
      return;
    }

    res.statusCode = partial ? HttpStatus.partialContent : HttpStatus.ok;
    if (partial) {
      res.headers.set(HttpHeaders.contentRangeHeader, 'bytes $start-$end/$total');
    }
    res.headers.contentLength = end - start + 1;
    await res.addStream(file.openRead(start, end + 1));
    await res.close();
  }

  // ------------------------------------------------------------ Vue 静态产物

  /// 入口 HTML 的候选名。
  ///
  /// vite.mobile.config.ts 的 rollupOptions.input 是 mobile.html，所以构建产物里
  /// 叫 mobile.html；仓库里那个本地占位叫 index.html。两个都试 —— 之前只认
  /// index.html，产物换成 mobile.html 后整个页面 404，表现就是音乐页签全黑。
  static const List<String> _entryCandidates = <String>[
    'index.html',
    'mobile.html',
  ];

  Future<bool> _assetExists(String key) async {
    try {
      await rootBundle.load(key);
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<String> _resolveEntry() async {
    for (final String name in _entryCandidates) {
      if (await _assetExists('assets/webapp/$name')) return name;
    }
    return _entryCandidates.first;
  }

  Future<void> _serveBundle(HttpRequest req, String path) async {
    String rel = path.startsWith('/') ? path.substring(1) : path;
    final bool isEntry = rel.isEmpty;
    if (isEntry) rel = await _resolveEntry();
    final String assetKey = 'assets/webapp/$rel';
    final HttpResponse res = req.response;

    try {
      final ByteData data = await rootBundle.load(assetKey);
      Uint8List bytes =
          data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
      // 入口 HTML 里注入本地文件的 URL 前缀：垫片据此改写 asset:// 本地路径，
      // 无需任何原生 scheme handler。
      if (isEntry) {
        bytes = _injectAssetBase(bytes);
      }
      res.headers.set(HttpHeaders.contentTypeHeader, _mimeFor(rel));
      res.headers.set(HttpHeaders.cacheControlHeader, 'no-store');
      res.headers.contentLength = bytes.length;
      res.add(bytes);
      await res.close();
    } catch (_) {
      res.statusCode = HttpStatus.notFound;
      res.headers.set(HttpHeaders.contentTypeHeader, 'text/plain; charset=utf-8');
      final List<int> body = _missingBody(rel);
      res.headers.contentLength = body.length;
      res.add(body);
      await res.close();
    }
  }

  /// 在 </head> 前插入 sm-asset-base 元信息。用字符串查找而不是正则，
  /// 避免把产物里的内容误伤。
  Uint8List _injectAssetBase(Uint8List html) {
    final String text = utf8.decode(html, allowMalformed: true);
    final String tag = '<meta name="sm-asset-base" content="$assetBase">';
    final int idx = text.indexOf('</head>');
    final String out =
        idx >= 0 ? text.replaceRange(idx, idx, '$tag\n') : '$tag\n$text';
    return Uint8List.fromList(utf8.encode(out));
  }

  List<int> _missingBody(String rel) => utf8.encode(
        'SilverMoon 移动端 Web 资源缺失: $rel\n'
        '该产物由 CI 构建（apps/desktop 的 vite.mobile.config.ts）后拷入 apps/mobile/assets/webapp。',
      );

  String _mimeFor(String path) {
    final int dot = path.lastIndexOf('.');
    final String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase() : '';
    switch (ext) {
      case 'html':
        return 'text/html; charset=utf-8';
      case 'js':
      case 'mjs':
        return 'text/javascript; charset=utf-8';
      case 'css':
        return 'text/css; charset=utf-8';
      case 'json':
        return 'application/json; charset=utf-8';
      case 'map':
        return 'application/json; charset=utf-8';
      case 'svg':
        return 'image/svg+xml';
      case 'png':
        return 'image/png';
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'webp':
        return 'image/webp';
      case 'gif':
        return 'image/gif';
      case 'avif':
        return 'image/avif';
      case 'ico':
        return 'image/x-icon';
      case 'woff2':
        return 'font/woff2';
      case 'woff':
        return 'font/woff';
      case 'ttf':
        return 'font/ttf';
      case 'otf':
        return 'font/otf';
      case 'mp3':
        return 'audio/mpeg';
      case 'flac':
        return 'audio/flac';
      case 'm4a':
      case 'mp4a':
        return 'audio/mp4';
      case 'ogg':
      case 'opus':
        return 'audio/ogg';
      case 'wav':
        return 'audio/wav';
      case 'aac':
        return 'audio/aac';
      case 'ape':
        return 'audio/x-ape';
      case 'mp4':
      case 'm4v':
        return 'video/mp4';
      case 'webm':
        return 'video/webm';
      case 'mkv':
        return 'video/x-matroska';
      case 'mov':
        return 'video/quicktime';
      case 'txt':
      case 'lrc':
      case 'krc':
        return 'text/plain; charset=utf-8';
      default:
        return 'application/octet-stream';
    }
  }
}
