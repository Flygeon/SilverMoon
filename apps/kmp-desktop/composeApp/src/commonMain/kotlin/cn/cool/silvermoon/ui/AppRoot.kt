package cn.cool.silvermoon.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.cool.silvermoon.bridge.SilverMoonJson
import cn.cool.silvermoon.data.ScanJobInfo
import cn.cool.silvermoon.data.platformIsDarkMode
import cn.cool.silvermoon.design.SilverMoonStaticTheme
import cn.cool.silvermoon.design.SilverMoonTheme
import cn.cool.silvermoon.design.ThemeMode
import cn.cool.silvermoon.di.AppContainer
import cn.cool.silvermoon.ui.nav.Destination
import cn.cool.silvermoon.ui.screens.parseArgb
import cn.cool.silvermoon.ui.shell.AppShell
import cn.cool.silvermoon.ui.shell.WindowControls
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * 应用根：主题 -> 外壳 -> 页面。
 *
 * 主题的取色种子来自设置（Monet），模式三态；窗口控制由平台层注入。
 */
@Composable
fun SilverMoonApp(container: AppContainer, controls: WindowControls) {
    val settings by container.settings.state.collectAsState()
    val mode = when (settings.themeMode) {
        "dark" -> ThemeMode.Dark
        "light" -> ThemeMode.Light
        else -> ThemeMode.System
    }
    var destination by remember {
        mutableStateOf(Destination.fromLibraryKind(settings.lastLibraryKind))
    }

    SilverMoonTheme(
        mode = mode,
        seedColor = parseArgb(settings.seedColorHex),
        isSystemDark = platformIsDarkMode(),
    ) {
        LaunchedEffect(Unit) {
            // 首屏数据 + 扫描进度订阅。失败只记在 store 的 error 里，不阻断界面。
            container.library.refresh()
            container.backend.events(listOf("scan:progress")).collect { event ->
                if (event.event != "scan:progress") return@collect
                runCatching {
                    SilverMoonJson.decodeFromJsonElement(ScanJobInfo.serializer(), event.payload)
                }.onSuccess { container.library.onScanProgress(it) }
            }
        }
        AppShell(
            container = container,
            controls = controls,
            destination = destination,
            onNavigate = { destination = it },
        )
    }
}

/**
 * 启动画面：后端桥进程拉起期间（首次运行要等 Rust 侧建库）显示进度，
 * 失败时把 [message] 原样贴出来 —— 这类失败必须让用户看见原因。
 */
@Composable
fun StartupScreen(message: String?) {
    SilverMoonStaticTheme(dark = platformIsDarkMode()) {
        Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.fillMaxSize()) {
            Column(
                modifier = Modifier.fillMaxSize().padding(48.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (message == null) {
                    CircularProgressIndicator()
                    Text("正在启动 Rust 后端…", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "首次启动要建索引库，可能要几秒。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    Text("后端启动失败", style = MaterialTheme.typography.titleLarge)
                    Text(
                        text = message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
    }
}
