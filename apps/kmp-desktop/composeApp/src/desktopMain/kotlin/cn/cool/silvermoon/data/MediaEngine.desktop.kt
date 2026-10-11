package cn.cool.silvermoon.data

import uk.co.caprica.vlcj.factory.MediaPlayerFactory
import uk.co.caprica.vlcj.player.embedded.EmbeddedMediaPlayer

actual fun createMediaEngine(): MediaEngine {
    // libvlc 缺失（没装 VLC、或位数不匹配）时不能抛给上层：应用要照常起来。
    return runCatching { VlcjMediaEngine() as MediaEngine }
        .getOrElse { UnavailableMediaEngine(it.message ?: "libvlc 不可用") }
}

/**
 * 基于 libvlc 的播放内核。
 *
 * 选 VLCJ 而不是自己接 FFmpeg：桌面端本来就要处理 mp3/flac/m4a/mp4/mkv/hls 一大票格式，
 * libvlc 一套全包，且与 web 端 Tauri 版实际依赖的 VLC 行为一致（换源、无损拖进度）。
 *
 * 已知限制：这一版只接音频链路。视频画面需要把 libvlc 的 video surface 挂到
 * AWT Canvas 上再经 Compose 的 SwingPanel 嵌入（见 docs/ROADMAP.md 的"视频画面"），
 * 在补齐之前视频文件会走声音 + 无画面。
 */
private class VlcjMediaEngine : MediaEngine {

    private val factory = MediaPlayerFactory()
    private val player: EmbeddedMediaPlayer = factory.mediaPlayers().newEmbeddedMediaPlayer()

    override val available: Boolean = true
    override val backendName: String = "libvlc (VLCJ " + VLCJ_VERSION + ")"

    private var prepared: String? = null

    override fun prepare(path: String) {
        prepared = path
        player.media().prepare(path)
    }

    override fun play() {
        player.controls().play()
    }

    override fun pause() {
        player.controls().setPause(true)
    }

    override fun stop() {
        player.controls().stop()
    }

    override fun seekTo(positionMs: Long) {
        player.controls().setTime(positionMs)
    }

    /** percent 是 0-100，libvlc 的 volume 量程是 0-200（100 为原始增益）。 */
    override fun setVolume(percent: Int) {
        player.audio().setVolume(percent.coerceIn(0, 100) * 2)
    }

    override fun positionMs(): Long = runCatching { player.status().time() }.getOrDefault(0L)

    override fun durationMs(): Long = runCatching { player.status().length() }.getOrDefault(0L)

    override fun isPlaying(): Boolean = runCatching { player.status().isPlaying }.getOrDefault(false)

    override fun currentPath(): String? = prepared

    override fun release() {
        runCatching { player.release() }
        runCatching { factory.release() }
    }

    private companion object {
        const val VLCJ_VERSION = "4.x"
    }
}

/** libvlc 不可用时的占位内核：所有操作都是安全的空操作。 */
private class UnavailableMediaEngine(private val reason: String) : MediaEngine {
    override val available: Boolean = false
    override val backendName: String = "不可用（" + reason + "）"

    override fun prepare(path: String) = Unit
    override fun play() = Unit
    override fun pause() = Unit
    override fun stop() = Unit
    override fun seekTo(positionMs: Long) = Unit
    override fun setVolume(percent: Int) = Unit
    override fun positionMs(): Long = 0L
    override fun durationMs(): Long = 0L
    override fun isPlaying(): Boolean = false
    override fun currentPath(): String? = null
    override fun release() = Unit
}
