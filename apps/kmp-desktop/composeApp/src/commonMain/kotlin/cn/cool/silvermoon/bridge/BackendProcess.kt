package cn.cool.silvermoon.bridge

/**
 * Rust 后端进程句柄。
 *
 * KMP 桌面端复用 apps/desktop/src-tauri 的整套业务后端：它被编译成一个**无窗口**
 * 可执行文件（silvermoon_bridge.exe），由 Kotlin 侧作为子进程拉起，
 * 两者用本机回环 HTTP 通信。后端不做任何业务重写，只多了一层传输。
 */
interface BackendProcess {
    /** 端口 + 令牌；[launchBackendProcess] 返回时已经就绪。 */
    val handshake: BackendHandshake

    /** 关闭后端子进程。桥进程检测到 stdin 关闭时也会自行退出。 */
    fun shutdown()
}

/**
 * 拉起后端并等待握手。
 *
 * 找不到可执行文件、或进程在超时内没有写出握手文件时抛 [BackendException]，
 * 调用方据此给出可读的提示（而不是让窗口空着）。
 */
expect fun launchBackendProcess(): BackendProcess
