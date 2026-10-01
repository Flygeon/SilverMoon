import 'dart:async';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../bridge/backend_client.dart';
import '../../host/host_controller.dart';
import '../../host/json_store.dart';
import '../../host/settings_store.dart';
import '../../i18n/sm_strings.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../theme/design_tokens.dart';
import '../library/media_format.dart';

/// /webdav —— 真实 WebDAV 远程媒体浏览器。
///
/// 信息层次对齐 Electron 版 WebDavView.vue：
///   * 未配置（settings.json 的 webdavUrl 为空）→ 连接表单：地址 / 用户名 / 密码
///     （obscureText）+「测试连接」+「保存并连接」；
///   * 已配置 → 面包屑 + 目录浏览器：目录点击进入，文件显示体积与时间，
///     并能用系统默认程序打开。
///
/// 与后端的约定（见 backend/src/webdav.rs）：
///   * webdav_test / webdav_list / webdav_media_url 读的是 **Rust 进程内**的配置
///     （CONFIG 静态单例），settings.json 不会自动同步过去，所以进入浏览前必须
///     先推送一次 webdav_configure；进程每次启动配置都为空，不能只在保存时推。
///   * webdav_media_url 返回 http://127.0.0.1:<port>/webdav?u=... 本地代理 URL，
///     不含任何凭据，交给系统默认程序（浏览器 / 关联播放器）即可。
///   * WebDavEntry.mtime 是 **Unix 秒**（后端 http_date_secs 的 as_secs），
///     而 formatMediaDate 收的是毫秒，所以要乘 1000。
class WebDavPage extends StatefulWidget {
  const WebDavPage({super.key});

  @override
  State<WebDavPage> createState() => _WebDavPageState();
}

class _WebDavPageState extends State<WebDavPage> {
  // 扩展名白名单与 Electron 版 utils/webdav.ts 的 entryType 同源，这里只用来挑图标。
  static const Set<String> _imageExts = <String>{
    'jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff',
    'avif', 'heic', 'heif', 'jfif', 'ico', 'svg',
  };
  static const Set<String> _videoExts = <String>{
    'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'flv', 'wmv', 'mpg',
    'mpeg', 'ts', 'm2ts', '3gp', 'ogv',
  };
  static const Set<String> _audioExts = <String>{
    'mp3', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'wma',
    'aiff', 'aif', 'ape', 'alac', 'mpc', 'wv',
  };
  static const Set<String> _bookExts = <String>{
    'epub', 'pdf', 'mobi', 'azw3', 'fb2', 'cbz', 'cbr', 'txt',
  };

  final TextEditingController _url = TextEditingController();
  final TextEditingController _user = TextEditingController();
  final TextEditingController _pass = TextEditingController();

  SettingsStore? _settings;
  bool _formReady = false;
  bool _browsing = false;

  bool _testing = false;
  bool _saving = false;
  bool _testOk = false;
  String? _testMessage;

  bool _loaded = false;
  bool _configured = false;
  bool _loading = false;
  String _path = '';
  List<WebDavEntry> _entries = <WebDavEntry>[];
  String? _listError;

  HostController get _host => context.read<HostController>();

  @override
  void dispose() {
    _url.dispose();
    _user.dispose();
    _pass.dispose();
    super.dispose();
  }

  /// 后端握手（含 store）是异步的，页面可能先于它就绪被打开。
  ///
  /// 与 song_list_page 的 _ensureLoaded 同一套路：build 里 context.watch 建立依赖，
  /// store 从 null 变成就绪时触发重建，再在这里补读一次 settings.json。
  /// 这里只在 build 里改字段、不 setState —— 同一次 build 紧接着就会用到这些值。
  void _ensureSettings(HostController host) {
    if (_formReady) return;
    final JsonStore? store = host.store;
    if (store == null) return;
    final SettingsStore settings = SettingsStore(store);
    _settings = settings;
    final Map<String, Object?> data = settings.read();
    _url.text = (data['webdavUrl'] ?? '').toString();
    _user.text = (data['webdavUser'] ?? '').toString();
    _pass.text = (data['webdavPass'] ?? '').toString();
    _browsing = _url.text.trim().isNotEmpty;
    _formReady = true;
  }

  /// 已配置但后端尚未就绪时，等 client 出现后补一次首屏加载。
  void _ensureLoaded(HostController host) {
    if (_loaded || !_browsing || host.client == null) return;
    _loaded = true;
    // build 期间不能直接 setState：先把首帧钉在加载态，再排到微任务里发命令。
    _loading = true;
    scheduleMicrotask(() {
      if (mounted) unawaited(_load(''));
    });
  }

