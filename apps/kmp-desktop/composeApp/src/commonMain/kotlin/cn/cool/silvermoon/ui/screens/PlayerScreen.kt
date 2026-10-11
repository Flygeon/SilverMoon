package cn.cool.silvermoon.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Repeat
import androidx.compose.material.icons.filled.RepeatOne
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.SkipNext
import androidx.compose.material.icons.filled.SkipPrevious
import androidx.compose.material.icons.filled.VolumeUp
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cn.cool.silvermoon.data.formatDuration
import cn.cool.silvermoon.design.silverMoon
import cn.cool.silvermoon.di.AppContainer
import cn.cool.silvermoon.ui.nav.Destination
import coil3.compose.AsyncImage

/**
 * 全屏播放页（web 端 PlayerView 的核心区域）。
 *
 * 逐字歌词、流体背景、音效面板这些还在路上（见 docs/PARITY.md），
 * 这一版先把「能选曲、能播、能拖进度、音量可控」跑通 —— 这些已经全部走真实后端与 libvlc。
 */
@Composable
fun PlayerScreen(container: AppContainer, onNavigate: (Destination) -> Unit) {
    val tokens = silverMoon
    val current by container.player.current.collectAsState()
    val playing by container.player.playing.collectAsState()
    val position by container.player.positionMs.collectAsState()
    val duration by container.player.durationMs.collectAsState()
    val shuffle by container.player.shuffle.collectAsState()
    val repeatOne by container.player.repeatOne.collectAsState()
    val settings by container.settings.state.collectAsState()

    val track = current
    if (track == null) {
        Column(
            modifier = Modifier.fillMaxSize().padding(tokens.contentPadding),
            verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text("还没有在放的东西", style = MaterialTheme.typography.titleMedium)
            Text(
                "去音乐页双击一首歌，或在列表里点一下播放。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }

    val fraction = if (duration > 0) (position.toFloat() / duration.toFloat()).coerceIn(0f, 1f) else 0f

    Column(
        modifier = Modifier.fillMaxSize().padding(tokens.contentPadding),
        verticalArrangement = Arrangement.spacedBy(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (!container.player.engine.available) {
            Text(
                text = "播放内核不可用：" + container.player.engine.backendName + "。装一个 VLC（或设置 VLC_PLUGIN_PATH）后重启即可。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
            )
        }
        Box(
            modifier = Modifier
                .fillMaxWidth(0.42f)
                .aspectRatio(1f)
                .clip(RoundedCornerShape(24.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerHighest),
        ) {
            AsyncImage(
                model = toFileUri(track.path),
                contentDescription = track.displayTitle,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        }
        Text(
            text = track.displayTitle,
            style = MaterialTheme.typography.headlineSmall,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        val subtitle = track.displaySubtitle
        if (subtitle.isNotEmpty()) {
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(0.6f),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(formatDuration(position), style = MaterialTheme.typography.labelSmall)
            Slider(
                value = fraction,
                onValueChange = { value ->
                    container.player.seekTo((value * duration).toLong())
                },
                modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
            )
            Text(formatDuration(duration), style = MaterialTheme.typography.labelSmall)
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            IconButton(onClick = { container.player.toggleShuffle() }) {
                Icon(
                    Icons.Filled.Shuffle,
                    contentDescription = "随机",
                    tint = if (shuffle) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = { container.player.previous() }) {
                Icon(Icons.Filled.SkipPrevious, contentDescription = "上一首", modifier = Modifier.size(32.dp))
            }
            FilledIconButton(onClick = { container.player.toggle() }, modifier = Modifier.size(64.dp)) {
                Icon(
                    if (playing) Icons.Filled.Pause else Icons.Filled.PlayArrow,
                    contentDescription = if (playing) "暂停" else "播放",
                    modifier = Modifier.size(32.dp),
                )
            }
            IconButton(onClick = { container.player.next() }) {
                Icon(Icons.Filled.SkipNext, contentDescription = "下一首", modifier = Modifier.size(32.dp))
            }
            IconButton(onClick = { container.player.toggleRepeatOne() }) {
                Icon(
                    if (repeatOne) Icons.Filled.RepeatOne else Icons.Filled.Repeat,
                    contentDescription = "单曲循环",
                    tint = if (repeatOne) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Row(
            modifier = Modifier.fillMaxWidth(0.4f),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.VolumeUp, contentDescription = "音量", modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Slider(
                value = settings.volume.toFloat(),
                onValueChange = { container.player.setVolume(it.toInt()) },
                valueRange = 0f..100f,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Text(settings.volume.toString(), style = MaterialTheme.typography.labelSmall)
        }

        Spacer(Modifier.height(8.dp))
        Text(
            text = "播放输出：" + container.player.engine.backendName,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
