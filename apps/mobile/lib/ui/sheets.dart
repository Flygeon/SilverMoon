import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models/audio_effect_config.dart';
import '../models/track.dart';
import '../services/player_service.dart';
import '../state/settings_controller.dart';
import '../theme/design_tokens.dart';
import 'widgets.dart';

const Color _sheetBg = Color(0xFF141416);
const Color _sheetFg = Color(0xFFFFFFFF);
const Color _sheetSub = Color(0x99FFFFFF);

/// 把 5 区域预设铺成 10 段增益
AudioEffectConfig presetToConfig(AudioEffectConfig base, String name) {
  final List<double>? zones = kMobilePresets[name];
  if (zones == null) return base;
  final List<EqBand> bands = <EqBand>[];
  for (final double f in kEqFrequencies) {
    final int z = eqZoneIndex(f);
    bands.add(EqBand(frequency: f, gain: z < zones.length ? zones[z] : 0));
  }
  return base.copyWith(eqBands: bands, presetId: name, enabled: true);
}

/// 播放队列面板（支持拖拽排序、移除、清空、随机）
void showQueueSheet(BuildContext context) {
  final PlayerService player = context.read<PlayerService>();
  showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    backgroundColor: _sheetBg,
    builder: (BuildContext c) => ChangeNotifierProvider<PlayerService>.value(
      value: player,
      child: const _QueueSheet(),
    ),
  );
}

class _QueueSheet extends StatelessWidget {
  const _QueueSheet();

