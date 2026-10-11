package cn.cool.silvermoon.bridge

import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.prepareGet
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * 全局 JSON 配置。
 *
 * ignoreUnknownKeys 是必须的：Rust 侧的 struct 会持续加字段，前端不该因为多了
 * 一个未知键就整体反序列化失败（web 端的 TS 是结构性类型，天然容忍）。
 */
val SilverMoonJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    encodeDefaults = true
    explicitNulls = false
    coerceInputValues = true
}

/** 桥进程的握手信息（由 Rust 侧 bridge::BridgeInfo 序列化而来）。 */
@Serializable
data class BackendHandshake(
    val protocol: Int = 1,
    val port: Int = 0,
    val token: String = "",
    val pid: Int = 0,
    val commands: Int = 0,
)

@Serializable
private data class RpcRequest(val cmd: String, val args: Map<String, JsonElement> = emptyMap())

@Serializable
private data class RpcResponse(
    val ok: Boolean = false,
    val data: JsonElement? = null,
    val error: String? = null,
)

/** 服务端推送的一条事件（对应 Tauri 的 listen 回调）。 */
@Serializable
data class BridgeEvent(
    val type: String = "event",
    val event: String = "",
    val payload: JsonElement = JsonObject(emptyMap()),
)

/** 命令执行失败。message 就是 Rust 侧返回的原始错误字符串。 */
class BackendException(message: String) : Exception(message)

/**
 * 与 Rust 后端的唯一通道：本机回环 HTTP + 令牌。
 *
 * 语义与 web 端的 src/ipc/bridge.ts 完全一致：命令名 + camelCase 参数对象 -> 结果 JSON；
 * 失败以原始错误字符串抛出。
 */
class BackendBridge(
    val handshake: BackendHandshake,
    private val client: HttpClient,
    private val json: Json = SilverMoonJson,
) {
    val baseUrl: String = "http://127.0.0.1:" + handshake.port

    /** 调用一条命令，返回原始 JSON。 */
    suspend fun invokeRaw(cmd: String, args: Map<String, JsonElement> = emptyMap()): JsonElement {
        val response = client.post(baseUrl + "/rpc") {
            header(TOKEN_HEADER, handshake.token)
            contentType(ContentType.Application.Json)
            setBody(json.encodeToString(RpcRequest.serializer(), RpcRequest(cmd, args)))
        }
        val text = response.bodyAsText()
        val parsed = try {
            json.decodeFromString(RpcResponse.serializer(), text)
        } catch (error: Exception) {
            throw BackendException("命令 " + cmd + " 的响应无法解析: " + error.message)
        }
        if (!parsed.ok) {
            throw BackendException(parsed.error ?: ("命令 " + cmd + " 失败"))
        }
        return parsed.data ?: JsonObject(emptyMap())
    }

    /** 调用一条命令并反序列化成强类型结果。 */
    suspend fun <T> invoke(
        cmd: String,
        args: Map<String, JsonElement> = emptyMap(),
        deserializer: DeserializationStrategy<T>,
    ): T = json.decodeFromJsonElement(deserializer, invokeRaw(cmd, args))

    /**
     * 订阅后端事件（SSE）。
     *
     * 与 web 端的 listen() 等价：name 为空时订阅 Rust 侧默认转发的那批事件。
     * 这个 Flow 是冷流，取消收集即断开连接。
     */
    fun events(names: List<String> = emptyList()): Flow<BridgeEvent> = flow {
        val query = if (names.isEmpty()) "" else "?events=" + names.joinToString(",")
        val response = client.prepareGet(baseUrl + "/events" + query) {
            header(TOKEN_HEADER, handshake.token)
        }.execute()
        val channel = response.bodyAsChannel()
        while (true) {
            val line = channel.readUTF8Line() ?: break
            if (!line.startsWith(DATA_PREFIX)) continue
            val payload = line.substring(DATA_PREFIX.length).trim()
            if (payload.isEmpty()) continue
            val event = try {
                json.decodeFromString(BridgeEvent.serializer(), payload)
            } catch (_: Exception) {
                continue
            }
            emit(event)
        }
    }.flowOn(Dispatchers.IO)

    companion object {
        const val TOKEN_HEADER = "X-SilverMoon-Token"
        private const val DATA_PREFIX = "data:"
    }
}

/** 便捷包装：把 JsonElement 参数表写得更像普通函数调用。 */
fun argsOf(vararg pairs: Pair<String, JsonElement>): Map<String, JsonElement> = pairs.toMap()
