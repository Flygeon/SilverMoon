import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../bridge/backend_client.dart';
import '../../host/host_controller.dart';
import '../../i18n/sm_strings.dart';
import '../../state/app_state.dart';
import '../../theme/app_theme.dart';
import '../../theme/design_tokens.dart';
import 'stats_api.dart';

/// 时段选项（天数）。对应后端 `days` 参数，后端 clamp 上限为 90。
const List<int> _periodDays = <int>[7, 30, 90];

/// 柱状图的几何常量：集中在这里，避免 build 里散落魔法尺寸。
const double _chartHeight = 132;
const double _chartBarMax = 108;
const double _chartBarMin = 4;
const double _chartBarZero = 2;

/// 时段标签。归档只有 `stats.period7` / `stats.period30`
/// （**没有 stats.period90**），这里用 30 天的模板替换数字，避免自造词条 key。
String _periodLabel(SmStrings sm, int days) {
  return sm.t('stats.period30').replaceFirst('30', days.toString());
}

/// 小说来源显示名（未知来源按本地处理，与 Electron 版 NovelStatsView 一致）。
String _novelSourceLabel(SmStrings sm, String source) {
  return source == 'online' ? sm.t('novelStats.online') : sm.t('novelStats.local');
}

/// 柱高：按当天最大值归一化，非零保底 `_chartBarMin`，零值留一点底座。
double _barHeight(int value, int max) {
  if (value <= 0 || max <= 0) return _chartBarZero;
  final double scaled = value / max * _chartBarMax;
  return scaled < _chartBarMin ? _chartBarMin : scaled;
}

/// /novel-stats —— 小说阅读统计页（替换原占位页）。
///
/// 信息层次对齐 Electron 版 `NovelStatsView.vue`：顶部时段切换 → 概览
/// （今日次数 / 今日时长 / 近 30 天在读）→ 每日趋势 → 本地·在线占比 → 在读排行。
/// 数据来自 Rust `novel_stats_list` / `novel_source_breakdown` /
/// `novel_top_books`；图表同样是纯 Container 柱状图。
class NovelStatsPage extends StatefulWidget {
  const NovelStatsPage({super.key});

  @override
  State<NovelStatsPage> createState() => _NovelStatsPageState();
}

class _NovelStatsPageState extends State<NovelStatsPage> {
  static const int _defaultDays = 7;
  static const int _topLimit = 20;

  /// 「近30天在读」的固定窗口（天）。
  static const int _recentWindow = 30;

  int _days = _defaultDays;
  bool _loaded = false;
  bool _loading = false;
  String? _error;

  List<NovelDailyStat> _trend = <NovelDailyStat>[];
  List<NovelSourceStat> _sources = <NovelSourceStat>[];
  List<NovelTopBook> _topBooks = <NovelTopBook>[];
  NovelDailyStat? _today;
  int _recentBooks = 0;

  HostController get _host => context.read<HostController>();

  /// 后端握手是异步的，页面可能先于 client 就绪被打开。
  ///
  /// 只在 didChangeDependencies 里判断不够：context.read 不建立依赖，client
  /// 从 null 变就绪时不会触发它。改在 build 里 watch 宿主，就绪后用微任务补加载
  /// （直接调用会在 build 期间 setState）。
  void _ensureLoaded(HostController host) {
    if (_loaded || host.client == null) return;
    _loaded = true;
    scheduleMicrotask(() {
      if (mounted) unawaited(_load());
    });
  }

