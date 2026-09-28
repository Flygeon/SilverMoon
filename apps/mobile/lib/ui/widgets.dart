import 'dart:io';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';

import '../models/track.dart';
import '../services/artwork_service.dart';

/// 专辑封面：优先网络封面，其次本地内嵌封面，最后占位。
class CoverArt extends StatelessWidget {
  const CoverArt({
    super.key,
    required this.track,
    this.size,
    this.radius = 12,
    this.width,
    this.height,
    this.heroTag,
  });

  final Track? track;
  final double? size;
  final double radius;
  final double? width;
  final double? height;
  final Object? heroTag;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final Track? t = track;
    final String? url = t?.coverUrl;
    Widget child;
    if (url != null && url.trim().isNotEmpty) {
      child = CachedNetworkImage(
        imageUrl: url.trim(),
        fit: BoxFit.cover,
        fadeInDuration: const Duration(milliseconds: 220),
        placeholder: (BuildContext c, String u) => _placeholder(scheme),
        errorWidget: (BuildContext c, String u, Object e) => _fallback(scheme, t),
      );
    } else if (t != null && t.filePath != null) {
      child = FutureBuilder<Uri?>(
        future: ArtworkService.artUri(t),
        builder: (BuildContext c, AsyncSnapshot<Uri?> snap) {
          final Uri? u = snap.data;
          if (u == null) return _fallback(scheme, t);
          return Image.file(
            File(u.toFilePath()),
            fit: BoxFit.cover,
            errorBuilder: (BuildContext c2, Object e, StackTrace? s) =>
                _fallback(scheme, t),
          );
        },
      );
    } else {
      child = _fallback(scheme, t);
    }

    final Widget clipped = ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: SizedBox(
        width: size ?? width,
        height: size ?? height,
        child: child,
      ),
    );
    if (heroTag != null) {
      return Hero(tag: heroTag!, child: clipped);
    }
    return clipped;
  }

  Widget _placeholder(ColorScheme scheme) => Container(
        color: scheme.surfaceContainerHighest.withValues(alpha: 0.5),
        child: const Center(
          child: SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
        ),
      );

  Widget _fallback(ColorScheme scheme, Track? t) => Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: <Color>[
              scheme.primaryContainer,
              scheme.surfaceContainerHighest,
            ],
          ),
        ),
        child: Center(
          child: Icon(
            Icons.music_note_rounded,
            color: scheme.onPrimaryContainer.withValues(alpha: 0.7),
            size: 28,
          ),
        ),
      );
}

/// M3E 风格分段控件：药丸底 + 动画滑块
class SmSegmented<T> extends StatelessWidget {
  const SmSegmented({
    super.key,
    required this.values,
    required this.labels,
    required this.selected,
    required this.onChanged,
    this.icons,
    this.dense = false,
  });

