package cn.cool.silvermoon.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FilterNone
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.CropSquare
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.cool.silvermoon.data.MediaEntry
import cn.cool.silvermoon.design.silverMoon
import cn.cool.silvermoon.di.AppContainer
import cn.cool.silvermoon.ui.nav.Destination
import cn.cool.silvermoon.ui.screens.LibraryScreen
import cn.cool.silvermoon.ui.screens.PlayerScreen
import cn.cool.silvermoon.ui.screens.PlaceholderScreen
import cn.cool.silvermoon.ui.screens.SettingsScreen

/**
 * 应用外壳。
 *
 * 结构与 web 端 src/App.vue 对齐：
 *   标题栏（48dp，自绘，无系统装饰） / 左侧导航栏（88dp） / 内容区（padding 24dp）
 *   / 底部迷你播放器（72dp）。
 */
@Composable
fun AppShell(
    container: AppContainer,
    controls: WindowControls,
    destination: Destination,
    onNavigate: (Destination) -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            AppTitleBar(controls, destination)
            Row(Modifier.weight(1f).fillMaxWidth()) {
                AppNavigationRail(container, destination, onNavigate)
                Box(
                    Modifier
                        .width(1.dp)
                        .fillMaxHeight()
                        .background(MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f)),
                )
                Box(Modifier.weight(1f).fillMaxHeight()) {
                    AppContent(container, destination, onNavigate)
                }
            }
            MiniPlayer(container, onNavigate)
        }
    }
}

@Composable
private fun AppContent(
    container: AppContainer,
    destination: Destination,
    onNavigate: (Destination) -> Unit,
) {
    when (destination) {
        Destination.Images,
        Destination.Videos,
        Destination.Music,
        Destination.Books,
        -> LibraryScreen(container, destination, onNavigate)

        Destination.Player -> PlayerScreen(container, onNavigate)
        Destination.Settings -> SettingsScreen(container)

        Destination.Folders -> PlaceholderScreen(
            title = "文件夹",
            summary = "按目录树浏览已索引的媒体。数据面（list_files 按 parent 聚合）已就绪，视图待补。",
        )

        Destination.Favorites -> PlaceholderScreen(
            title = "收藏",
            summary = "收藏列表读取 files 与 favorites 的联表结果，MediaEntry.favorite 已经在过桥数据里。",
        )

        Destination.History -> PlaceholderScreen(
            title = "历史",
            summary = "播放历史与 listen_stats 统计由后端 stats 命令提供，等待列表视图接入。",
        )

        Destination.Treasure -> PlaceholderScreen(
            title = "百宝箱",
            summary = "音效预设市场 / osu! 谱面 / WebDAV / 时长统计 / 阅读统计 / 回收站 / 扩展，后端命令全部已桥接。",
        )
    }
}

// ---------------------------------------------------------------------------
// 标题栏
// ---------------------------------------------------------------------------

