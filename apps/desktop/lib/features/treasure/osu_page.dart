import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
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

/// /treasure/osu —— osu! 谱面搜索 / 下载 / 导入（对齐 Electron 版 OsuView.vue）。
///
/// 后端链路（backend/src/osu.rs）：
///   搜索 osu_search（Sayobot → osu! 官方 → Catboy 三源聚合去重）→
///   下载 osu_download（多镜像回退）→ 解压 .osz / 转 mp3 / 写 ID3 / 入库；
///   本地文件走 osu_import_archive。
///
/// 两条命令在 Rust 侧都是 spawn_blocking 的**同步阻塞**调用，进度事件
/// osu:progress 只用于回推阶段文案；本页用一个 busy 标记表达「正在下载」，
/// 不订阅事件（导入本身串行化，同时只会有一个任务在跑）。
///
/// 设置项 osuMirror / osuOutDir 由本页读写（settings.json 的字段，
/// 键名与 Electron 版 stores/settings.ts 一致，见 host/settings_store.dart）。
class OsuPage extends StatefulWidget {
  const OsuPage({super.key});

  @override
  State<OsuPage> createState() => _OsuPageState();
}

/// 下载镜像选项。
///
/// 取值以 Rust osu.rs 的 download_sources 为准：那里只认
/// official / sayobot / catboy / nerinyan 四个源，任何其它值
/// （含下面的 auto）都落到 match 的 _ 分支 = 不过滤，按
/// 官方 → Sayobot → Catboy → NeriNyan 顺序回退。auto 不是下载源，
/// 而是「自动回退」，与 Electron 版 DEFAULTS.osuMirror = 'auto' 对齐。
@immutable
class _MirrorOption {
  const _MirrorOption(this.value, this.labelKey);

  final String value;

  /// 归档词条 key（osu.mirror*）。
  final String labelKey;
}

const List<_MirrorOption> _mirrors = <_MirrorOption>[
  _MirrorOption('auto', 'osu.mirrorAuto'),
  _MirrorOption('official', 'osu.mirrorOfficial'),
  _MirrorOption('sayobot', 'osu.mirrorSayobot'),
  _MirrorOption('catboy', 'osu.mirrorCatboy'),
  _MirrorOption('nerinyan', 'osu.mirrorNerinyan'),
];

/// osu_search 的单项，对应 Rust OsuBeatmapset（serde camelCase）。
class OsuBeatmapset {
  const OsuBeatmapset({
    required this.id,
    required this.title,
    required this.artist,
    required this.songTitle,
    required this.pageUrl,
    required this.source,
    this.uploader,
  });

  factory OsuBeatmapset.fromJson(Map<String, Object?> json) {
    return OsuBeatmapset(
      id: _asString(json['id']) ?? '',
      title: _asString(json['title']) ?? '',
      artist: _asString(json['artist']) ?? '',
      songTitle: _asString(json['songTitle']) ?? '',
      uploader: _asString(json['uploader']),
      pageUrl: _asString(json['pageUrl']) ?? '',
      source: _asString(json['source']) ?? '',
    );
  }

  final String id;

  /// 完整展示名：后端已拼好的 Artist - Title。
  final String title;

  final String artist;

  /// 纯曲名（title 去掉艺术家前缀后的部分）。
  final String songTitle;

  final String? uploader;

  /// osu.ppy.sh 谱面集页地址（page_url_for 生成）。
  final String pageUrl;

  /// 结果来自哪个源：sayobot / official / catboy / direct。
  final String source;
}

/// osu_download / osu_import_archive 的返回，对应 Rust OsuImportResult。
class OsuImportResult {
  const OsuImportResult({
    required this.fileId,
    required this.path,
    required this.title,
    required this.artist,
    required this.beatmapsetId,
  });

  factory OsuImportResult.fromJson(Map<String, Object?> json) {
    return OsuImportResult(
      fileId: _asString(json['fileId']) ?? '',
      path: _asString(json['path']) ?? '',
      title: _asString(json['title']) ?? '',
      artist: _asString(json['artist']) ?? '',
      beatmapsetId: _asString(json['beatmapsetId']) ?? '',
    );
  }

  /// 入库后的文件 ID（路径的 xxh3）。
  final String fileId;

  /// 落盘的 mp3 路径。
  final String path;

  final String title;
  final String artist;
  final String beatmapsetId;
}

class _OsuPageState extends State<OsuPage> {
  /// 本地导入占用 busy 时用的哨兵 ID。谱面集 ID 全是数字，不会与它相撞。
  static const String _localBusyId = '__local__';

  final TextEditingController _query = TextEditingController();

  List<OsuBeatmapset> _items = <OsuBeatmapset>[];
  List<String> _sourceErrors = <String>[];
  bool _searching = false;
  bool _loadedSettings = false;

