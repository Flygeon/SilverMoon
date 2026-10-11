package cn.cool.silvermoon.data

import cn.cool.silvermoon.bridge.BackendBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put

/**
 * 媒体库状态。
 *
 * 与 web 端 src/stores/library.ts 对应：一份 counts（导航栏角标）+ 一份
 * 按当前查询条件取回的 entries，外加扫描任务的进度。
 *
 * 数据全部来自复用中的 Rust 后端（list_files / library_counts / scan_*），
 * Kotlin 侧只做缓存与状态收敛，不重复实现任何扫描或索引逻辑。
 */
class LibraryStore(
    private val bridge: BackendBridge,
    private val scope: CoroutineScope,
    private val json: Json = cn.cool.silvermoon.bridge.SilverMoonJson,
) {
    private val _counts = MutableStateFlow(LibraryCounts())
    val counts: StateFlow<LibraryCounts> = _counts.asStateFlow()

    private val _entries = MutableStateFlow<List<MediaEntry>>(emptyList())
    val entries: StateFlow<List<MediaEntry>> = _entries.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _scan = MutableStateFlow<ScanJobInfo?>(null)
    val scan: StateFlow<ScanJobInfo?> = _scan.asStateFlow()

    /** 当前列表对应的类型（image/video/audio/book），空串表示不过滤。 */
    private val _kind = MutableStateFlow("image")
    val kind: StateFlow<String> = _kind.asStateFlow()

    private val _search = MutableStateFlow("")
    val search: StateFlow<String> = _search.asStateFlow()

    private val _sortBy = MutableStateFlow("name")
    val sortBy: StateFlow<String> = _sortBy.asStateFlow()

    private val _descending = MutableStateFlow(false)
    val descending: StateFlow<Boolean> = _descending.asStateFlow()

    fun setKind(value: String) {
        if (_kind.value == value) return
        _kind.value = value
        refresh()
    }

    fun setSearch(value: String) {
        _search.value = value
        refresh()
    }

    fun setSort(sortBy: String, desc: Boolean) {
        _sortBy.value = sortBy
        _descending.value = desc
        refresh()
    }

    suspend fun loadCounts() {
        runCatching {
            val raw = bridge.invokeRaw("library_counts", emptyMap())
            json.decodeFromJsonElement(
                MapSerializer(String.serializer(), Long.serializer()),
                raw,
            )
        }.onSuccess { _counts.value = LibraryCounts.fromMap(it) }
            .onFailure { _error.value = it.message }
    }

    suspend fun loadEntries() {
        _loading.value = true
        try {
            val query = buildListQuery()
            val raw = bridge.invokeRaw("list_files", mapOf("query" to query))
            val entries = json.decodeFromJsonElement(ListSerializer(MediaEntry.serializer()), raw)
            _entries.value = entries
            _error.value = null
        } catch (error: Exception) {
            _error.value = error.message
        } finally {
            _loading.value = false
        }
    }

    private fun buildListQuery(): JsonElement = buildJsonObject {
        val kindValue = _kind.value
        if (kindValue.isNotEmpty()) put("type", kindValue)
        val searchValue = _search.value.trim()
        if (searchValue.isNotEmpty()) put("search", searchValue)
        put("sortBy", _sortBy.value)
        put("desc", _descending.value)
        put("limit", 2000)
        put("offset", 0)
    }

    /** 重新拉取列表 + 角标。 */
    fun refresh() {
        scope.launch {
            loadEntries()
            loadCounts()
        }
    }

    /** 触发一次目录扫描；进度由 scan:progress 事件驱动（见 SilverMoonApp 的订阅）。 */
    fun startScan(config: ScanConfig) {
        scope.launch {
            try {
                val raw = bridge.invokeRaw(
                    "scan_start",
                    mapOf("config" to json.encodeToJsonElement(ScanConfig.serializer(), config)),
                )
                val started = json.decodeFromJsonElement(ScanStartResult.serializer(), raw)
                _scan.value = ScanJobInfo(jobId = started.jobId, stage = "enumerate")
            } catch (error: Exception) {
                _error.value = error.message
            }
        }
    }

    fun cancelScan() {
        val job = _scan.value ?: return
        scope.launch {
            runCatching {
                bridge.invokeRaw("scan_cancel", mapOf("jobId" to JsonPrimitive(job.jobId)))
            }
        }
    }

    /** 把 scan:progress 事件塞进状态（由事件订阅统一调用）。 */
    fun onScanProgress(info: ScanJobInfo) {
        _scan.value = info
        if (!info.running) refresh()
    }
}
