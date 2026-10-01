import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:webview_windows/webview_windows.dart';

import '../../host/host_controller.dart';
import '../../i18n/sm_strings.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../theme/design_tokens.dart';

/// 进程内只允许初始化一次 WebView 环境（重复调用会抛 PlatformException）。
bool _environmentReady = false;

/// 指定 WebView2 的用户数据目录与启动参数。
///
/// 目录必须**固定**：登录态、localStorage（音量、皮肤等）都落在里面。换成临时目录，
/// 用户看到的就是「每次启动登录都没了、音量被重置」。
///
/// 启动参数各有原因，不是照抄：
///   * autoplay-policy=no-user-gesture-required —— 恢复「上次在播的歌」时没有用户手势，
///     默认策略会直接拒掉 audio 播放（表现成点了没反应、进度条不动）；
///   * disable-background-timer-throttling / disable-renderer-backgrounding /
///     disable-backgrounding-occluded-windows —— 窗口最小化或被遮挡时 Chromium 会降频甚至
///     停掉渲染，Web Audio 播放与歌词动画都会跟着卡；
///   * CalculateNativeWinOcclusion 关掉 —— WebView2 在窗口被完全遮挡时会停止渲染，
///     这是官方给出的绕开方式。
Future<void> prepareWebviewEnvironment(String userDataPath) async {
  if (_environmentReady) return;
  try {
    await Directory(userDataPath).create(recursive: true);
  } catch (_) {
    // 目录建不出来也交给 WebView2 自己处理，真正的失败会在 initialize 时暴露
  }
  try {
    await WebviewController.initializeEnvironment(
      userDataPath: userDataPath,
      additionalArguments:
          '--autoplay-policy=no-user-gesture-required '
          '--disable-background-timer-throttling '
          '--disable-renderer-backgrounding '
          '--disable-backgrounding-occluded-windows '
          '--disable-features=CalculateNativeWinOcclusion',
    );
    _environmentReady = true;
  } on PlatformException {
    // 环境已经初始化过：视为就绪
    _environmentReady = true;
  }
}

/// 用 WebView2 承载复用的 Vue 播放层。
///
/// MusicView / PlayerView / MiniPlayer 是归档里的 Vue 源码原样打包出来的产物，
/// 经宿主 loopback 中间层与后端通信；本组件只负责把窗口开出来、指向对应的 hash 路由，
/// 以及把「没装 WebView2 运行时 / 初始化失败」这两种失败讲清楚。
class MusicWebview extends StatefulWidget {
  const MusicWebview({super.key, required this.route});

  /// hash 路由：'/music' 歌单与列表，'/player' 全屏播放器。
  final String route;

  @override
  State<MusicWebview> createState() => _MusicWebviewState();
}

class _MusicWebviewState extends State<MusicWebview> {
  final WebviewController _controller = WebviewController();

  bool _booting = false;
  String? _failure;
  String? _loaded;

  @override
  void dispose() {
    unawaited(_controller.dispose());
    super.dispose();
  }

  Future<void> _boot(String url) async {
    _booting = true;
    try {
      // 运行时缺失时 initialize 会直接失败，先探一次能把话说清楚
      final String? version = await WebviewController.getWebViewVersion();
      if (version == null) {
        _failure = 'missing';
        return;
      }
      await _controller.initialize();
      await _controller.setBackgroundColor(Colors.transparent);
      await _controller.loadUrl(url);
      _loaded = url;
    } catch (error) {
      _failure = error.toString();
    } finally {
      _booting = false;
      if (mounted) setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final SmStrings sm = context.watch<AppState>().strings;
    final HostController host = context.watch<HostController>();
    final ColorScheme scheme = context.scheme;

    if (_failure == 'missing') {
      return _notice(
        scheme,
        sm.t('music.webview.missing'),
        sm.t('music.webview.hint'),
      );
    }
    if (_failure != null) {
      return _notice(scheme, sm.t('music.webview.failed'), _failure);
    }

    final String? base = host.bridge?.playerUrl;
    if (base == null) {
      return _notice(
        scheme,
        sm.t('music.webview.starting'),
        host.error,
      );
    }

    final String url = base + '#' + widget.route;
    if (!_controller.value.isInitialized) {
      if (!_booting) {
        WidgetsBinding.instance.addPostFrameCallback((Duration _) {
          if (mounted && !_booting && _failure == null) unawaited(_boot(url));
        });
      }
      return _notice(scheme, sm.t('music.webview.loading'), null);
    }
    if (_loaded != url) {
      // 换路由只换 hash，不重建控制器（重建会丢掉播放状态）
      _loaded = url;
      WidgetsBinding.instance.addPostFrameCallback((Duration _) {
        if (mounted) unawaited(_controller.loadUrl(url));
      });
    }

    return Stack(
      children: <Widget>[
        Webview(_controller),
        StreamBuilder<LoadingState>(
          stream: _controller.loadingState,
          builder: (BuildContext context, AsyncSnapshot<LoadingState> snapshot) {
            if (snapshot.data == LoadingState.loading) {
              return const LinearProgressIndicator(minHeight: 2);
            }
            return const SizedBox.shrink();
          },
        ),
      ],
    );
  }

  Widget _notice(ColorScheme scheme, String title, String? detail) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(SM.space600),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(
              Icons.music_note_outlined,
              size: SM.space1000,
              color: scheme.onSurfaceVariant,
            ),
            const SizedBox(height: SM.space300),
            Text(
              title,
              textAlign: TextAlign.center,
              style: SmText.titleMedium.copyWith(color: scheme.onSurface),
            ),
            if (detail != null) ...<Widget>[
              const SizedBox(height: SM.space200),
              SelectableText(
                detail,
                textAlign: TextAlign.center,
                style: SmText.bodySmall.copyWith(
                  color: scheme.onSurfaceVariant,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