  /// 正在下载的谱面集 ID；空串表示空闲。后端导入串行化，同时只允许一个。
  String _busyId = '';
  String _mirror = 'auto';
  String _outDir = '';
  String? _error;

  HostController get _host => context.read<HostController>();

  @override
  void dispose() {
    _query.dispose();
    super.dispose();
  }

  /// 设置与后端握手都是异步的：store 由 HostController 建好后才非空。
  ///
  /// 只在 didChangeDependencies 里判断不够（context.read 不建立依赖），
  /// 所以在 build 里 watch 宿主，store 出现后用微任务补读一次
  /// （直接调用会在 build 期间 setState）。
  void _ensureSettings(HostController host) {
    if (_loadedSettings || host.store == null) return;
    _loadedSettings = true;
    scheduleMicrotask(() {
      if (!mounted) return;
      final JsonStore? store = _host.store;
      if (store == null) return;
      final Map<String, Object?> data = SettingsStore(store).read();
      setState(() {
        _mirror = _mirrorValue(data['osuMirror']);
        _outDir = _outDirValue(data['osuOutDir']);
      });
    });
  }

  /// 未知 / 缺失的镜像值一律回退到 auto（与 Electron 版默认值一致）。
  static String _mirrorValue(Object? value) {
    final String text = value is String ? value.trim() : '';
    for (final _MirrorOption option in _mirrors) {
      if (option.value == text) return text;
    }
    return 'auto';
  }

  static String _outDirValue(Object? value) => value is String ? value.trim() : '';

  /// 只覆盖本页负责的两个字段，不整份重写 settings.json。
  void _setSetting(String key, Object? value) {
    final JsonStore? store = _host.store;
    if (store == null) return;
    SettingsStore(store).merge(<String, Object?>{key: value});
  }

  Future<void> _search() async {
    final BackendClient? client = _host.client;
    final String query = _query.text.trim();
    if (client == null || query.isEmpty || _searching) return;

    setState(() {
      _searching = true;
      _error = null;
      _sourceErrors = <String>[];
      _items = <OsuBeatmapset>[];
    });
    try {
      final BackendReply reply = await client.invoke('osu_search', <String, Object?>{
        'query': query,
        // 与 Electron 版 osuSearch(q, 24) 一致；后端会 clamp 到 1..50。
        'limit': 24,
      });
      final Object? data = reply.unwrap();
      final List<OsuBeatmapset> items = <OsuBeatmapset>[];
      final List<String> errors = <String>[];
      if (data is Map) {
        final Map<String, Object?> result = data.cast<String, Object?>();
        final Object? rawItems = result['items'];
        if (rawItems is List) {
          for (final Object? item in rawItems) {
            if (item is Map) {
              items.add(OsuBeatmapset.fromJson(item.cast<String, Object?>()));
            }
          }
        }
        final Object? rawErrors = result['errors'];
        if (rawErrors is List) {
          for (final Object? item in rawErrors) {
            if (item is String && item.isNotEmpty) errors.add(item);
          }
        }
      }
      if (!mounted) return;
      setState(() {
        _items = items;
        _sourceErrors = errors;
        _searching = false;
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _error = error.toString();
        _searching = false;
      });
    }
  }

