import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../services/bridge_service.dart';
import '../services/web_audio_host.dart';
import '../services/web_host_service.dart';

/// 音乐页签：用 WebView 承载复用自桌面端的 Vue 前端。
///
/// 页面与本地媒体文件都由 Flutter 起的 loopback HTTP 服务提供，
/// 前端拿不到的原生能力（网络、文件、存储）经 JavaScript 通道回到 Dart 实现。
///
/// 音频是个例外：前端的 <audio> 被换成虚拟元素（audio-shim.ts），
/// 真实的解码输出落在 WebAudioHost 上，这样息屏后还能继续播。
class MusicWebPage extends StatefulWidget {
  const MusicWebPage({super.key});

  @override
  State<MusicWebPage> createState() => _MusicWebPageState();
}

class _MusicWebPageState extends State<MusicWebPage> {
  WebViewController? _controller;
  BridgeService? _bridge;
  WebAudioHost? _audio;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _boot();
    });
  }

  @override
  void dispose() {
    _bridge?.player.removeListener(_pushAudioMeta);
    final WebAudioHost? a = _audio;
    if (a != null) unawaited(a.dispose());
    super.dispose();
  }

  /// 通知栏/锁屏的标题与封面。player:state 已经由 main-mobile.ts 周期上报，
  /// 直接复用，不再让音频出口自己去问一遍。
  void _pushAudioMeta() {
    final BridgeService? b = _bridge;
    final WebAudioHost? a = _audio;
    if (b == null || a == null) return;
    final PlayerSnapshot s = b.player.value;
    a.updateMeta(title: s.title, artist: s.artist, cover: s.coverUrl);
  }

  Future<void> _boot() async {
    final WebHostService host = context.read<WebHostService>();
    final BridgeService bridge = context.read<BridgeService>();
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final WebAudioHost audio = _audio ??= WebAudioHost(
        emit: (Map<String, Object?> e) => bridge.emit('audio:event', e),
      );
      _bridge = bridge;
      bridge.player.removeListener(_pushAudioMeta);
      bridge.player.addListener(_pushAudioMeta);
      _pushAudioMeta();

      final Uri root = await host.start();
      final WebViewController c = WebViewController()
        ..setJavaScriptMode(JavaScriptMode.unrestricted)
        ..setBackgroundColor(const Color(0xFF101014))
        ..setNavigationDelegate(
          NavigationDelegate(
            onPageFinished: (String url) {
              if (mounted) setState(() => _loading = false);
            },
            onWebResourceError: (WebResourceError e) {
              if (!mounted) return;
              if (e.isForMainFrame ?? false) {
                setState(() {
                  _loading = false;
                  _error = '加载失败：${e.description}';
                });
              }
            },
          ),
        )
        ..addJavaScriptChannel(
          'SMNative',
          onMessageReceived: (JavaScriptMessage m) {
            // 音频消息由出口自己消化，不再往 bridge 里灌
            if (audio.handleRaw(m.message)) return;
            bridge.handleMessage(m.message);
          },
        );
      bridge.attach(c);
      await c.loadRequest(root);
      if (!mounted) return;
      setState(() => _controller = c);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = '启动失败：$e';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final WebViewController? c = _controller;
    return Scaffold(
      backgroundColor: const Color(0xFF101014),
      body: SafeArea(
        top: false,
        child: Stack(
          children: <Widget>[
            if (c != null)
              WebViewWidget(controller: c)
            else if (_error == null)
              const Center(child: CircularProgressIndicator())
            else
              _errorView(context),
            if (_loading && c != null && _error == null)
              const Positioned(
                left: 0,
                right: 0,
                top: 0,
                child: LinearProgressIndicator(minHeight: 2),
              ),
          ],
        ),
      ),
    );
  }

  Widget _errorView(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.web_asset_off_rounded,
                size: 52, color: scheme.onSurfaceVariant),
            const SizedBox(height: 14),
            Text(
              _error ?? '未知错误',
              textAlign: TextAlign.center,
              style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 13.5),
            ),
            const SizedBox(height: 18),
            FilledButton.tonal(
              onPressed: _boot,
              child: const Text('重试'),
            ),
          ],
        ),
      ),
    );
  }
}