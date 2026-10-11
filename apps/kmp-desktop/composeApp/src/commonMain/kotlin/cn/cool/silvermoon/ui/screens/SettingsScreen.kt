package cn.cool.silvermoon.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import cn.cool.silvermoon.data.chooseDirectory
import cn.cool.silvermoon.data.platformAppDataDir
import cn.cool.silvermoon.design.silverMoon
import cn.cool.silvermoon.di.AppContainer

/** 动态取色的预设种子（前两个取自 web 端默认主题）。 */
private val SEED_PRESETS = listOf(
    "FF1A5C9E" to "银月蓝",
    "FF6B5778" to "暮紫",
    "FF2E6B4F" to "松绿",
    "FF9E5A1A" to "琥珀",
    "FF7A1F3D" to "绯红",
)

@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(container: AppContainer) {
    val tokens = silverMoon
    val settings by container.settings.state.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(tokens.contentPadding),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Text("设置", style = MaterialTheme.typography.headlineSmall)

        SettingSection("外观") {
            SettingRow("主题") {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("system" to "跟随系统", "light" to "浅色", "dark" to "深色").forEach { (value, label) ->
                        FilterChip(
                            selected = settings.themeMode == value,
                            onClick = { container.settings.setThemeMode(value) },
                            label = { Text(label) },
                        )
                    }
                }
            }
            SettingRow("动态取色（Monet）") {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    SEED_PRESETS.forEach { (hex, name) ->
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            modifier = Modifier.clickable { container.settings.setSeedColor(hex) },
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(36.dp)
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(parseArgb(hex)),
                            )
                            Text(
                                text = name,
                                style = MaterialTheme.typography.labelSmall,
                                color = if (settings.seedColorHex == hex) MaterialTheme.colorScheme.primary
                                else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }

        HorizontalDivider()

        SettingSection("媒体库") {
            SettingRow("扫描目录") {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (settings.scanDirs.isEmpty()) {
                        Text(
                            "还没有目录。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    settings.scanDirs.forEach { dir ->
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(dir, style = MaterialTheme.typography.bodySmall)
                            Spacer(Modifier.width(6.dp))
                            IconButton(
                                onClick = {
                                    container.settings.setScanDirs(settings.scanDirs.filterNot { it == dir })
                                },
                            ) {
                                Icon(Icons.Filled.Close, contentDescription = "移除", modifier = Modifier.size(16.dp))
                            }
                        }
                    }
                    TextButton(
                        onClick = {
                            val picked = chooseDirectory("选择要加入媒体库的目录")
                            if (picked != null) {
                                container.settings.setScanDirs(settings.scanDirs + picked)
                            }
                        },
                    ) {
                        Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("添加目录")
                    }
                }
            }
        }

        HorizontalDivider()

        SettingSection("关于") {
            val handshake = container.backend.handshake
            SettingRow("后端") {
                Text(
                    text = "Rust 桥进程 pid=" + handshake.pid +
                        "，协议 v" + handshake.protocol +
                        "，已桥接 " + handshake.commands + " 条命令（127.0.0.1:" + handshake.port + "）",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            SettingRow("数据目录") {
                Text(
                    text = platformAppDataDir(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            SettingRow("播放内核") {
                Text(
                    text = container.player.engine.backendName,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun SettingSection(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        content()
    }
}

@Composable
private fun SettingRow(label: String, content: @Composable () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.width(140.dp),
        )
        Box(Modifier.weight(1f)) { content() }
    }
}

/** #RRGGBB / AARRGGBB / RRGGBB 都能吃。 */
internal fun parseArgb(hex: String, fallback: Color = Color(0xFF1A5C9E)): Color {
    val cleaned = hex.removePrefix("#")
    return when (cleaned.length) {
        8 -> cleaned.toLongOrNull(16)?.let { Color(it) } ?: fallback
        6 -> cleaned.toLongOrNull(16)?.let { Color(0xFF000000L or it) } ?: fallback
        else -> fallback
    }
}
