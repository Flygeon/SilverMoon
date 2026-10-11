package cn.cool.silvermoon.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * 播放状态机。
 *
 * 队列语义与 web 端 src/stores/player.ts 对齐：顺序播放 + 单曲循环 + 随机；
 * 真实的解码/输出交给 [MediaEngine]（桌面端是 libvlc），这里只维护状态。
 */
class PlayerStore(
    private val scope: CoroutineScope,
    val engine: MediaEngine,
    private val settings: SettingsStore,
) {
    private val _queue = MutableStateFlow<List<MediaEntry>>(emptyList())
    val queue: StateFlow<List<MediaEntry>> = _queue.asStateFlow()

    private val _index = MutableStateFlow(-1)
    val index: StateFlow<Int> = _index.asStateFlow()

    private val _playing = MutableStateFlow(false)
    val playing: StateFlow<Boolean> = _playing.asStateFlow()

    private val _positionMs = MutableStateFlow(0L)
    val positionMs: StateFlow<Long> = _positionMs.asStateFlow()

    private val _durationMs = MutableStateFlow(0L)
    val durationMs: StateFlow<Long> = _durationMs.asStateFlow()

    private val _shuffle = MutableStateFlow(false)
    val shuffle: StateFlow<Boolean> = _shuffle.asStateFlow()

    private val _repeatOne = MutableStateFlow(false)
    val repeatOne: StateFlow<Boolean> = _repeatOne.asStateFlow()

    /** 当前曲目；队列或下标变化时自动重算。 */
    val current: StateFlow<MediaEntry?> =
        combine(_queue, _index) { queue, index -> queue.getOrNull(index) }
            .stateIn(scope, SharingStarted.Eagerly, null)

    init {
        engine.setVolume(settings.state.value.volume)
        // 播放位置轮询：libvlc 没有推送式回调，500ms 一次够画进度条了
        scope.launch {
            while (true) {
                delay(500)
                if (_playing.value) {
                    _positionMs.value = engine.positionMs()
                    val total = engine.durationMs()
                    if (total > 0) _durationMs.value = total
                    if (!engine.isPlaying()) _playing.value = false
                }
            }
        }
        scope.launch {
            settings.state.map { it.volume }.distinctUntilChanged().collect { engine.setVolume(it) }
        }
    }

    fun setQueue(entries: List<MediaEntry>, startIndex: Int = 0) {
        _queue.value = entries
        if (entries.isEmpty()) {
            _index.value = -1
            return
        }
        playAt(startIndex.coerceIn(0, entries.size - 1))
    }

    fun playAt(index: Int) {
        val entry = _queue.value.getOrNull(index) ?: return
        _index.value = index
        _positionMs.value = 0L
        _durationMs.value = entry.durationMs ?: 0L
        if (engine.available) {
            engine.prepare(entry.path)
            engine.play()
            _playing.value = true
        } else {
            _playing.value = false
        }
    }

    fun toggle() {
        if (!engine.available) return
        if (_playing.value) {
            engine.pause()
            _playing.value = false
        } else {
            if (current.value == null) {
                playAt(0)
            } else {
                engine.play()
                _playing.value = true
            }
        }
    }

    fun next() {
        val size = _queue.value.size
        if (size == 0) return
        val step = if (_shuffle.value) (1..size).random() else 1
        playAt((_index.value + step) % size)
    }

    fun previous() {
        val size = _queue.value.size
        if (size == 0) return
        playAt((_index.value - 1 + size) % size)
    }

    fun seekTo(positionMs: Long) {
        if (!engine.available) return
        engine.seekTo(positionMs.coerceAtLeast(0L))
        _positionMs.value = positionMs
    }

    fun setVolume(percent: Int) = settings.setVolume(percent)

    fun toggleShuffle() {
        _shuffle.value = !_shuffle.value
    }

    fun toggleRepeatOne() {
        _repeatOne.value = !_repeatOne.value
    }

    fun stop() {
        engine.stop()
        _playing.value = false
        _positionMs.value = 0L
    }
}
