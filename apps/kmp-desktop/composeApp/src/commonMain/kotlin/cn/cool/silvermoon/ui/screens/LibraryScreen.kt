package cn.cool.silvermoon.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cn.cool.silvermoon.data.MediaEntry
import cn.cool.silvermoon.data.ScanConfig
import cn.cool.silvermoon.design.silverMoon
import cn.cool.silvermoon.di.AppContainer
import cn.cool.silvermoon.ui.nav.Destination
import coil3.compose.AsyncImage

/**
 * 媒体库页（图片 / 视频 / 音乐 / 书籍共用）。
 *
 * 与 web 端 ImagesView / VideosView / MusicView / BooksView 共用同一套列表面板：
 * 类型只是 list_files 的一个过滤条件，取数据、分页、缩略图缓存全在后端。
 */
@Composable
fun LibraryScreen(
    container: AppContainer,
    destination: Destination,
    onNavigate: (Destination) -> Unit,
) {
    val tokens = silverMoon
    val entries by container.library.entries.collectAsState()
    val loading by container.library.loading.collectAsState()
    val error by container.library.error.collectAsState()
    val scan by container.library.scan.collectAsState()
    val settings by container.settings.state.collectAsState()
    var search by remember { mutableStateOf("") }

    // 切页签时同步过滤条件并重新取数
    LaunchedEffect(destination) {
        val kind = destination.libraryKind ?: return@LaunchedEffect
        container.library.setKind(kind)
        container.settings.setLastLibraryKind(kind)
    }

    Column(Modifier.fillMaxSize()) {
        LibraryToolbar(
            title = destination.label,
            count = entries.size,
            search = search,
            onSearch = {
                search = it
                container.library.setSearch(it)
            },
            onRefresh = { container.library.refresh() },
            onScan = {
                container.library.startScan(ScanConfig(dirs = settings.scanDirs, mode = "whitelist"))
            },
            canScan = settings.scanDirs.isNotEmpty(),
        )

        val runningScan = scan
        if (runningScan != null && runningScan.running) {
            Column(Modifier.fillMaxWidth().padding(horizontal = tokens.contentPadding)) {
                LinearProgressIndicator(
                    progress = { (runningScan.percent / 100.0).toFloat().coerceIn(0f, 1f) },
                    modifier = Modifier.fillMaxWidth(),
                )
                Text(
                    text = runningScan.stage + " " + runningScan.done + "/" + runningScan.total + "  " + runningScan.currentPath,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        if (error != null) {
            Text(
                text = error ?: "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = tokens.contentPadding, vertical = 4.dp),
            )
        }

        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                loading && entries.isEmpty() -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    CircularProgressIndicator()
                }

                entries.isEmpty() -> EmptyLibrary(destination, settings.scanDirs.isEmpty())

                else -> LazyVerticalGrid(
                    columns = GridCells.Adaptive(if (destination == Destination.Music) 200.dp else 168.dp),
                    contentPadding = PaddingValues(tokens.contentPadding),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(entries, key = { it.id }) { entry ->
                        MediaCard(entry) {
                            if (entry.type == "audio") {
                                container.player.setQueue(entries.filter { it.type == "audio" }, entries.filter { it.type == "audio" }.indexOf(entry))
                                onNavigate(Destination.Player)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LibraryToolbar(
    title: String,
    count: Int,
    search: String,
    onSearch: (String) -> Unit,
    onRefresh: () -> Unit,
    onScan: () -> Unit,
    canScan: Boolean,
) {
    val tokens = silverMoon
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = tokens.contentPadding, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge)
        Text(
            text = count.toString() + " 项",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.weight(1f))
        OutlinedTextField(
            value = search,
            onValueChange = onSearch,
            singleLine = true,
            leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
            placeholder = { Text("搜索") },
            modifier = Modifier.width(260.dp),
        )
        IconButton(onClick = onRefresh) {
            Icon(Icons.Filled.Refresh, contentDescription = "刷新")
        }
        FilledTonalButton(onClick = onScan, enabled = canScan) {
            Text("扫描")
        }
    }
}

@Composable
private fun EmptyLibrary(destination: Destination, needDirs: Boolean) {
    Column(
        modifier = Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("这里还没有内容", style = MaterialTheme.typography.titleMedium)
        Text(
            text = if (needDirs) {
                "先在“设置 - 媒体库目录”里加一个目录，再回到这里点“扫描”。"
            } else {
                "目录已经配好了，点右上角“扫描”让后端建立索引。"
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(
            text = "当前页签：" + destination.label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun MediaCard(entry: MediaEntry, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
            .padding(4.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        val model = entry.thumbPath ?: entry.path
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerHighest),
        ) {
            if (model.isNotBlank()) {
                AsyncImage(
                    model = toFileUri(model),
                    contentDescription = entry.name,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
        Text(
            text = entry.displayTitle,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        val subtitle = entry.displaySubtitle
        if (subtitle.isNotEmpty()) {
            Text(
                text = subtitle,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** 本地绝对路径 -> file URI（Coil 在桌面端按 URI 选 fetcher）。 */
internal fun toFileUri(path: String): String {
    if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("file:")) {
        return path
    }
    val normalized = path.replace('\\', '/')
    return if (normalized.startsWith("/")) "file://" + normalized else "file:///" + normalized
}
