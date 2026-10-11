package cn.cool.silvermoon.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

/**
 * 应用设置。
 *
 * web 端把设置放在 tauri-plugin-store（前端侧 KV）；KMP 版没有 WebView，
 * 于是落到同目录下的一个 JSON 文件，语义不变：读一次、改一个就落盘。
 *
 * 字段刻意保持"少而稳"：页面自己要的展示态不放这里，只有跨会话需要记住的才进。
 */
@Serializable
data class AppSettings(
    /** system | light | dark —— 与 web 端设置项的取值一致。 */
    val themeMode: String = "system",
    /** Monet 动态取色的种子色，ARGB 十六进制（默认取 web 端浅色 primary）。 */
    val seedColorHex: String = "FF1A5C9E",
    /** 媒体库扫描目录（白名单模式）。 */
    val scanDirs: List<String> = emptyList(),
    /** 小于该体积的文件不进媒体库。 */
    val minSize: Long = 0,
    /** 播放器音量（0-100）。 */
    val volume: Int = 80,
    /** 上次打开的库页签，冷启动直接回到这里。 */
    val lastLibraryKind: String = "image",
)

/**
 * 设置的读写与持久化。
 *
 * 落盘用 platformWriteSettings（desktop 上是 %APPDATA%/SilverMoon/kmp-settings.json），
 * 写失败只记日志不抛：设置写不进去不该让整个应用崩。
 */
class SettingsStore(private val scope: CoroutineScope) {

    private val _state = MutableStateFlow(loadFromDisk())
    val state: StateFlow<AppSettings> = _state.asStateFlow()

    private fun loadFromDisk(): AppSettings {
        val text = runCatching { platformReadSettings() }.getOrNull() ?: return AppSettings()
        return runCatching {
            cn.cool.silvermoon.bridge.SilverMoonJson.decodeFromString(
                AppSettings.serializer(),
                text,
            )
        }.getOrElse { AppSettings() }
    }

    /** 更新设置并落盘。updater 返回值即新设置。 */
    fun update(updater: (AppSettings) -> AppSettings) {
        val next = updater(_state.value)
        _state.value = next
        scope.launch {
            runCatching {
                platformWriteSettings(
                    cn.cool.silvermoon.bridge.SilverMoonJson.encodeToString(
                        AppSettings.serializer(),
                        next,
                    ),
                )
            }
        }
    }

    fun setThemeMode(mode: String) = update { it.copy(themeMode = mode) }
    fun setSeedColor(hex: String) = update { it.copy(seedColorHex = hex) }
    fun setScanDirs(dirs: List<String>) = update { it.copy(scanDirs = dirs) }
    fun setMinSize(bytes: Long) = update { it.copy(minSize = bytes) }
    fun setVolume(volume: Int) = update { it.copy(volume = volume.coerceIn(0, 100)) }
    fun setLastLibraryKind(kind: String) = update { it.copy(lastLibraryKind = kind) }
}