  Future<void> _download(OsuBeatmapset item) async {
    final BackendClient? client = _host.client;
    if (client == null || _busyId.isNotEmpty) return;

    setState(() {
      _busyId = item.id;
      _error = null;
    });
    try {
      final BackendReply reply = await client.invoke('osu_download', <String, Object?>{
        'beatmapsetId': item.id,
        // 原样回传（含 auto）：后端只认四个源，auto 落到 _ 分支按顺序回退。
        'mirror': _mirror,
        if (_outDir.isNotEmpty) 'outDir': _outDir,
      });
      final Object? data = reply.unwrap();
      final OsuImportResult? result =
          data is Map ? OsuImportResult.fromJson(data.cast<String, Object?>()) : null;
      final String title = result == null || result.title.isEmpty ? item.title : result.title;
      _notifyImported(title);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busyId = '');
    }
  }

  /// .osz 后缀限定用 XTypeGroup.extensions（file_selector 1.1.0 的参数名）。
  Future<void> _importLocal() async {
    final BackendClient? client = _host.client;
    if (client == null || _busyId.isNotEmpty) return;

    final SmStrings sm = context.read<AppState>().strings;
    const XTypeGroup oszGroup = XTypeGroup(
      label: 'osu! beatmap archive',
      extensions: <String>['osz'],
    );
    final XFile? file = await openFile(
      acceptedTypeGroups: <XTypeGroup>[oszGroup],
      confirmButtonText: sm.t('osu.importLocal'),
    );
    if (file == null || !mounted) return;

    setState(() {
      _busyId = _localBusyId;
      _error = null;
    });
    try {
      final BackendReply reply = await client.invoke('osu_import_archive', <String, Object?>{
        'archivePath': file.path,
        if (_outDir.isNotEmpty) 'outDir': _outDir,
      });
      final Object? data = reply.unwrap();
      final OsuImportResult? result =
          data is Map ? OsuImportResult.fromJson(data.cast<String, Object?>()) : null;
      final String title = result == null || result.title.isEmpty ? file.name : result.title;
      _notifyImported(title);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busyId = '');
    }
  }

  Future<void> _pickOutDir(SmStrings sm) async {
    final String? dir = await getDirectoryPath(confirmButtonText: sm.t('osu.pickDir'));
    if (dir == null || dir.isEmpty || !mounted) return;
    setState(() => _outDir = dir);
    _setSetting('osuOutDir', dir);
  }

  Future<void> _openPage(OsuBeatmapset item) async {
    if (item.pageUrl.isEmpty) return;
    try {
      await launchUrl(Uri.parse(item.pageUrl));
    } catch (_) {
      // 打不开浏览器不影响搜索与下载
    }
  }

  /// 下载 / 导入成功的反馈：SnackBar 带上后端返回的 title。
  void _notifyImported(String title) {
    if (!mounted) return;
    final SmStrings sm = context.read<AppState>().strings;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(sm.t('osu.imported') + '：' + title)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final HostController host = context.watch<HostController>();
    final SmStrings sm = context.watch<AppState>().strings;
    _ensureSettings(host);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(SM.contentPad, SM.contentPad, SM.contentPad, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                sm.t('osu.title'),
                style: SmText.titleLarge.copyWith(color: context.scheme.onSurface),
              ),
              const SizedBox(height: SM.space50),
              Text(
                sm.t('osu.desc'),
                style: SmText.bodySmall.copyWith(color: context.scheme.onSurfaceVariant),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: SM.contentPad),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              _searchRow(sm, host),
              const SizedBox(height: SM.space300),
              _optionsRow(sm, host),
            ],
          ),
        ),
        if (_error != null) _errorLine(),
        if (_sourceErrors.isNotEmpty) _sourceErrorLine(),
        if (_busyId.isNotEmpty) _progressLine(),
        Expanded(child: _body(sm, host)),
      ],
    );
  }

  Widget _searchRow(SmStrings sm, HostController host) {
    final bool ready = host.client != null;

    return Row(
      children: <Widget>[
        Expanded(
          child: TextField(
            controller: _query,
            enabled: ready,
            style: SmText.bodyMedium,
            textInputAction: TextInputAction.search,
            decoration: InputDecoration(
              hintText: sm.t('osu.searchPlaceholder'),
              prefixIcon: const Icon(Icons.search, size: 20),
            ),
            onSubmitted: (String value) => unawaited(_search()),
          ),
        ),
        const SizedBox(width: SM.space300),
        FilledButton.icon(
          onPressed: (_searching || !ready) ? null : () => unawaited(_search()),
          icon: _searching
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.search, size: 18),
          label: Text(_searching ? sm.t('osu.searching') : sm.t('osu.search')),
        ),
      ],
    );
  }

  Widget _optionsRow(SmStrings sm, HostController host) {
    final ColorScheme scheme = context.scheme;
    final bool ready = host.client != null;

    return Wrap(
      spacing: SM.space300,
      runSpacing: SM.space200,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: <Widget>[
        Text(
          sm.t('osu.mirror'),
          style: SmText.labelMedium.copyWith(color: scheme.onSurfaceVariant),
        ),
        for (final _MirrorOption option in _mirrors)
          ChoiceChip(
            label: Text(sm.t(option.labelKey), style: SmText.bodySmall),
            selected: _mirror == option.value,
            onSelected: (bool selected) {
              if (!selected) return;
              setState(() => _mirror = option.value);
              _setSetting('osuMirror', option.value);
            },
          ),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              sm.t('osu.outDir') + '：',
              style: SmText.labelMedium.copyWith(color: scheme.onSurfaceVariant),
            ),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 260),
              child: Text(
                _outDir.isEmpty ? sm.t('osu.outDirAuto') : _outDir,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: SmText.bodySmall.copyWith(color: scheme.onSurface),
              ),
            ),
            TextButton(
              onPressed: ready ? () => unawaited(_pickOutDir(sm)) : null,
              child: Text(sm.t('osu.pickDir')),
            ),
          ],
        ),
        FilledButton.tonalIcon(
          onPressed: (ready && _busyId.isEmpty) ? () => unawaited(_importLocal()) : null,
          icon: const Icon(Icons.folder_open, size: 18),
          label: Text(sm.t('osu.importLocal')),
        ),
      ],
    );
  }

  Widget _errorLine() {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, SM.space300, SM.contentPad, 0),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: scheme.errorContainer,
          borderRadius: SM.rSmall,
        ),
        child: Text(
          _error!,
          style: SmText.bodySmall.copyWith(color: scheme.onErrorContainer),
        ),
      ),
    );
  }

  /// 部分源失败时后端仍会返回结果，把失败原因单独提示（不挡住列表）。
  Widget _sourceErrorLine() {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, SM.space300, SM.contentPad, 0),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerHighest,
          borderRadius: SM.rSmall,
        ),
        child: Text(
          _sourceErrors.join(' | '),
          style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
        ),
      ),
    );
  }

  /// 命令同步阻塞、拿不到百分比，用不确定进度条表达「正在工作」。
  Widget _progressLine() {
    return const Padding(
      padding: EdgeInsets.fromLTRB(SM.contentPad, SM.space300, SM.contentPad, 0),
      child: LinearProgressIndicator(minHeight: 3),
    );
  }

  Widget _body(SmStrings sm, HostController host) {
    final ColorScheme scheme = context.scheme;

    if (host.client == null) {
      return Center(
        child: Text(
          sm.t('host.connecting'),
          style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant),
        ),
      );
    }
    if (_searching && _items.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_items.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Icon(Icons.sports_esports_outlined, size: 40, color: scheme.outlineVariant),
            const SizedBox(height: SM.space250),
            Text(
              sm.t('osu.empty'),
              style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant),
            ),
          ],
        ),
      );
    }
    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, SM.space200, SM.contentPad, 24),
      itemCount: _items.length,
      separatorBuilder: (BuildContext context, int index) =>
          Divider(height: 1, color: context.hairline),
      itemBuilder: (BuildContext context, int index) {
        final OsuBeatmapset item = _items[index];
        return _OsuRow(
          item: item,
          busy: _busyId == item.id,
          enabled: _busyId.isEmpty,
          sm: sm,
          onDownload: () => unawaited(_download(item)),
          onOpenPage: () => unawaited(_openPage(item)),
        );
      },
    );
  }
}

