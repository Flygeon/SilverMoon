package cn.cool.silvermoon.di

import cn.cool.silvermoon.bridge.BackendBridge
import cn.cool.silvermoon.bridge.BackendProcess
import cn.cool.silvermoon.data.LibraryStore
import cn.cool.silvermoon.data.PlayerStore
import cn.cool.silvermoon.data.SettingsStore
import cn.cool.silvermoon.data.createMediaEngine
import kotlinx.coroutines.CoroutineScope

/**
 * 手写的组合根。
 *
 * 这里刻意不引 DI 框架：桌面端的对象图只有这几个（后端桥、三个状态容器、一个播放内核），
 * 手写构造函数的可读性反而更高，也不用为了三个单例去背一套容器 API。
 * 将来页面数量上来了（尤其是需要按路由构造 ViewModel 时）再换 Koin，边界很清楚。
 */
class AppContainer(
    val backend: BackendBridge,
    private val backendProcess: BackendProcess?,
    val scope: CoroutineScope,
) {
    val settings: SettingsStore = SettingsStore(scope)
    val library: LibraryStore = LibraryStore(backend, scope)
    val player: PlayerStore = PlayerStore(scope, createMediaEngine(), settings)

    /** 应用退出时收尾：先停播放内核，再关后端子进程。 */
    fun close() {
        runCatching { player.engine.release() }
        runCatching { backendProcess?.shutdown() }
    }
}
