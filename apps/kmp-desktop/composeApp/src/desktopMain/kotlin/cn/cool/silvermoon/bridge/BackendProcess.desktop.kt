package cn.cool.silvermoon.bridge

import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit

actual fun launchBackendProcess(): BackendProcess = DesktopBackendProcess()

/**
 * Windows 上的后端进程实现。
 *
 * 生命周期约定：
 *   - 父进程启动子进程，并**保持 stdin 不被关闭**（Java 的 Process 只要还被引用就一直开着管道）；
 *   - 桥进程（Rust 侧）在读 stdin 拿到 EOF 时 self-exit，所以 Kotlin 侧异常退出也不会留下孤儿；
 *   - 正常退出走 [shutdown]：先 destroy，3 秒不退再 destroyForcibly。
 */
private class DesktopBackendProcess : BackendProcess {

    override lateinit var handshake: BackendHandshake
        private set

    private var process: Process? = null
    private var handshakeFile: File? = null

    init {
        boot()
    }

    private fun boot() {
        val executable = locateExecutable() ?: throw BackendException(
            "找不到 silvermoon_bridge.exe。" +
                "开发机上请先在 apps/desktop/src-tauri 执行 cargo build --release --bin silvermoon_bridge，" +
                "或用环境变量 SILVERMOON_BRIDGE_EXE 指定可执行文件路径。"
        )

        val handshakePath = File(
            System.getProperty("java.io.tmpdir"),
            "silvermoon-bridge-" + UUID.randomUUID() + ".json",
        )
        val log = File(appDataDir(), "bridge.log")
        log.parentFile?.mkdirs()

        val builder = ProcessBuilder(executable.absolutePath)
        builder.directory(executable.parentFile)
        builder.redirectErrorStream(true)
        builder.redirectOutput(ProcessBuilder.Redirect.appendTo(log))
        builder.environment()["SILVERMOON_BRIDGE_HANDSHAKE"] = handshakePath.absolutePath

        val child = try {
            builder.start()
        } catch (error: Exception) {
            throw BackendException("启动后端进程失败: " + error.message)
        }
        process = child
        handshakeFile = handshakePath

        val deadline = System.currentTimeMillis() + 120_000L
        while (System.currentTimeMillis() < deadline) {
            if (handshakePath.isFile) {
                val text = runCatching { handshakePath.readText() }.getOrDefault("")
                if (text.isNotBlank()) {
                    handshake = try {
                        SilverMoonJson.decodeFromString(BackendHandshake.serializer(), text)
                    } catch (error: Exception) {
                        throw BackendException("后端握手信息解析失败: " + text)
                    }
                    return
                }
            }
            if (!child.isAlive) {
                throw BackendException(
                    "后端进程提前退出（exit=" + child.exitValue() + "）。日志: " + log.absolutePath + tail(log)
                )
            }
            Thread.sleep(120L)
        }
        child.destroy()
        throw BackendException("等待后端握手超时（120 秒）。日志: " + log.absolutePath + tail(log))
    }

    override fun shutdown() {
        val child = process ?: return
        process = null
        runCatching {
            child.destroy()
            if (!child.waitFor(3, TimeUnit.SECONDS)) {
                child.destroyForcibly()
            }
        }
        handshakeFile?.delete()
    }
}

/** %APPDATA%/SilverMoon —— 与 Tauri 侧 app_data_dir 同目录，日志集中在一处。 */
internal fun appDataDir(): File {
    val base = System.getenv("APPDATA") ?: System.getProperty("user.home")
    return File(base, "SilverMoon")
}

/** 后端日志最后若干行，出错时直接贴给用户，不用再去翻文件。 */
private fun tail(file: File, lines: Int = 20): String {
    if (!file.isFile) return "（日志尚未生成）"
    return runCatching {
        file.readLines().takeLast(lines).joinToString(System.lineSeparator())
    }.getOrDefault("（日志读取失败）").let { "\n---- bridge.log 末尾 ----\n" + it }
}

/**
 * 依次尝试：显式环境变量 -> jpackage 资源目录 -> 工程内的 cargo 产物。
 */
private fun locateExecutable(): File? {
    val candidates = mutableListOf<File>()
    System.getenv("SILVERMOON_BRIDGE_EXE")
        ?.takeIf { it.isNotBlank() }
        ?.let { candidates += File(it) }
    System.getProperty("compose.application.resources.dir")?.let { resources ->
        candidates += File(resources, "backend/silvermoon_bridge.exe")
        candidates += File(resources, "silvermoon_bridge.exe")
    }
    var dir = File(System.getProperty("user.dir")).absoluteFile
    var depth = 0
    while (depth < 5) {
        for (profile in listOf("release", "debug")) {
            candidates += File(dir, "apps/desktop/src-tauri/target/" + profile + "/silvermoon_bridge.exe")
            candidates += File(dir, "src-tauri/target/" + profile + "/silvermoon_bridge.exe")
            candidates += File(dir, "desktop/src-tauri/target/" + profile + "/silvermoon_bridge.exe")
        }
        val parent = dir.parentFile ?: break
        dir = parent
        depth++
    }
    return candidates.firstOrNull { it.isFile }
}
