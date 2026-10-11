package cn.cool.silvermoon.ui.shell

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

    /** 自绘标题栏拖动：按屏幕坐标增量移动窗口。 */
    fun dragBy(dx: Float, dy: Float)
}