  Future<void> _load() async {
    final BackendClient? client = _host.client;
    if (client == null) return;
    final StatsApi api = StatsApi(client);
    final int days = _days;
    // 「近30天在读」固定按 30 天统计，所以数据至少取 30 天，趋势再按所选时段截取。
    final int fetchDays = days < _recentWindow ? _recentWindow : days;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final List<NovelDailyStat> daily = await api.novelDaily(days: fetchDays);
      final List<NovelSourceStat> sources = await api.novelSources(days: days);
      final List<NovelTopBook> books = await api.novelTopBooks(limit: _topLimit, days: days);
      // 用户在请求途中切了时段：丢弃这一批，交给后发的那次加载落盘。
      if (!mounted || days != _days) return;
      final List<NovelDailyStat> filled = fillNovelDays(daily, fetchDays);
      final List<NovelDailyStat> trend =
          filled.length > days ? filled.sublist(filled.length - days) : filled;
      int recentBooks = 0;
      final int start = filled.length > _recentWindow ? filled.length - _recentWindow : 0;
      for (int i = start; i < filled.length; i++) {
        recentBooks += filled[i].uniqueBooks;
      }
      setState(() {
        _trend = trend;
        _sources = sources;
        _topBooks = books;
        _today = filled.isEmpty ? null : filled.last;
        _recentBooks = recentBooks;
        _loading = false;
      });
    } catch (error) {
      if (!mounted || days != _days) return;
      setState(() {
        _error = error.toString();
        _loading = false;
      });
    }
  }

  void _selectPeriod(int days) {
    if (days == _days) return;
    setState(() => _days = days);
    unawaited(_load());
  }

  @override
  Widget build(BuildContext context) {
    final HostController host = context.watch<HostController>();
    final SmStrings sm = context.watch<AppState>().strings;
    _ensureLoaded(host);

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
      padding: const EdgeInsets.fromLTRB(
        SM.contentPad,
        SM.contentPad,
        SM.contentPad,
        SM.space300,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(Icons.auto_stories_outlined, size: 22, color: scheme.primary),
              const SizedBox(width: SM.space250),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      sm.t('novelStats.title'),
                      style: SmText.titleLarge.copyWith(color: scheme.onSurface),
                    ),
                    const SizedBox(height: SM.space50),
                    Text(
                      sm.t('novelStats.subtitle'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                    ),
                  ],
                ),
              ),
              IconButton(
                tooltip: sm.t('images.refresh'),
                onPressed: _loading ? null : () => unawaited(_load()),
                icon: _loading
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.refresh, size: 20),
              ),
            ],
          ),
          const SizedBox(height: SM.space300),
          _periodChips(sm),
        ],
      ),
    );
  }

  Widget _periodChips(SmStrings sm) {
    return Wrap(
      spacing: SM.space200,
      runSpacing: SM.space200,
      children: <Widget>[
        for (final int days in _periodDays)
          ChoiceChip(
            label: Text(_periodLabel(sm, days)),
            selected: _days == days,
            onSelected: (bool selected) {
              if (selected) _selectPeriod(days);
            },
          ),
      ],
    );
  }

  Widget _errorLine() {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.fromLTRB(SM.contentPad, 0, SM.contentPad, SM.space200),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(
          horizontal: SM.space300,
          vertical: SM.space200,
        ),
        decoration: BoxDecoration(color: scheme.errorContainer, borderRadius: SM.rSmall),
        child: Text(
          _error!,
          style: SmText.bodySmall.copyWith(color: scheme.onErrorContainer),
        ),
      ),
    );
  }

  Widget _body(HostController host, SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    if (host.client == null) {
      return Center(
        child: Text(
          sm.t('host.connecting'),
          style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant),
        ),
      );
    }
    if (_loading && _trend.isEmpty) {
      return Center(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const SizedBox(
              width: 16,
              height: 16,
              child: CircularProgressIndicator(strokeWidth: 2),
            ),
            const SizedBox(width: SM.space300),
            Text(
              sm.t('novelStats.loading'),
              style: SmText.bodyMedium.copyWith(color: scheme.onSurfaceVariant),
            ),
          ],
        ),
      );
    }
    if (!_hasData) return _empty(sm);

    return ListView(
      padding: const EdgeInsets.fromLTRB(
        SM.contentPad,
        0,
        SM.contentPad,
        SM.space1000,
      ),
      children: <Widget>[
        _overview(sm),
        const SizedBox(height: SM.space400),
        _StatCard(title: sm.t('novelStats.trend'), child: _trendChart()),
        const SizedBox(height: SM.space400),
        _StatCard(title: sm.t('novelStats.source'), child: _sourceList(sm)),
        const SizedBox(height: SM.space400),
        _StatCard(title: sm.t('novelStats.topBooks'), child: _bookList(sm)),
      ],
    );
  }

  bool get _hasData {
    if (_sources.isNotEmpty || _topBooks.isNotEmpty) return true;
    for (final NovelDailyStat item in _trend) {
      if (item.readCount > 0) return true;
    }
    return false;
  }

  Widget _empty(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(Icons.auto_stories_outlined, size: 40, color: scheme.outlineVariant),
          const SizedBox(height: SM.space250),
          Text(
            sm.t('novelStats.empty'),
            style: SmText.titleSmall.copyWith(color: scheme.onSurface),
          ),
          const SizedBox(height: SM.space100),
          Text(
            sm.t('stats.noDataHint'),
            textAlign: TextAlign.center,
            style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  /// 概览卡：今日阅读次数 / 今日阅读时长 / 近 30 天在读（去重书籍数之和）。
  Widget _overview(SmStrings sm) {
    final NovelDailyStat? today = _today;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Expanded(
          child: _MetricCard(
            icon: Icons.today_outlined,
            value: (today?.readCount ?? 0).toString(),
            label: sm.t('novelStats.todayCount'),
          ),
        ),
        const SizedBox(width: SM.space300),
        Expanded(
          child: _MetricCard(
            icon: Icons.schedule_outlined,
            value: formatListenDuration(today?.totalMs ?? 0),
            label: sm.t('novelStats.todayDuration'),
          ),
        ),
        const SizedBox(width: SM.space300),
        Expanded(
          child: _MetricCard(
            icon: Icons.menu_book_outlined,
            value: _recentBooks.toString(),
            label: sm.t('novelStats.recentBooks'),
          ),
        ),
      ],
    );
  }

  Widget _trendChart() {
    final ColorScheme scheme = context.scheme;
    int maxMs = 0;
    for (final NovelDailyStat item in _trend) {
      if (item.totalMs > maxMs) maxMs = item.totalMs;
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        SizedBox(
          height: _chartHeight,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              for (final NovelDailyStat item in _trend)
                Expanded(
                  child: Tooltip(
                    message: item.day + ' · ' + formatListenDuration(item.totalMs),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 1),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.end,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: <Widget>[
                          Container(
                            height: _barHeight(item.totalMs, maxMs),
                            decoration: BoxDecoration(
                              color: item.totalMs > 0
                                  ? scheme.primary
                                  : scheme.surfaceContainerHighest,
                              borderRadius: const BorderRadius.vertical(
                                top: Radius.circular(SM.cornerXs),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: SM.space100),
        _axis(scheme),
      ],
    );
  }

  /// 轴标签：柱子少时逐日标，柱子多时只标首尾，避免 90 天挤成一团。
  Widget _axis(ColorScheme scheme) {
    if (_trend.isEmpty) return const SizedBox.shrink();
    if (_trend.length <= 10) {
      return Row(
        children: <Widget>[
          for (final NovelDailyStat item in _trend)
            Expanded(
              child: Text(
                formatDayShort(item.day),
                textAlign: TextAlign.center,
                maxLines: 1,
                overflow: TextOverflow.clip,
                style: SmText.labelSmall.copyWith(color: scheme.onSurfaceVariant),
              ),
            ),
        ],
      );
    }
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: <Widget>[
        Text(
          formatDayShort(_trend.first.day),
          style: SmText.labelSmall.copyWith(color: scheme.onSurfaceVariant),
        ),
        Text(
          formatDayShort(_trend.last.day),
          style: SmText.labelSmall.copyWith(color: scheme.onSurfaceVariant),
        ),
      ],
    );
  }

  Widget _sourceList(SmStrings sm) {
    if (_sources.isEmpty) return _inlineEmpty(sm);
    int total = 0;
    for (final NovelSourceStat item in _sources) {
      total += item.readCount;
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        for (int i = 0; i < _sources.length; i++) ...<Widget>[
          if (i > 0) const SizedBox(height: SM.space300),
          _SourceRow(item: _sources[i], total: total, sm: sm),
        ],
      ],
    );
  }

  Widget _bookList(SmStrings sm) {
    if (_topBooks.isEmpty) return _inlineEmpty(sm);

    return Column(
      children: <Widget>[
        for (int i = 0; i < _topBooks.length; i++) ...<Widget>[
          if (i > 0) Divider(height: 1, color: context.hairline),
          _BookRow(rank: i + 1, book: _topBooks[i], sm: sm),
        ],
      ],
    );
  }

  Widget _inlineEmpty(SmStrings sm) {
    final ColorScheme scheme = context.scheme;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: SM.space400),
      child: Center(
        child: Text(
          sm.t('novelStats.empty'),
          style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
        ),
      ),
    );
  }
}