  final List<T> values;
  final List<String> labels;
  final List<IconData>? icons;
  final T selected;
  final ValueChanged<T> onChanged;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    final int index = values.indexOf(selected).clamp(0, values.length - 1);
    final double h = dense ? 36 : 44;
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints c) {
        final double seg = c.maxWidth / values.length;
        return SizedBox(
          height: h,
          child: Stack(
            children: <Widget>[
              Container(
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHighest.withValues(alpha: 0.55),
                  borderRadius: BorderRadius.circular(h / 2),
                ),
              ),
              AnimatedPositioned(
                duration: const Duration(milliseconds: 260),
                curve: Curves.easeOutCubic,
                left: seg * index,
                top: 0,
                bottom: 0,
                width: seg,
                child: Padding(
                  padding: const EdgeInsets.all(4),
                  child: Container(
                    decoration: BoxDecoration(
                      color: scheme.primary,
                      borderRadius: BorderRadius.circular((h - 8) / 2),
                    ),
                  ),
                ),
              ),
              Row(
                children: List<Widget>.generate(values.length, (int i) {
                  final bool on = i == index;
                  final Color fg = on ? scheme.onPrimary : scheme.onSurfaceVariant;
                  return Expanded(
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => onChanged(values[i]),
                      child: Center(
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: <Widget>[
                            if (icons != null) ...<Widget>[
                              Icon(icons![i], size: dense ? 15 : 17, color: fg),
                              const SizedBox(width: 6),
                            ],
                            Flexible(
                              child: Text(
                                labels[i],
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  fontSize: dense ? 12.5 : 13.5,
                                  fontWeight: on ? FontWeight.w600 : FontWeight.w500,
                                  color: fg,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  );
                }),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// 区块标题
class SmSectionHeader extends StatelessWidget {
  const SmSectionHeader({
    super.key,
    required this.title,
    this.action,
    this.onAction,
  });

  final String title;
  final String? action;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final ThemeData theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 20, 12, 8),
      child: Row(
        children: <Widget>[
          Text(
            title,
            style: theme.textTheme.titleMedium?.copyWith(
              fontWeight: FontWeight.w700,
              letterSpacing: 0.2,
            ),
          ),
          const Spacer(),
          if (action != null)
            TextButton(
              onPressed: onAction,
              child: Text(action!),
            ),
        ],
      ),
    );
  }
}

/// 空态
class SmEmptyState extends StatelessWidget {
  const SmEmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.subtitle,
    this.actionLabel,
    this.onAction,
  });

  final IconData icon;
  final String title;
  final String? subtitle;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 40),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: <Widget>[
            Container(
              width: 88,
              height: 88,
              decoration: BoxDecoration(
                color: scheme.primaryContainer.withValues(alpha: 0.5),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, size: 40, color: scheme.onPrimaryContainer),
            ),
            const SizedBox(height: 20),
            Text(
              title,
              textAlign: TextAlign.center,
              style: Theme.of(context)
                  .textTheme
                  .titleMedium
                  ?.copyWith(fontWeight: FontWeight.w600),
            ),
            if (subtitle != null) ...<Widget>[
              const SizedBox(height: 8),
              Text(
                subtitle!,
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: scheme.onSurfaceVariant,
                      height: 1.5,
                    ),
              ),
            ],
            if (actionLabel != null && onAction != null) ...<Widget>[
              const SizedBox(height: 22),
              FilledButton.tonal(
                onPressed: onAction,
                child: Text(actionLabel!),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 圆形图标按钮（播放器控制条用）
class SmCircleButton extends StatelessWidget {
  const SmCircleButton({
    super.key,
    required this.icon,
    required this.onTap,
    this.size = 44,
    this.iconSize = 22,
    this.filled = false,
    this.active = false,
    this.tooltip,
  });

  final IconData icon;
  final VoidCallback? onTap;
  final double size;
  final double iconSize;
  final bool filled;
  final bool active;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    Color bg = Colors.transparent;
    Color fg = scheme.onSurface;
    if (filled) {
      bg = scheme.primary;
      fg = scheme.onPrimary;
    } else if (active) {
      bg = scheme.primaryContainer.withValues(alpha: 0.7);
      fg = scheme.onPrimaryContainer;
    }
    final Widget btn = Material(
      color: bg,
      shape: const CircleBorder(),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: SizedBox(
          width: size,
          height: size,
          child: Icon(icon, size: iconSize, color: fg),
        ),
      ),
    );
    if (tooltip != null) {
      return Tooltip(message: tooltip!, child: btn);
    }
    return btn;
  }
}

/// 细长进度条（播放器与迷你播放器共用）
class SmProgressBar extends StatelessWidget {
  const SmProgressBar({
    super.key,
    required this.value,
    this.onChanged,
    this.height = 6,
    this.activeHeight = 12,
    this.thumb = false,
  });

  final double value;
  final ValueChanged<double>? onChanged;
  final double height;
  final double activeHeight;
  final bool thumb;

  @override
  Widget build(BuildContext context) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return SliderTheme(
      data: SliderTheme.of(context).copyWith(
        trackHeight: height,
        activeTrackColor: scheme.primary,
        inactiveTrackColor: scheme.onSurface.withValues(alpha: 0.18),
        thumbColor: thumb ? scheme.primary : Colors.transparent,
        thumbShape: thumb
            ? const RoundSliderThumbShape(enabledThumbRadius: 7)
            : const RoundSliderThumbShape(enabledThumbRadius: 0.1),
        overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
        trackShape: const RoundedRectSliderTrackShape(),
      ),
      child: Slider(
        value: value.clamp(0.0, 1.0),
        onChanged: onChanged,
      ),
    );
  }
}

String twoDigits(int n) => n < 10 ? '0' + n.toString() : n.toString();

String formatDurationShort(Duration? d) {
  if (d == null) return '--:--';
  final int total = d.inSeconds;
  final int h = total ~/ 3600;
  final int m = (total % 3600) ~/ 60;
  final int s = total % 60;
  if (h > 0) return h.toString() + ':' + twoDigits(m) + ':' + twoDigits(s);
  return twoDigits(m) + ':' + twoDigits(s);
}