@Composable
private fun AppTitleBar(controls: WindowControls, destination: Destination) {
    val tokens = silverMoon
    var maximized by androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(controls.isMaximized()) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(tokens.titleBarHeight)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .pointerInput(Unit) {
                // 自绘标题栏要自己实现拖动与双击最大化（等价于系统标题栏的行为）
                detectDragGestures { _, dragAmount ->
                    controls.dragBy(dragAmount.x, dragAmount.y)
                }
            }
            .pointerInput(Unit) {
                detectTapGestures(
                    onDoubleTap = {
                        controls.toggleMaximize()
                        maximized = controls.isMaximized()
                    },
                )
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(Modifier.width(16.dp))
        Text(
            text = "SilverMoon",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.width(12.dp))
        Text(
            text = destination.label,
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.primary,
            fontWeight = FontWeight.Medium,
        )
        Spacer(Modifier.weight(1f))
        TitleBarButton(onClick = { controls.minimize() }) {
            Icon(Icons.Filled.Remove, contentDescription = "最小化", modifier = Modifier.size(18.dp))
        }
        TitleBarButton(onClick = {
            controls.toggleMaximize()
            maximized = controls.isMaximized()
        }) {
            Icon(
                if (maximized) Icons.Filled.FilterNone else Icons.Filled.CropSquare,
                contentDescription = "最大化",
                modifier = Modifier.size(16.dp),
            )
        }
        TitleBarButton(onClick = { controls.close() }, danger = true) {
            Icon(Icons.Filled.Close, contentDescription = "关闭", modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun TitleBarButton(
    onClick: () -> Unit,
    danger: Boolean = false,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = Modifier
            .size(width = 46.dp, height = 48.dp)
            .clickable(onClick = onClick)
            .background(
                if (danger) MaterialTheme.colorScheme.error.copy(alpha = 0.0f)
                else MaterialTheme.colorScheme.surfaceContainer,
            ),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.runtime.CompositionLocalProvider(
            androidx.compose.material3.LocalContentColor provides MaterialTheme.colorScheme.onSurfaceVariant,
            content = content,
        )
    }
}

// ---------------------------------------------------------------------------
// 导航栏
// ---------------------------------------------------------------------------

@Composable
private fun AppNavigationRail(
    container: AppContainer,
    destination: Destination,
    onNavigate: (Destination) -> Unit,
) {
    val tokens = silverMoon
    val counts by container.library.counts.collectAsState()

    Column(
        modifier = Modifier
            .width(tokens.navRailWidth)
            .fillMaxHeight()
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .padding(vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Destination.primary.forEach { item ->
            val badge = item.libraryKind?.let { counts.of(it) } ?: 0L
            NavRailItem(item, destination == item, badge, onNavigate)
        }
        Spacer(Modifier.weight(1f))
        NavRailItem(Destination.Settings, destination == Destination.Settings, 0L, onNavigate)
    }
}

@Composable
private fun NavRailItem(
    item: Destination,
    selected: Boolean,
    badge: Long,
    onNavigate: (Destination) -> Unit,
) {
    Column(
        modifier = Modifier
            .width(72.dp)
            .clip(RoundedCornerShape(16.dp))
            .clickable { onNavigate(item) }
            .padding(vertical = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            modifier = Modifier
                .size(width = 56.dp, height = 32.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(
                    if (selected) MaterialTheme.colorScheme.secondaryContainer
                    else MaterialTheme.colorScheme.surfaceContainerLow,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = item.icon,
                contentDescription = item.label,
                modifier = Modifier.size(20.dp),
                tint = if (selected) MaterialTheme.colorScheme.onSecondaryContainer
                else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Text(
            text = item.label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) MaterialTheme.colorScheme.onSurface
            else MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (badge > 0) {
            Text(
                text = badge.toString(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                fontSize = 10.sp,
            )
        } else {
            Spacer(Modifier.height(12.dp))
        }
    }
}

// ---------------------------------------------------------------------------
// 迷你播放器
// ---------------------------------------------------------------------------

@Composable
private fun MiniPlayer(container: AppContainer, onNavigate: (Destination) -> Unit) {
    val tokens = silverMoon
    val current by container.player.current.collectAsState()
    val playing by container.player.playing.collectAsState()
    val position by container.player.positionMs.collectAsState()
    val duration by container.player.durationMs.collectAsState()

    val track = current
    if (track == null) {
        Spacer(Modifier.height(0.dp))
        return
    }
    val fraction = if (duration > 0) (position.toFloat() / duration.toFloat()).coerceIn(0f, 1f) else 0f

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .height(tokens.miniPlayerHeight)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .clickable { onNavigate(Destination.Player) },
    ) {
        LinearProgressIndicator(
            progress = { fraction },
            modifier = Modifier.fillMaxWidth().height(2.dp),
        )
        Row(
            modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TrackThumb(track)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    text = track.displayTitle,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val subtitle = track.displaySubtitle
                if (subtitle.isNotEmpty()) {
                    Text(
                        text = subtitle,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            IconButton(onClick = { container.player.previous() }) {
                Icon(Icons.Filled.SkipPrevious, contentDescription = "上一首")
            }
            IconButton(onClick = { container.player.toggle() }) {
                Icon(
                    if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = if (playing) "暂停" else "播放",
                )
            }
            IconButton(onClick = { container.player.next() }) {
                Icon(Icons.Filled.SkipNext, contentDescription = "下一首")
            }
        }
    }
}

/** 封面占位：有缩略图缓存就画图，没有就画一个圆角字母块。 */
@Composable
internal fun TrackThumb(entry: MediaEntry, size: androidx.compose.ui.unit.Dp = 44.dp) {
    Box(
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceContainerHighest),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = entry.displayTitle.take(1).uppercase(),
            style = MaterialTheme.typography.titleMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