  @override
  Widget build(BuildContext context) {
    final PlayerService player = context.watch<PlayerService>();
    final List<Track> queue = player.queue;
    final double h = MediaQuery.of(context).size.height * 0.68;

    return SizedBox(
      height: h,
      child: Column(
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 12, 6),
            child: Row(
              children: <Widget>[
                const Text(
                  '播放队列',
                  style: TextStyle(
                    color: _sheetFg,
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  queue.length.toString() + ' 首',
                  style: const TextStyle(color: _sheetSub, fontSize: 12.5),
                ),
                const Spacer(),
                IconButton(
                  tooltip: '随机播放',
                  icon: Icon(
                    Icons.shuffle_rounded,
                    color: player.shuffleEnabled ? const Color(0xFF9ECAFE) : _sheetSub,
                  ),
                  onPressed: () => player.toggleShuffle(),
                ),
                TextButton(
                  onPressed: queue.isEmpty ? null : () => player.clearQueue(),
                  child: const Text('清空'),
                ),
              ],
            ),
          ),
          const Divider(height: 1, color: PlayerTokens.divider),
          Expanded(
            child: queue.isEmpty
                ? const Center(
                    child: Text('队列是空的', style: TextStyle(color: _sheetSub)),
                  )
                : ReorderableListView.builder(
                    padding: const EdgeInsets.only(bottom: 20),
                    itemCount: queue.length,
                    onReorder: (int oldIndex, int newIndex) {
                      int target = newIndex;
                      if (target > oldIndex) target -= 1;
                      player.moveInQueue(oldIndex, target);
                    },
                    itemBuilder: (BuildContext c, int i) {
                      final Track t = queue[i];
                      final bool current = i == player.currentIndex;
                      return Container(
                        key: ValueKey<String>('q-' + t.id + '-' + i.toString()),
                        color: current
                            ? PlayerTokens.currentQueueItem
                            : Colors.transparent,
                        child: ListTile(
                          dense: true,
                          leading: CoverArt(track: t, size: 42, radius: 8),
                          title: Text(
                            t.displayTitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: current ? const Color(0xFF9ECAFE) : _sheetFg,
                              fontWeight: current ? FontWeight.w700 : FontWeight.w500,
                              fontSize: 14,
                            ),
                          ),
                          subtitle: Text(
                            t.displayArtist,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: _sheetSub, fontSize: 12),
                          ),
                          trailing: IconButton(
                            tooltip: current ? '正在播放，不可移除' : '从队列移除',
                            icon: Icon(
                              Icons.close_rounded,
                              size: 18,
                              color: current ? const Color(0x44FFFFFF) : _sheetSub,
                            ),
                            onPressed: current
                                ? null
                                : () async {
                                    final bool ok = await player.removeFromQueue(i);
                                    if (!ok && c.mounted) {
                                      ScaffoldMessenger.of(c).showSnackBar(
                                        const SnackBar(content: Text('正在播放的曲目不能移除')),
                                      );
                                    }
                                  },
                          ),
                          onTap: () => player.playAt(i),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

/// 音效面板
void showEffectsSheet(BuildContext context) {
  final SettingsController settings = context.read<SettingsController>();
  final PlayerService player = context.read<PlayerService>();
  AudioEffectConfig cfg = settings.effects;

  showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    backgroundColor: _sheetBg,
    builder: (BuildContext c) {
      return StatefulBuilder(
        builder: (BuildContext c, StateSetter setSheet) {
          void push(AudioEffectConfig next) {
            cfg = next;
            setSheet(() {});
            settings.setEffects(next);
            player.setEffects(next);
          }

          final bool hw = player.effects.available;
          final List<double> bands = player.effects.bandFrequencies;

          return SizedBox(
            height: MediaQuery.of(c).size.height * 0.78,
            child: Column(
              children: <Widget>[
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 8),
                  child: Row(
                    children: <Widget>[
                      const Text(
                        '音效',
                        style: TextStyle(
                          color: _sheetFg,
                          fontSize: 17,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const Spacer(),
                      Switch(
                        value: cfg.enabled,
                        onChanged: (bool v) => push(cfg.copyWith(enabled: v)),
                      ),
                    ],
                  ),
                ),
                const Divider(height: 1, color: PlayerTokens.divider),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
                    children: <Widget>[
                      if (!hw)
                        Container(
                          margin: const EdgeInsets.only(bottom: 12),
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: const Color(0x1FFFFFFF),
                            borderRadius: BorderRadius.circular(12),
                          ),
                          child: const Text(
                            '当前设备未提供硬件均衡器（仅 Android 支持硬件音效）。'
                            '参数仍会保存，但不影响播放。',
                            style: TextStyle(color: _sheetSub, fontSize: 12, height: 1.5),
                          ),
                        ),
                      const Text(
                        '预设',
                        style: TextStyle(color: _sheetFg, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: <Widget>[
                          for (final MapEntry<String, List<double>> e
                              in kMobilePresets.entries)
                            ChoiceChip(
                              label: Text(e.key),
                              selected: cfg.presetId == e.key,
                              onSelected: (bool v) {
                                if (!v) return;
                                push(presetToConfig(cfg, e.key));
                              },
                            ),
                          for (final AudioEffectPreset p in kBuiltinPresets)
                            ChoiceChip(
                              label: Text(p.name),
                              selected: cfg.presetId == p.id,
                              onSelected: (bool v) {
                                if (!v) return;
                                final AudioEffectConfig next = p.toConfig();
                                push(next.copyWith(enabled: true));
                              },
                            ),
                        ],
                      ),
                      const SizedBox(height: 18),
                      const Text(
                        '均衡器',
                        style: TextStyle(color: _sheetFg, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(height: 4),
                      SizedBox(
                        height: 190,
                        child: ListView.builder(
                          scrollDirection: Axis.horizontal,
                          itemCount: cfg.eqBands.length,
                          itemBuilder: (BuildContext c, int i) {
                            final EqBand b = cfg.eqBands[i];
                            final double min = player.effects.minDecibels;
                            final double max = player.effects.maxDecibels;
                            return SizedBox(
                              width: 46,
                              child: Column(
                                children: <Widget>[
                                  Text(
                                    b.gainLabel,
                                    style: const TextStyle(
                                      color: _sheetSub,
                                      fontSize: 11,
                                    ),
                                  ),
                                  Expanded(
                                    child: RotatedBox(
                                      quarterTurns: 3,
                                      child: SliderTheme(
                                        data: SliderTheme.of(c).copyWith(
                                          trackHeight: 3,
                                          activeTrackColor: const Color(0xFF9ECAFE),
                                          inactiveTrackColor: const Color(0x33FFFFFF),
                                          thumbColor: _sheetFg,
                                          thumbShape: const RoundSliderThumbShape(
                                            enabledThumbRadius: 6,
                                          ),
                                          overlayShape: const RoundSliderOverlayShape(
                                            overlayRadius: 12,
                                          ),
                                        ),
                                        child: Slider(
                                          value: b.gain.clamp(min, max).toDouble(),
                                          min: min,
                                          max: max,
                                          onChanged: (double v) {
                                            final List<EqBand> next =
                                                List<EqBand>.from(cfg.eqBands);
                                            next[i] = b.copyWith(gain: v);
                                            push(cfg
                                                .copyWith(eqBands: next, presetId: 'custom')
                                                .copyWith(enabled: true));
                                          },
                                        ),
                                      ),
                                    ),
                                  ),
                                  Text(
                                    b.label,
                                    style: const TextStyle(
                                      color: _sheetSub,
                                      fontSize: 10.5,
                                    ),
                                  ),
                                ],
                              ),
                            );
                          },
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        '设备实际频段：' + bands.map((double f) => f.round().toString()).join(' / '),
                        style: const TextStyle(color: _sheetSub, fontSize: 11),
                      ),
                      const SizedBox(height: 18),
                      _row(
                        label: '低音增强',
                        value: cfg.bassBoost.round().toString() + ' dB',
                        child: Slider(
                          value: cfg.bassBoost.clamp(-12.0, 12.0).toDouble(),
                          min: -12,
                          max: 12,
                          divisions: 24,
                          onChanged: (double v) => push(
                            cfg.copyWith(bassBoost: v.roundToDouble()).copyWith(enabled: true),
                          ),
                        ),
                      ),
                      const SizedBox(height: 8),
                      _unsupported('混响', '桌面端由 Web Audio ConvolverNode 实现，移动端无等价能力'),
                      _unsupported('立体声宽度', '桌面端由 Web Audio Splitter/Merger 矩阵实现，移动端无等价能力'),
                    ],
                  ),
                ),
              ],
            ),
          );
        },
      );
    },
  );
}

Widget _row({required String label, required String value, required Widget child}) {
  return Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: <Widget>[
      Row(
        children: <Widget>[
          Text(label, style: const TextStyle(color: _sheetFg, fontWeight: FontWeight.w600)),
          const Spacer(),
          Text(value, style: const TextStyle(color: _sheetSub, fontSize: 12)),
        ],
      ),
      child,
    ],
  );
}

Widget _unsupported(String label, String reason) {
  return Padding(
    padding: const EdgeInsets.only(top: 10),
    child: Opacity(
      opacity: 0.45,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.block_rounded, color: _sheetSub, size: 16),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  label + '（移动端不可用）',
                  style: const TextStyle(color: _sheetFg, fontSize: 13),
                ),
                const SizedBox(height: 2),
                Text(reason, style: const TextStyle(color: _sheetSub, fontSize: 11.5, height: 1.4)),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}