/// 指标卡：图标 + 数值 + 标签（概览区三张并排）。
class _MetricCard extends StatelessWidget {
  const _MetricCard({required this.icon, required this.value, required this.label});

  final IconData icon;
  final String value;
  final String label;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: SM.space300,
        vertical: SM.space400,
      ),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHigh,
        borderRadius: SM.rCardInner,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(icon, size: 20, color: scheme.primary),
          const SizedBox(height: SM.space200),
          Text(
            value,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: SmText.titleMedium.copyWith(color: scheme.onSurface),
          ),
          const SizedBox(height: SM.space50),
          Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }
}

/// 区块卡片：标题 + 内容（对齐设置页的卡片描边样式）。
class _StatCard extends StatelessWidget {
  const _StatCard({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;

    return Container(
      padding: const EdgeInsets.fromLTRB(
        SM.space500,
        SM.space400,
        SM.space500,
        SM.space500,
      ),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: SM.rCard,
        border: Border.all(color: context.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text(title, style: SmText.titleMedium.copyWith(color: scheme.onSurface)),
          const SizedBox(height: SM.space400),
          child,
        ],
      ),
    );
  }
}

/// 来源分布行：本地 / 在线 + 次数·时长 + 占比 + 占比条。
class _SourceRow extends StatelessWidget {
  const _SourceRow({required this.item, required this.total, required this.sm});

