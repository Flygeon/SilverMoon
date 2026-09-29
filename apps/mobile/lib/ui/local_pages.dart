import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/media_service.dart';
import '../state/media_controller.dart';
import 'book_reader_page.dart';
import 'image_viewer_page.dart';
import 'media_thumb.dart';
import 'video_player_page.dart';

// ---------------------------------------------------------------- 图片页签

class ImagesPage extends StatefulWidget {
  const ImagesPage({super.key});

  @override
  State<ImagesPage> createState() => _ImagesPageState();
}

class _ImagesPageState extends State<ImagesPage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<MediaController>().ensureLoaded(MediaKind.image);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final MediaController ctl = context.watch<MediaController>();
    return _MediaScaffold(
      title: '图片',
      kind: MediaKind.image,
      controller: ctl,
      emptyIcon: Icons.image_outlined,
      emptyText: '没有找到本地图片',
      bodyBuilder: (BuildContext c, List<MediaItem> items) => _imageGrid(c, items),
    );
  }

  Widget _imageGrid(BuildContext context, List<MediaItem> items) {
    return GridView.builder(
      padding: const EdgeInsets.all(2),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 3,
        mainAxisSpacing: 2,
        crossAxisSpacing: 2,
      ),
      itemCount: items.length,
      itemBuilder: (BuildContext c, int i) {
        final MediaItem item = items[i];
        return GestureDetector(
          onTap: () => Navigator.of(c).push(
            MaterialPageRoute<void>(
              builder: (_) =>
                  ImageViewerPage(items: items, initialIndex: i),
            ),
          ),
          child: Hero(
            tag: 'img:${item.path}',
            child: MediaThumb(item: item),
          ),
        );
      },
    );
  }
}

// ---------------------------------------------------------------- 视频页签

class VideosPage extends StatefulWidget {
  const VideosPage({super.key});

  @override
  State<VideosPage> createState() => _VideosPageState();
}

class _VideosPageState extends State<VideosPage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<MediaController>().ensureLoaded(MediaKind.video);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final MediaController ctl = context.watch<MediaController>();
    return _MediaScaffold(
      title: '视频',
      kind: MediaKind.video,
      controller: ctl,
      emptyIcon: Icons.movie_outlined,
      emptyText: '没有找到本地视频',
      bodyBuilder: (BuildContext c, List<MediaItem> items) => _fileList(
        c,
        items,
        Icons.play_circle_outline_rounded,
        (MediaItem it) {
          Navigator.of(c).push(
            MaterialPageRoute<void>(builder: (_) => VideoPlayerPage(item: it)),
          );
        },
        // 视频抽首帧当封面。之前这里是统一的图标占位，
        // 一列视频长得一模一样，根本认不出哪个是哪个。
        leading: (MediaItem it) => ClipRRect(
          borderRadius: BorderRadius.circular(8),
          child: SizedBox(
            width: 56,
            height: 56,
            child: MediaThumb(item: it, thumbSize: 160),
          ),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- 书籍页签

class BooksPage extends StatefulWidget {
  const BooksPage({super.key});

  @override
  State<BooksPage> createState() => _BooksPageState();
}

class _BooksPageState extends State<BooksPage> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<MediaController>().ensureLoaded(MediaKind.book);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final MediaController ctl = context.watch<MediaController>();
    return _MediaScaffold(
      title: '书籍',
      kind: MediaKind.book,
      controller: ctl,
      emptyIcon: Icons.menu_book_outlined,
      emptyText: '没有找到本地书籍',
      bodyBuilder: (BuildContext c, List<MediaItem> items) =>
          _fileList(c, items, Icons.description_outlined, (MediaItem it) {
        Navigator.of(c).push(
          MaterialPageRoute<void>(builder: (_) => BookReaderPage(item: it)),
        );
      }),
    );
  }
}

// ---------------------------------------------------------------- 公共部件

Widget _fileList(
  BuildContext context,
  List<MediaItem> items,
  IconData icon,
  void Function(MediaItem) onTap, {
  Widget Function(MediaItem)? leading,
}) {
  return ListView.separated(
    padding: const EdgeInsets.only(bottom: 96),
    itemCount: items.length,
    separatorBuilder: (_, __) => const Divider(height: 1, indent: 72),
    itemBuilder: (BuildContext c, int i) {
      final MediaItem item = items[i];
      return ListTile(
        leading: leading?.call(item) ??
            CircleAvatar(
              backgroundColor:
                  Theme.of(c).colorScheme.surfaceContainerHighest,
              child: Icon(icon, size: 20),
            ),
        title: Text(item.title,
            maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: Text(
          <String>[
            if (item.sizeLabel.isNotEmpty) item.sizeLabel,
            if (item.parentName.isNotEmpty) item.parentName,
          ].join(' · '),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 12),
        ),
        onTap: () => onTap(item),
      );
    },
  );
}

/// 三个页签共用的外壳：标题 + 刷新 + 加载/错误/空态。
class _MediaScaffold extends StatelessWidget {
  const _MediaScaffold({
    required this.title,
    required this.kind,
    required this.controller,
    required this.emptyIcon,
    required this.emptyText,
    required this.bodyBuilder,
  });

  final String title;
  final MediaKind kind;
  final MediaController controller;
  final IconData emptyIcon;
  final String emptyText;
  final Widget Function(BuildContext, List<MediaItem>) bodyBuilder;

  @override
  Widget build(BuildContext context) {
    final List<MediaItem> items = controller.items(kind);
    final bool loading = controller.isLoading(kind);
    final String? error = controller.errorOf(kind);

    Widget body;
    if (loading && items.isEmpty) {
      body = const Center(child: CircularProgressIndicator());
    } else if (items.isEmpty) {
      body = _empty(context, error);
    } else {
      body = bodyBuilder(context, items);
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        actions: <Widget>[
          if (items.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Center(
                child: Text(
                  '${items.length}',
                  style: TextStyle(
                    fontSize: 13,
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
            ),
          IconButton(
            tooltip: '重新扫描',
            icon: loading
                ? const SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.refresh_rounded),
            onPressed: loading ? null : () => controller.refresh(kind),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () => controller.refresh(kind),
        child: body,
      ),
    );
  }

  Widget _empty(BuildContext context, String? error) {
    final ColorScheme scheme = Theme.of(context).colorScheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: <Widget>[
        SizedBox(height: MediaQuery.of(context).size.height * 0.22),
        Icon(
          error != null ? Icons.folder_off_outlined : emptyIcon,
          size: 56,
          color: scheme.onSurfaceVariant.withValues(alpha: 0.6),
        ),
        const SizedBox(height: 14),
        Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 40),
            child: Text(
              error ?? emptyText,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: scheme.onSurfaceVariant,
                fontSize: 13.5,
                height: 1.6,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
