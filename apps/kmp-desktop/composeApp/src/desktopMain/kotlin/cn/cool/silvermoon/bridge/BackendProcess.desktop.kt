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
                "已尝试：" +
                bridgeExecutableCandidates().take(6).joinToString("；") { it.absolutePath } +
                " …。开发机上请先在 apps/desktop/src-tauri 执行 " +
                "cargo build --release --bin silvermoon_bridge，" +
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

private fun locateExecutable(): File? = bridgeExecutableCandidates().firstOrNull { it.isFile }

/**
 * 后端 exe 的候选路径。
 *
 * jpackage 应用镜像、Gradle 的 run / runDistributable、以及开发机这三者的目录布局
 * **互不相同**，而且 compose.application.resources.dir 只在 Gradle 拉起时才注入；
 * 少一条就是「双击没反应 / 报找不到 exe」那类问题（首轮实测就栽在 jpackage 镜像上：
 * bridge exe 位于应用目录根，而我当时只找了 ./resources 和 ./backend）。
 *
 * 依次尝试：
 *   1. 环境变量 SILVERMOON_BRIDGE_EXE —— 排查时最省事的一条路；
 *   2. jpackage 传入的 jpackage.app-path（启动器自身路径）-> 其父目录即应用目录；
 *   3. classpath 反推：镜像里是「应用目录/app」下的 jar，取其上两级；
 *   4. 运行中的 java 可执行文件：<app>/runtime/bin/java.exe，取其上三级；
 *   5. compose.application.resources.dir（Gradle run 场景）；
 *   6. 开发态：从工作目录往上找 cargo 的 target 产物。
 */
private fun bridgeExecutableCandidates(): List<File> {
    val candidates = mutableListOf<File>()

    fun addFrom(dir: File?) {
        if (dir == null) return
        candidates += File(dir, "silvermoon_bridge.exe")
        candidates += File(dir, "backend/silvermoon_bridge.exe")
        candidates += File(dir, "resources/silvermoon_bridge.exe")
        candidates += File(dir, "resources/backend/silvermoon_bridge.exe")
    }

    System.getenv("SILVERMOON_BRIDGE_EXE")
        ?.takeIf { it.isNotBlank() }
        ?.let { candidates += File(it) }

    System.getProperty("jpackage.app-path")?.let { addFrom(File(it).parentFile) }

    System.getProperty("java.class.path")
        ?.split(File.pathSeparator)
        ?.forEach { entry ->
            val jar = File(entry)
            if (jar.name.endsWith(".jar") && jar.parentFile?.name == "app") {
                addFrom(jar.parentFile?.parentFile)
            }
        }

    ProcessHandle.current().info().command().orElse(null)?.let { command ->
        addFrom(File(command).parentFile?.parentFile?.parentFile)
    }

    System.getProperty("compose.application.resources.dir")?.let { addFrom(File(it)) }

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
    return candidates
}
