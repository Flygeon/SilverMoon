package cn.cool.silvermoon.data

/**
 * 播放内核抽象。
 *
 * 桌面端用 libvlc（VLCJ）实现，缺失时降级为不可用引擎 —— 界面照常显示，
 * 只是点播放会给出可读提示，而不是整个应用起不来。
 */
interface MediaEngine {
    /** 内核是否可用（libvlc 是否加载成功）。 */
    val available: Boolean

    /** 内核名称，显示在设置页的"关于"里。 */
    val backendName: String

    fun prepare(path: String)
    fun play()
    fun pause()
    fun stop()
    fun seekTo(positionMs: Long)
    fun setVolume(percent: Int)

    fun positionMs(): Long
    fun durationMs(): Long
    fun isPlaying(): Boolean
    fun currentPath(): String?

    fun release()
}

/** 由平台层创建播放内核。 */
expect fun createMediaEngine(): MediaEngine