  /// 把 settings.json 里的连接信息推给 Rust（凭据只在后端进程内）。
  /// 失败原样抛出，由调用方决定展示方式。
  Future<void> _pushStoredConfig(BackendClient client) async {
    final SettingsStore? settings = _settings;
    if (settings == null) return;
    final Map<String, Object?> data = settings.read();
    final String url = (data['webdavUrl'] ?? '').toString().trim();
    if (url.isEmpty) return;
    final BackendReply reply = await client.invoke('webdav_configure', <String, Object?>{
      'url': url,
      'username': (data['webdavUser'] ?? '').toString(),
      'password': (data['webdavPass'] ?? '').toString(),
    });
    reply.unwrap();
  }

  /// 把表单里正在输入的连接信息推给 Rust（测试连接用，不落盘）。
  Future<void> _pushFormConfig(BackendClient client) async {
    final BackendReply reply = await client.invoke('webdav_configure', <String, Object?>{
      'url': _url.text.trim(),
      'username': _user.text,
      'password': _pass.text,
    });
    reply.unwrap();
  }

  Future<void> _load(String path) async {
    final BackendClient? client = _host.client;
    if (client == null) return;
    setState(() {
      _loading = true;
      _listError = null;
    });
    try {
      if (!_configured) {
        await _pushStoredConfig(client);
        _configured = true;
      }
      final BackendReply reply = await client.invoke(
        'webdav_list',
        <String, Object?>{'path': path},
      );
      final Object? data = reply.unwrap();
      final List<WebDavEntry> entries = <WebDavEntry>[];
      if (data is List) {
        for (final Object? item in data) {
          if (item is Map) {
            entries.add(WebDavEntry.fromJson(item.cast<String, Object?>()));
          }
        }
      }
      if (!mounted) return;
      setState(() {
        _entries = entries;
        _path = path;
        _loading = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _listError = error.toString();
        _loading = false;
      });
    }
  }

  Future<void> _test() async {
    final BackendClient? client = _host.client;
    if (client == null) return;
    final SmStrings sm = context.read<AppState>().strings;
    setState(() {
      _testing = true;
      _testMessage = null;
    });
    try {
      await _pushFormConfig(client);
      final BackendReply reply = await client.invoke('webdav_test', const <String, Object?>{});
      final Object? data = reply.unwrap();
      final WebDavStatus status = WebDavStatus.fromJson(
        data is Map ? data.cast<String, Object?>() : const <String, Object?>{},
      );
      if (!mounted) return;
      final String? root = status.rootName;
      setState(() {
        _testOk = status.ok;
        _testMessage = status.ok
            ? (root != null && root.isNotEmpty
                ? sm.t('settings.webdavOk') + ' · ' + root
                : sm.t('settings.webdavOk'))
            : sm.t('settings.webdavFail');
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _testOk = false;
        // 后端错误里不会有密码；这里也绝不回显表单里的密码。
        _testMessage = error.toString();
      });
    } finally {
      if (mounted) setState(() => _testing = false);
    }
  }

