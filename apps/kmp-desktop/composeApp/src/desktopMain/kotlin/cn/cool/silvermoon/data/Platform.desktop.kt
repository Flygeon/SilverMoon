package cn.cool.silvermoon.data

import cn.cool.silvermoon.bridge.appDataDir
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption

private const val SETTINGS_FILE = "kmp-settings.json"

private fun settingsFile(): File = File(appDataDir(), SETTINGS_FILE)

actual fun platformReadSettings(): String? {
    val file = settingsFile()
    if (!file.isFile) return null
    return runCatching { file.readText() }.getOrNull()
}

actual fun platformWriteSettings(text: String) {
    val file = settingsFile()
    val parent = file.parentFile ?: return
    parent.mkdirs()
    val tmp = File(parent, SETTINGS_FILE + ".tmp")
    tmp.writeText(text)
    runCatching {
        Files.move(
            tmp.toPath(),
            file.toPath(),
            StandardCopyOption.REPLACE_EXISTING,
        )
    }.onFailure {
        // 极端情况下（文件被占用）退化成直接覆盖，写不进去也不抛
        runCatching { file.writeText(text) }
        tmp.delete()
    }
}

actual fun platformAppDataDir(): String = appDataDir().absolutePath

/**
 * Windows 深色模式：读 HKCU 的 AppsUseLightTheme。
 *
 * 用 java.util.prefs 而不是 JNA：JDK 在 Windows 上的 Preferences 后端就是注册表，
 * 一行拿到值，也不必为了一个开关去碰 Win32。
 */
actual fun platformIsDarkMode(): Boolean = runCatching {
    val prefs = java.util.prefs.Preferences.userRoot()
        .node("/Software/Microsoft/Windows/CurrentVersion/Themes/Personalize")
    prefs.getInt("AppsUseLightTheme", 1) == 0
}.getOrDefault(false)

/**
 * 目录选择器。
 *
 * 用 Swing 的 JFileChooser 而不是自己经 JNA 调 IFileDialog：Windows 上 JDK 走的
 * 就是同一套 Win32 公共对话框，外观一致，但不用自己管 COM 生命周期与模态消息循环。
 */
actual fun chooseDirectory(title: String): String? {
    val chooser = javax.swing.JFileChooser()
    chooser.dialogTitle = title
    chooser.fileSelectionMode = javax.swing.JFileChooser.DIRECTORIES_ONLY
    chooser.isMultiSelectionEnabled = false
    val result = chooser.showOpenDialog(null)
    if (result != javax.swing.JFileChooser.APPROVE_OPTION) return null
    return chooser.selectedFile?.absolutePath
}