  final NovelSourceStat item;
  final int total;
  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    // total 是各来源之和，故 0 <= share <= 1，无需再 clamp。
    final double share = total > 0 ? item.readCount / total : 0;
    final int percent = (share * 100).round();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                _novelSourceLabel(sm, item.source),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: SmText.bodyMedium.copyWith(color: scheme.onSurface),
              ),
            ),
            Text(
              item.readCount.toString() +
                  ' ' +
                  sm.t('stats.times') +
                  ' · ' +
                  formatListenDuration(item.totalMs),
              style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(width: SM.space200),
            Text(
              percent.toString() + '%',
              style: SmText.labelMedium.copyWith(color: scheme.primary),
            ),
          ],
        ),
        const SizedBox(height: SM.space100),
        ClipRRect(
          borderRadius: SM.rSmall,
          child: LinearProgressIndicator(
            value: share,
            minHeight: SM.space100,
            backgroundColor: scheme.surfaceContainerHighest,
          ),
        ),
      ],
    );
  }
}

/// 在读排行行：排名 / 书名 / 最近章节（缺省退化到来源）/ 次数 / 时长。
class _BookRow extends StatelessWidget {
  const _BookRow({required this.rank, required this.book, required this.sm});

  final int rank;
  final NovelTopBook book;
  final SmStrings sm;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = context.scheme;
    final String subtitle = book.chapterTitle.isNotEmpty
        ? book.chapterTitle
        : _novelSourceLabel(sm, book.source);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: SM.space250),
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 28,
            child: Text(
              rank.toString(),
              textAlign: TextAlign.center,
              style: SmText.labelMedium.copyWith(color: scheme.onSurfaceVariant),
            ),
          ),
          const SizedBox(width: SM.space200),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  book.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: SmText.bodyMedium.copyWith(color: scheme.onSurface),
                ),
                const SizedBox(height: SM.space50),
                Text(
                  subtitle,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
          ),
          const SizedBox(width: SM.space300),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              Text(
                book.readCount.toString() + ' ' + sm.t('stats.times'),
                style: SmText.bodyMedium.copyWith(color: scheme.onSurface),
              ),
              const SizedBox(height: SM.space50),
              Text(
                formatListenDuration(book.totalMs),
                style: SmText.bodySmall.copyWith(color: scheme.onSurfaceVariant),
              ),
            ],
          ),
        ],
      ),
    );
  }
}