  Future<void> _saveAndConnect() async {
    final BackendClient? client = _host.client;
    if (client == null) return;
    setState(() {
      _saving = true;
      _testMessage = null;
    });
    try {
      await _pushFormConfig(client);
      // 与 Electron 版 WebDavView 的 webdavEnabled 门控对齐：保存即视为启用，
      // 否则 Electron 侧读到同一份 settings.json 会显示「WebDAV 已停用」。
      _settings?.merge(<String, Object?>{
        'webdavUrl': _url.text.trim(),
        'webdavUser': _user.text,
        'webdavPass': _pass.text,
        'webdavEnabled': true,
      });
      if (!mounted) return;
      setState(() {
        _configured = true;
        _browsing = true;
        _loaded = true;
        _loading = true;
        _saving = false;
        _path = '';
        _entries = <WebDavEntry>[];
        _listError = null;
      });
      unawaited(_load(''));
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _testOk = false;
        _testMessage = error.toString();
        _saving = false;
      });
    }
  }

  void _goUp() {
    if (_path.isEmpty) return;
    final int slash = _path.lastIndexOf('/');
    unawaited(_load(slash < 0 ? '' : _path.substring(0, slash)));
  }

  /// 用默认程序打开文件：后端只做 URL 拼装，实际打开交给 url_launcher。
  Future<void> _open(WebDavEntry entry) async {
    final BackendClient? client = _host.client;
    if (client == null) return;
    try {
      final BackendReply reply = await client.invoke(
        'webdav_media_url',
        <String, Object?>{'path': entry.path},
      );
      final Object? data = reply.unwrap();
      final String url = data is String ? data : '';
      if (url.isEmpty) return;
      await launchUrl(Uri.parse(url));
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(error.toString())),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final HostController host = context.watch<HostController>();
    final SmStrings sm = context.watch<AppState>().strings;
    _ensureSettings(host);
    _ensureLoaded(host);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        _header(sm),
        Expanded(
          child: !_formReady
              ? _connecting(sm)
              : (_browsing ? _browser(host, sm) : _form(sm)),
        ),
      ],
    );
  }

  Widget _header(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, SM.contentPad, SM.contentPad, 10),
      child: Row(
        children: <Widget>[
          Icon(Icons.cloud_outlined, size: 22, color: scheme.primary),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  sm.t('nav.webdav'),
                  style: SmText.titleLarge.copyWith(color: scheme.onSurface),
                ),
                const SizedBox(height: 2),
                Text(
                  sm.t('navDesc.webdav'),
                  style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _connecting(SmStrings sm) {
    return Center(
      child: Text(
        sm.t('host.connecting'),
        style: SmText.bodyMedium.copyWith(color: context.scheme.onSurfaceVariant),
      ),
    );
  }

  // ------------------------------------------------------------ 连接表单

  Widget _form(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(SM.contentPad),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: Container(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerLow,
              borderRadius: SM.rCard,
              border: Border.all(color: context.hairline),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Icon(Icons.cloud_off_outlined, size: 20, color: scheme.primary),
                    const SizedBox(width: 10),
                    Text(
                      sm.t('webdav.notConfigured'),
                      style: SmText.titleMedium.copyWith(color: scheme.onSurface),
                    ),
                  ],
                ),
                const SizedBox(height: SM.space150),
                Text(
                  sm.t('webdav.notConfiguredHint'),
                  style: SmText.bodySmall.copyWith(
                    color: scheme.onSurfaceVariant,
                    height: 1.6,
                  ),
                ),
                const SizedBox(height: SM.space400),
                _label(sm.t('settings.webdavUrl')),
                const SizedBox(height: SM.space200),
                TextField(
                  controller: _url,
                  style: SmText.bodyMedium,
                  decoration: InputDecoration(hintText: sm.t('settings.webdavUrlPlaceholder')),
                ),
                const SizedBox(height: SM.space300),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          _label(sm.t('settings.webdavUser')),
                          const SizedBox(height: SM.space200),
                          TextField(controller: _user, style: SmText.bodyMedium),
                        ],
                      ),
                    ),
                    const SizedBox(width: SM.space300),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: <Widget>[
                          _label(sm.t('settings.webdavPass')),
                          const SizedBox(height: SM.space200),
                          TextField(
                            controller: _pass,
                            obscureText: true,
                            style: SmText.bodyMedium,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                if (_testMessage != null) ...<Widget>[
                  const SizedBox(height: SM.space300),
                  _statusLine(),
                ],
                const SizedBox(height: SM.space400),
                Wrap(
                  spacing: SM.space200,
                  runSpacing: SM.space200,
                  children: <Widget>[
                    FilledButton.tonalIcon(
                      onPressed: _testing ? null : () => unawaited(_test()),
                      icon: _testing
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.cloud_sync_outlined, size: 18),
                      label: Text(
                        _testing
                            ? sm.t('settings.webdavTesting')
                            : sm.t('settings.webdavTest'),
                      ),
                    ),
                    FilledButton.icon(
                      onPressed: _saving ? null : () => unawaited(_saveAndConnect()),
                      icon: const Icon(Icons.cloud_done_outlined, size: 18),
                      // 归档没有这条文案，宿主自补（键名沿用归档的 webdav.* 命名空间）。
                      label: Text(sm.t('webdav.saveConnect')),
                    ),
                  ],
                ),
                const SizedBox(height: SM.space200),
                TextButton.icon(
                  onPressed: () => context.go('/settings'),
                  icon: const Icon(Icons.settings_outlined, size: 16),
                  label: Text(sm.t('webdav.goSettings')),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _label(String text) {
    return Text(
      text,
      style: SmText.labelMedium.copyWith(color: context.scheme.onSurfaceVariant),
    );
  }

  Widget _statusLine() {
    final ColorScheme scheme = context.scheme;
    final Color foreground =
        _testOk ? scheme.onPrimaryContainer : scheme.onErrorContainer;

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: _testOk ? scheme.primaryContainer : scheme.errorContainer,
        borderRadius: SM.rSmall,
      ),
      child: Row(
        children: <Widget>[
          Icon(
            _testOk ? Icons.check_circle_outline : Icons.error_outline,
            size: 16,
            color: foreground,
          ),
          const SizedBox(width: SM.space200),
          Expanded(
            child: Text(
              _testMessage!,
              style: SmText.bodySmall.copyWith(color: foreground),
            ),
          ),
        ],
      ),
    );
  }

  // ------------------------------------------------------------ 目录浏览

  Widget _browser(HostController host, SmStrings sm) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _breadcrumbBar(sm),
        if (_loading && _entries.isNotEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: SM.contentPad),
            child: LinearProgressIndicator(minHeight: 2),
          ),
        if (_listError != null) _errorLine(sm),
        Expanded(child: _listBody(host, sm)),
      ],
    );
  }

  Widget _breadcrumbBar(SmStrings sm) {
    final ColorScheme scheme = context.scheme;
    final List<String> parts = _path.isEmpty ? <String>[] : _path.split('/');
    final List<Widget> crumbs = <Widget>[];

    crumbs.add(_crumb(sm.t('webdav.root'), _path.isEmpty, () => unawaited(_load(''))));
    String acc = '';
    for (int i = 0; i < parts.length; i++) {
      acc = acc.isEmpty ? parts[i] : acc + '/' + parts[i];
      crumbs.add(Icon(Icons.chevron_right, size: 16, color: scheme.outline));
      final String target = acc;
      crumbs.add(_crumb(
        parts[i],
        i == parts.length - 1,
        () => unawaited(_load(target)),
      ));
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, 0, SM.contentPad, SM.space200),
      child: Row(
        children: <Widget>[
          if (_path.isNotEmpty)
            IconButton(
              // 归档没有这条文案，宿主自补。
              tooltip: sm.t('webdav.up'),
              onPressed: _goUp,
              icon: const Icon(Icons.arrow_upward, size: 18),
            ),
          Expanded(
            child: Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              children: crumbs,
            ),
          ),
          IconButton(
            tooltip: sm.t('webdav.refresh'),
            onPressed: _loading ? null : () => unawaited(_load(_path)),
            icon: const Icon(Icons.refresh, size: 20),
          ),
        ],
      ),
    );
  }

  Widget _crumb(String label, bool current, VoidCallback onTap) {
    final ColorScheme scheme = context.scheme;

    return TextButton(
      onPressed: current ? null : onTap,
      style: TextButton.styleFrom(
        padding: const EdgeInsets.symmetric(horizontal: 10),
        minimumSize: const Size(0, 32),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        foregroundColor: scheme.onSurfaceVariant,
        disabledForegroundColor: scheme.onSurface,
      ),
      child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
    );
  }

  Widget _errorLine(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, 0, SM.contentPad, SM.space200),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: scheme.errorContainer,
          borderRadius: SM.rSmall,
        ),
        child: Row(
          children: <Widget>[
            Icon(Icons.error_outline, size: 16, color: scheme.onErrorContainer),
            const SizedBox(width: SM.space200),
            Expanded(
              child: Text(
                _listError!,
                style: SmText.bodySmall.copyWith(color: scheme.onErrorContainer),
              ),
            ),
            TextButton(
              onPressed: () => unawaited(_load(_path)),
              child: Text(sm.t('webdav.retry')),
            ),
          ],
        ),
      ),
    );
  }

  Widget _listBody(HostController host, SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    if (host.client == null) {
      return Center(
        child: Text(
          sm.t('host.connecting'),
          style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant),
        ),
      );
    }
    if (_loading && _entries.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_entries.isEmpty) {
      return _empty(sm);
    }

    final List<WebDavEntry> dirs = <WebDavEntry>[];
    final List<WebDavEntry> files = <WebDavEntry>[];
    for (final WebDavEntry entry in _entries) {
      if (entry.isDir) {
        dirs.add(entry);
      } else {
        files.add(entry);
      }
    }

    final List<Widget> rows = <Widget>[];
    if (dirs.isNotEmpty) {
      rows.add(_sectionTitle(sm.t('webdav.folders')));
      for (final WebDavEntry entry in dirs) {
        rows.add(_row(entry, sm));
      }
    }
    if (files.isNotEmpty) {
      rows.add(_sectionTitle(
        sm.t('nav.webdav') + ' · ' + files.length.toString() + ' ' + sm.t('webdav.items'),
      ));
      for (final WebDavEntry entry in files) {
        rows.add(_row(entry, sm));
      }
    }

    return ListView(
      padding: const EdgeInsets.only(bottom: SM.space600),
      children: rows,
    );
  }

  Widget _sectionTitle(String text) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        SM.contentPad,
        SM.space400,
        SM.contentPad,
        SM.space200,
      ),
      child: Text(
        text,
        style: SmText.labelMedium.copyWith(color: context.scheme.onSurfaceVariant),
      ),
    );
  }

  Widget _row(WebDavEntry entry, SmStrings sm) {
    final ColorScheme scheme = context.scheme;
    final String meta = <String>[
      formatMediaSize(entry.size),
      // 后端 mtime 是秒，formatMediaDate 收毫秒。
      formatMediaDate(entry.mtime * 1000),
    ].where((String part) => part.isNotEmpty).toList().join(' · ');

    return InkWell(
      onTap: () {
        if (entry.isDir) {
          unawaited(_load(entry.path));
        } else {
          unawaited(_open(entry));
        }
      },
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: SM.contentPad, vertical: 9),
        child: Row(
          children: <Widget>[
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                color: scheme.surfaceContainerHighest,
                borderRadius: SM.rSmall,
              ),
              child: Icon(
                entry.isDir ? Icons.folder_outlined : _fileIcon(entry),
                size: 18,
                color: entry.isDir ? scheme.primary : scheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(width: SM.space300),
            Expanded(
              child: Text(
                entry.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: SmText.bodyMedium.copyWith(color: scheme.onSurface),
              ),
            ),
            const SizedBox(width: SM.space300),
            if (entry.isDir)
              Icon(Icons.chevron_right, size: 18, color: scheme.outline)
            else
              Text(meta, style: SmText.bodySmall.copyWith(color: scheme.outline)),
            if (!entry.isDir) ...<Widget>[
              const SizedBox(width: SM.space100),
              IconButton(
                // 归档没有这条文案，宿主自补。
                tooltip: sm.t('webdav.openFile'),
                onPressed: () => unawaited(_open(entry)),
                icon: const Icon(Icons.open_in_new, size: 18),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _empty(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.folder_open_outlined, size: 40, color: scheme.outlineVariant),
          const SizedBox(height: SM.space250),
          Text(
            sm.t('webdav.emptyDir'),
            style: SmText.titleSmall.copyWith(color: scheme.onSurface),
          ),
          const SizedBox(height: SM.space100),
          Text(
            sm.t('webdav.emptyDirHint'),
            style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  static IconData _fileIcon(WebDavEntry entry) {
    final int dot = entry.name.lastIndexOf('.');
    final String ext = dot < 0 ? '' : entry.name.substring(dot + 1).toLowerCase();
    if (_imageExts.contains(ext)) return Icons.image_outlined;
    if (_videoExts.contains(ext)) return Icons.movie_outlined;
    if (_audioExts.contains(ext)) return Icons.music_note_outlined;
    if (_bookExts.contains(ext)) return Icons.menu_book_outlined;
    return Icons.insert_drive_file_outlined;
  }
}

/// WebDAV 目录条目（对应后端 WebDavEntry，serde camelCase）。
class WebDavEntry {
  const WebDavEntry({
    required this.name,
    required this.path,
    required this.isDir,
    required this.size,
    required this.mtime,
  });

  final String name;

  /// 相对根目录的路径，段间用 "/" 分隔，不含首尾 "/"。
  final String path;
  final bool isDir;
  final int size;

  /// Unix 秒（后端 http_date_secs），不是毫秒。
  final int mtime;

  static WebDavEntry fromJson(Map<String, Object?> json) {
    final Object? size = json['size'];
    final Object? mtime = json['mtime'];
    return WebDavEntry(
      name: (json['name'] ?? '').toString(),
      path: (json['path'] ?? '').toString(),
      isDir: json['isDir'] == true,
      size: size is num ? size.toInt() : 0,
      mtime: mtime is num ? mtime.toInt() : 0,
    );
  }
}

/// 连接测试结果（对应后端 WebDavStatus）。
class WebDavStatus {
  const WebDavStatus({required this.ok, this.rootName});

  final bool ok;
  final String? rootName;

  static WebDavStatus fromJson(Map<String, Object?> json) {
    final Object? root = json['rootName'];
    return WebDavStatus(
      ok: json['ok'] == true,
      rootName: root is String && root.isNotEmpty ? root : null,
    );
  }
}