/// 单条搜索结果：标题 / 艺术家 · uploader / 来源标签 + 下载。
class _OsuRow extends StatelessWidget {
  const _OsuRow({
    required this.item,
    required this.busy,
    required this.enabled,
    required this.sm,
    required this.onDownload,
    required this.onOpenPage,
  });

  final OsuBeatmapset item;

  /// 该项正在下载。
  final bool busy;

  /// 当前没有任何下载任务（任一项下载时全部按钮都禁用）。
  final bool enabled;

  final SmStrings sm;
  final VoidCallback onDownload;
  final VoidCallback onOpenPage;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final String? uploader = item.uploader;
    final List<String> meta = <String>[
      if (item.artist.isNotEmpty) item.artist,
      if (uploader != null && uploader.isNotEmpty) uploader,
    ];

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: <Widget>[
          // 封面一律占位：osu! 封面图（assets.ppy.sh）在本应用里取不到，不做请求。
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHighest,
              borderRadius: SM.rSmall,
            ),
            child: Icon(Icons.music_note_outlined, size: 20, color: scheme.onSurfaceVariant),
          ),
          const SizedBox(width: SM.space300),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  item.title.isEmpty ? item.id : item.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: SmText.bodyMedium.copyWith(color: scheme.onSurface),
                ),
                const SizedBox(height: SM.space50),
                Row(
                  children: <Widget>[
                    if (meta.isNotEmpty)
                      Flexible(
                        child: Text(
                          meta.join(' · '),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                        ),
                      ),
                    if (meta.isNotEmpty && item.source.isNotEmpty)
                      const SizedBox(width: SM.space200),
                    if (item.source.isNotEmpty)
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
                        decoration: BoxDecoration(
                          color: scheme.secondaryContainer,
                          borderRadius: BorderRadius.circular(SM.cornerFull),
                        ),
                        child: Text(
                          item.source,
                          style: SmText.labelSmall.copyWith(color: scheme.onSecondaryContainer),
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: SM.space200),
          IconButton(
            tooltip: sm.t('osu.openPage'),
            onPressed: item.pageUrl.isEmpty ? null : onOpenPage,
            icon: const Icon(Icons.open_in_new, size: 18),
          ),
          const SizedBox(width: SM.space100),
          FilledButton.tonal(
            onPressed: enabled ? onDownload : null,
            child: busy
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Text(sm.t('osu.download')),
          ),
        ],
      ),
    );
  }
}

String? _asString(Object? value) => value is String ? value : null;
