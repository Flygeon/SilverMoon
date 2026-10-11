package cn.cool.silvermoon

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberWindowState
import cn.cool.silvermoon.bridge.BackendBridge
import cn.cool.silvermoon.bridge.launchBackendProcess
import cn.cool.silvermoon.di.AppContainer
import cn.cool.silvermoon.ui.SilverMoonApp
import cn.cool.silvermoon.ui.StartupScreen
import cn.cool.silvermoon.ui.shell.WindowControls
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.HttpTimeoutConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import javax.swing.JFrame

/**
 * KMP 桌面端入口。
 *
 * 与 web 端 Tauri 版的进程模型一致：**业务后端仍然由 Rust 承担**，只是换了宿主 ——
 * 这里把 silvermoon_bridge.exe 作为子进程拉起，两者用本机回环 HTTP 通信，
 * 命令名、参数、返回值与 Tauri 的 invoke 完全相同（见 bridge 包）。
 */
fun main() = application {
    val windowState = rememberWindowState(size = DpSize(1280.dp, 800.dp))
    var container by remember { mutableStateOf<AppContainer?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { bootstrap() }
            .onSuccess { container = it }
            .onFailure { failure = it.message ?: it.toString() }
    }

    Window(
        onCloseRequest = {
            container?.close()
            exitApplication()
        },
        state = windowState,
        undecorated = true,
        title = "SilverMoon",
    ) {
        val ready = container
        if (ready == null) {
            StartupScreen(failure)
        } else {
            SilverMoonApp(ready, rememberWindowControls(window))
        }
    }
}

/** 拉起 Rust 后端并组装对象图。 */
private fun bootstrap(): AppContainer {
    val process = launchBackendProcess()
    val client = HttpClient(CIO) {
        expectSuccess = false
        install(HttpTimeout) {
            requestTimeoutMillis = 120_000
            // SSE 长连接不能有 socket 超时，否则事件流会被客户端自己掐断
            socketTimeoutMillis = HttpTimeoutConfig.INFINITE_TIMEOUT_MS
        }
    }
    val bridge = BackendBridge(process.handshake, client)
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    return AppContainer(bridge, process, scope)
}

/** 把 AWT 窗口能力包装成 commonMain 认识的接口。 */
@Composable
private fun rememberWindowControls(frame: JFrame): WindowControls = remember(frame) {
    object : WindowControls {
        private val maximizedFlag = JFrame.MAXIMIZED_BOTH

        override fun minimize() {
            frame.extendedState = frame.extendedState or JFrame.ICONIFIED
        }

        override fun toggleMaximize() {
            frame.extendedState = if (isMaximized()) {
                JFrame.NORMAL
            } else {
                JFrame.MAXIMIZED_BOTH
            }
        }

        override fun close() {
            frame.dispatchEvent(
                java.awt.event.WindowEvent(frame, java.awt.event.WindowEvent.WINDOW_CLOSING),
            )
        }

        override fun isMaximized(): Boolean = (frame.extendedState and maximizedFlag) != 0
    }
}
