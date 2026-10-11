package cn.cool.silvermoon.ui.shell

import androidx.compose.foundation.window.WindowDraggableArea
import androidx.compose.runtime.Composable

@Composable
actual fun WindowDragArea(content: @Composable () -> Unit) {
    WindowDraggableArea { content() }
}
