package cn.cool.silvermoon.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * 与 Rust 后端过桥的数据模型。
 *
 * 字段与 apps/desktop/src-tauri/src/lib.rs 里的 MediaEntry / MediaMetadata /
 * commands::ScanJobInfo 一一对应（camelCase 过桥，Rust 侧用 serde rename_all）。
 * 默认值给全，是为了让 Rust 侧将来加字段/去掉可选字段时前端不至于整体崩掉。
 */
@Serializable
data class MediaEntry(
    val id: String = "",
    val path: String = "",
    val parent: String = "",
    val name: String = "",
    val ext: String = "",
    @SerialName("type") val type: String = "",
    val size: Long = 0,
    val mtime: Long = 0,
    val scannedAt: Long = 0,
    val deleted: Long = 0,
    val title: String? = null,
    val artist: String? = null,
    val album: String? = null,
    val durationMs: Long? = null,
    val width: Long? = null,
    val height: Long? = null,
    val codec: String? = null,
    val fps: Double? = null,
    val takenAt: Long? = null,
    val hasCover: Boolean = false,
    val favorite: Boolean = false,
    val thumbPath: String? = null,
) {
    /** 列表主标题：优先元数据标题，回落到文件名（与 web 端一致）。 */
    val displayTitle: String get() = title?.takeIf { it.isNotBlank() } ?: name

    /** 副标题：艺术家/专辑，或图片尺寸、视频编码。 */
    val displaySubtitle: String
        get() = when (type) {
            "audio" -> listOfNotNull(artist, album).filter { it.isNotBlank() }.joinToString(" · ")
            "image" -> if (width != null && height != null) (width.toString() + " x " + height) else ""
            "video" -> listOfNotNull(codec, durationMs?.let { formatDuration(it) }).joinToString(" · ")
            else -> ""
        }
}

/** 与 Rust 侧 ScanConfig 对应。 */
@Serializable
data class ScanConfig(
    val dirs: List<String> = emptyList(),
    val mode: String = "whitelist",
    val maxDepth: Int? = null,
    val followLinks: Boolean = false,
    val forceReparse: Boolean = false,
)

@Serializable
data class ScanStartResult(val jobId: String = "")

@Serializable
data class ScanJobInfo(
    val jobId: String = "",
    val stage: String = "",
    val done: Int = 0,
    val total: Int = 0,
    val percent: Double = 0.0,
    val currentPath: String = "",
    val added: Int = 0,
    val updated: Int = 0,
    val removed: Int = 0,
    val error: String? = null,
) {
    val running: Boolean get() = stage != "done" && stage != "cancelled" && stage != "error"
}

/** 与 Rust 侧 ListQuery 对应（type 是保留字，映射到 kind）。 */
@Serializable
data class ListQuery(
    @SerialName("type") val kind: String? = null,
    val search: String? = null,
    val sortBy: String? = null,
    val desc: Boolean? = null,
    val minSize: Long? = null,
    val limit: Long? = null,
    val offset: Long? = null,
)

/** library_counts 的返回：type -> 条数。 */
@Serializable
data class LibraryCounts(
    val image: Long = 0,
    val video: Long = 0,
    val audio: Long = 0,
    val book: Long = 0,
) {
    fun of(type: String): Long = when (type) {
        "image" -> image
        "video" -> video
        "audio" -> audio
        "book" -> book
        else -> 0
    }

    companion object {
        fun fromMap(map: Map<String, Long>): LibraryCounts = LibraryCounts(
            image = map["image"] ?: 0,
            video = map["video"] ?: 0,
            audio = map["audio"] ?: 0,
            book = map["book"] ?: 0,
        )
    }
}

/** host_app / host_path 这类通用宿主命令的原始返回。 */
typealias HostValue = JsonElement

/** 把毫秒格式化成 3:05 / 1:02:33。 */
fun formatDuration(millis: Long): String {
    val totalSeconds = millis / 1000
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60
    fun two(value: Long): String = if (value < 10) "0" + value else value.toString()
    return if (hours > 0) hours.toString() + ":" + two(minutes) + ":" + two(seconds)
    else minutes.toString() + ":" + two(seconds)
}

/** 人类可读的文件体积。 */
fun formatSize(bytes: Long): String {
    if (bytes < 1024) return bytes.toString() + " B"
    val units = listOf("KB", "MB", "GB", "TB")
    var value = bytes.toDouble() / 1024.0
    var index = 0
    while (value >= 1024.0 && index < units.size - 1) {
        value /= 1024.0
        index++
    }
    return ((value * 10).toLong() / 10.0).toString() + " " + units[index]
}
