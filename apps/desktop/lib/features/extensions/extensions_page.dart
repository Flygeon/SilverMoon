import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../bridge/backend_client.dart';
import '../../host/host_controller.dart';
import '../../i18n/sm_strings.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../theme/design_tokens.dart';

/// /extensions —— 扩展管理真实页（替换 P0 占位）。
///
/// 数据面全部走 Rust 扩展框架（`commands::extension`），前端不直接碰扩展目录：
///   * `ext_list` → `Vec<ExtInfo>`：id / name / version / enabled / hasEngine / engineReady；
///   * `ext_set_enabled(id, enabled)`：持久化开关，后端顺带拉起或停掉扩展引擎；
///   * `ext_uninstall(id)`：停引擎 + 删目录（不可撤销，故必须二次确认）。
///
/// 启停与卸载都带副作用（后端要等引擎 stdout 的 `READY` 行，最长 20s），
/// 所以逐项用 `_busy` 锁住并给出转圈，避免连点造成重复调用；
/// 后端未就绪（client == null）时降级为提示，不阻断外壳其余部分。
class ExtensionsPage extends StatefulWidget {
  const ExtensionsPage({super.key});

  @override
  State<ExtensionsPage> createState() => _ExtensionsPageState();
}

class _ExtensionsPageState extends State<ExtensionsPage> {
  List<ExtInfo> _items = <ExtInfo>[];
  final Set<String> _busy = <String>{};
  bool _loading = false;
  bool _loadedOnce = false;
  String? _error;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final HostController host = context.watch<HostController>();
    // 与 ImagesPage 同款：后端可能晚于本页就绪，故每次依赖变化都补判一次；
    // 拉取推迟到首帧之后，避免在 build 期间 setState。
    if (host.isReady && !_loadedOnce) {
      _loadedOnce = true;
      WidgetsBinding.instance.addPostFrameCallback((Duration _) {
        if (mounted) unawaited(_load());
      });
    }
  }

  BackendClient? get _client => context.read<HostController>().client;

  Future<void> _load() async {
    final BackendClient? client = _client;
    if (client == null || _loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final Object? data =
          (await client.invoke('ext_list', const <String, Object?>{})).unwrap();
      final List<ExtInfo> items = <ExtInfo>[];
      if (data is List) {
        for (final Object? item in data) {
          if (item is Map) items.add(ExtInfo.fromJson(item.cast<String, Object?>()));
        }
      }
      if (!mounted) return;
      setState(() => _items = items);
    } catch (error) {
      if (!mounted) return;
      setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _setBusy(String id, bool busy) {
    if (busy) {
      _busy.add(id);
    } else {
      _busy.remove(id);
    }
    if (mounted) setState(() {});
  }

  /// 切换启用状态。成功后整表重拉：`engineReady` 要等后端拉起引擎后才会变 true，
  /// 只改本地布尔值会让「引擎就绪」指示停留在旧值。
  Future<void> _setEnabled(ExtInfo info, bool enabled) async {
    final BackendClient? client = _client;
    if (client == null || _busy.contains(info.id)) return;
    _setBusy(info.id, true);
    try {
      await client
          .invoke(
            'ext_set_enabled',
            <String, Object?>{'id': info.id, 'enabled': enabled},
          )
          .unwrap();
      if (mounted) await _load();
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) _setBusy(info.id, false);
    }
  }

  /// 卸载会删掉整个扩展目录且不可恢复，先弹框二次确认。
  Future<void> _uninstall(ExtInfo info, SmStrings sm) async {
    final BackendClient? client = _client;
    if (client == null || _busy.contains(info.id)) return;
    final bool? confirmed = await showDialog<bool>(
      context: context,
      builder: (BuildContext dialogContext) {
        return AlertDialog(
          title: Text(sm.t('actions.delete') + ' ' + info.name),
          actions: <Widget>[
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: Text(sm.t('actions.cancel')),
            ),
            FilledButton(
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: Text(sm.t('actions.confirm')),
            ),
          ],
        );
      },
    );
    if (confirmed != true || !mounted) return;
    _setBusy(info.id, true);
    try {
      await client.invoke('ext_uninstall', <String, Object?>{'id': info.id}).unwrap();
      if (mounted) await _load();
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) _setBusy(info.id, false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final HostController host = context.watch<HostController>();
    final SmStrings sm = context.watch<AppState>().strings;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _header(sm),
        if (_error != null) _errorLine(),
        Expanded(child: _body(host, sm)),
      ],
    );
  }

  Widget _header(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.only(
        left: SM.contentPad,
        right: SM.space200,
        top: SM.space400,
        bottom: SM.space200,
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  sm.t('page.extensions.title'),
                  style: SmText.titleLarge.copyWith(color: scheme.onSurface),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: SM.space50),
                Text(
                  sm.t('page.extensions.desc'),
                  style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ],
            ),
          ),
          const SizedBox(width: SM.space300),
          IconButton(
            tooltip: sm.t('webdav.refresh'),
            onPressed: _loading ? null : () => unawaited(_load()),
            icon: const Icon(Icons.refresh, size: 20),
          ),
        ],
      ),
    );
  }

  Widget _errorLine() {
    return Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: SM.contentPad,
        vertical: SM.space100,
      ),
      child: Text(
        _error!,
        maxLines: 3,
        overflow: TextOverflow.ellipsis,
        style: SmText.bodySmall.copyWith(color: context.scheme.error),
      ),
    );
  }

  Widget _body(HostController host, SmStrings sm) {
    // client 为空说明 sidecar 尚未握手完成，此时任何命令都会失败——给提示而不是崩。
    if (!host.isReady || host.client == null) {
      return Center(
        child: Text(
          sm.t(host.status == HostStatus.failed ? 'host.failed' : 'host.connecting'),
          style: SmText.bodySmall.copyWith(color: context.scheme.onSurfaceVariant),
        ),
      );
    }
    if (_loading && _items.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_items.isEmpty) return _empty(sm);
    return ListView.separated(
      padding: const EdgeInsets.all(SM.contentPad),
      itemCount: _items.length,
      separatorBuilder: (BuildContext context, int index) =>
          const SizedBox(height: SM.space200),
      itemBuilder: (BuildContext context, int index) {
        final ExtInfo info = _items[index];
        return _ExtensionTile(
          info: info,
          busy: _busy.contains(info.id),
          sm: sm,
          onToggle: (bool enabled) => unawaited(_setEnabled(info, enabled)),
          onUninstall: () => unawaited(_uninstall(info, sm)),
        );
      },
    );
  }

  Widget _empty(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          Icon(Icons.extension_outlined, size: 56, color: scheme.outline),
          const SizedBox(height: SM.space400),
          Text(
            // 归档与宿主词条里都没有扩展空态，暂借首页 feed 的「暂无内容」；
            // 理想的 extensions.empty / extensions.emptyHint 见交付说明。
            sm.t('homeFeed.empty'),
            style: SmText.titleSmall.copyWith(color: scheme.onSurface),
          ),
          const SizedBox(height: SM.space100),
          Text(
            sm.t('page.extensions.desc'),
            style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

/// 已安装扩展摘要，字段与 Rust `commands::extension::ExtInfo`（camelCase）逐条对应。
class ExtInfo {
  const ExtInfo({
    required this.id,
    required this.name,
    required this.version,
    required this.enabled,
    required this.hasEngine,
    required this.engineReady,
  });

  factory ExtInfo.fromJson(Map<String, Object?> json) {
    return ExtInfo(
      id: _string(json['id']) ?? '',
      name: _string(json['name']) ?? '',
      version: _string(json['version']) ?? '',
      enabled: json['enabled'] == true,
      hasEngine: json['hasEngine'] == true,
      engineReady: json['engineReady'] == true,
    );
  }

  final String id;
  final String name;
  final String version;
  final bool enabled;
  final bool hasEngine;
  final bool engineReady;
}

/// 单条扩展：名称 / 版本 / 启用状态 / 引擎指示 / 开关 / 卸载。
class _ExtensionTile extends StatelessWidget {
  const _ExtensionTile({
    required this.info,
    required this.busy,
    required this.sm,
    required this.onToggle,
    required this.onUninstall,
  });

  final ExtInfo info;
  final bool busy;
  final SmStrings sm;
  final void Function(bool enabled) onToggle;
  final VoidCallback onUninstall;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    // manifest 的 version 是可选项，后端缺省时给空串，这里用「未设置」兜住。
    final String version =
        info.version.isEmpty ? sm.t('settings.unknown') : info.version;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: SM.space500,
        vertical: SM.space300,
      ),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: SM.rCard,
        border: Border.all(color: context.hairline),
      ),
      child: Row(
        children: <Widget>[
          Icon(Icons.extension_outlined, size: 24, color: scheme.primary),
          const SizedBox(width: SM.space400),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Flexible(
                      child: Text(
                        info.name.isEmpty ? info.id : info.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: SmText.titleSmall.copyWith(color: scheme.onSurface),
                      ),
                    ),
                    if (info.hasEngine)
                      Padding(
                        padding: const EdgeInsets.only(left: SM.space200),
                        // 引擎态没有对应词条，用图标表示：就绪=对勾，未就绪=感叹。
                        child: Icon(
                          info.engineReady
                              ? Icons.check_circle_outline
                              : Icons.error_outline,
                          size: 14,
                          color: info.engineReady ? scheme.primary : scheme.error,
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: SM.space50),
                Text(
                  sm.t('settings.version') +
                      ' ' +
                      version +
                      ' · ' +
                      // 缺 extensions.enabled / extensions.disabled，暂借番剧规则管理的
                      //「启用 / 已禁用」，补上词条后应替换。
                      (info.enabled
                          ? sm.t('anime.rule.enable')
                          : sm.t('anime.rule.disabled')),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          const SizedBox(width: SM.space300),
          // 启停要等后端拉/停引擎，期间用转圈占位并锁住开关与卸载。
          if (busy)
            const SizedBox(
              width: 20,
              height: 20,
              child: CircularProgressIndicator(strokeWidth: 2),
            )
          else
            Switch(value: info.enabled, onChanged: onToggle),
          IconButton(
            tooltip: sm.t('actions.delete'),
            onPressed: busy ? null : onUninstall,
            icon: const Icon(Icons.delete_outline, size: 18),
          ),
        ],
      ),
    );
  }
}

String? _string(Object? value) =>
    value is String && value.isNotEmpty ? value : null;
