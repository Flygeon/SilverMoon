package cn.cool.silvermoon.ui.shell

import androidx.compose.runtime.Composable

/**
 * 「按住此处可拖动窗口」的区域。
 *
 * 桌面端实现为 Compose 官方的 WindowDraggableArea，内部走系统原生拖动 ——
 * 多显示器、贴边吸附、DPI 缩放全交给系统，而不是自己在 AWT 坐标里挪窗口。
 *
 * 教训写在代码里：最初是 detectDragGestures + frame.location 手搓，
 * 实测拖两下窗口就被挪到屏幕外（任务栏还留着图标、窗口再也显示不出来）。
 * 其它平台接进来时，这一层直通即可（系统窗口本来就是可拖的）。
 */
@Composable
expect fun WindowDragArea(content: @Composable () -> Unit)
