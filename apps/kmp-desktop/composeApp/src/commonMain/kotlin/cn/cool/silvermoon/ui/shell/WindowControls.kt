package cn.cool.silvermoon.ui.shell

import androidx.compose.runtime.Composable

/**
 * 无边框窗口的控制能力。
 *
 * 由 desktop 层（WindowScope + AWT 的 Window）实现后注入；commonMain 只依赖这个接口，
 * 因此 Android/iOS 目标接进来时把实现换成系统原生窗口装饰即可。
 */
interface WindowControls {
    fun minimize()
    fun toggleMaximize()
    fun close()

    /** 当前是否最大化，用于切换标题栏上的图标。 */
    fun isMaximized(): Boolean

    /**
     * 把一段内容包成「按住可拖动窗口」的区域。
     *
     * 由平台层实现：桌面端是 Compose 官方的 WindowDraggableArea
     * （androidx.compose.foundation.window），内部走系统原生拖动 ——
     * 拖动、贴边吸附、多显示器都由系统处理。
     *
     * 它是 WindowScope 的扩展函数，只有窗口内容的直接上下文才调得到，
     * 所以由桌面层持有 WindowScope 并把能力透出来，UI 层不碰这个平台细节。
     */
    @Composable
    fun DragRegion(content: @Composable () -> Unit)
}
