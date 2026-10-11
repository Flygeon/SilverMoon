import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// SilverMoon KMP 桌面端主模块。
//
// 目前只挂 desktop（JVM/Windows）一个 target —— 需求就是先把 Windows 版跑通。
// commonMain 里不出现任何 JVM-only API，将来加 androidMain / iosMain 时
// 只需在下面 kotlin { } 补齐 target，UI 与数据层可以原样复用。
plugins {
    alias(libs.plugins.kotlinMultiplatform)
    alias(libs.plugins.composeMultiplatform)
    alias(libs.plugins.composeCompiler)
    alias(libs.plugins.kotlinSerialization)
}

kotlin {
    jvmToolchain(21)

    jvm("desktop") {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_21)
        }
    }

    sourceSets {
        val desktopMain by getting

        commonMain.dependencies {
            implementation(compose.runtime)
            implementation(compose.foundation)
            implementation(compose.material3)
            implementation(compose.materialIconsExtended)
            implementation(compose.ui)
            implementation(compose.components.resources)

            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.serialization.json)

            implementation(libs.ktor.client.core)

            implementation(libs.coil.compose)
            implementation(libs.coil.network.ktor)

            implementation(libs.material.kolor)
        }

        desktopMain.dependencies {
            implementation(compose.desktop.currentOs)
            implementation(libs.kotlinx.coroutines.swing)
            implementation(libs.ktor.client.cio)

            // Win32 / DWM / 托盘：无边框标题栏、圆角、系统强调色
            implementation(libs.jna)
            implementation(libs.jna.platform)

            // 播放内核：libvlc；机器上没有 VLC 时自动降级为空引擎，不崩
            implementation(libs.vlcj)
        }

        val desktopTest by getting
        desktopTest.dependencies {
            implementation(kotlin("test"))
        }
    }
}

compose.desktop {
    application {
        mainClass = "cn.cool.silvermoon.MainKt"

        nativeDistributions {
            targetFormats(TargetFormat.Msi, TargetFormat.Exe)
            packageName = "SilverMoon"
            packageVersion = "0.1.0"
            description = "SilverMoon library (Kotlin Multiplatform desktop)"
            copyright = "GPL-3.0-only"
            vendor = "SilverMoon"

            // 后端 exe 走 jar 资源（src/desktopMain/resources/backend/），
            // 由 Kotlin 侧首次启动释放到 %APPDATA%。
            //
            // 不用 appResourcesRootDir：实测它在 createReleaseDistributable 产出的
            // 分发目录里静默失效（配了也不报错，文件就是不进去），而落盘位置还随
            // 打包工具版本漂移。打进 jar 则与安装包同生命周期 —— 只要 jar 在，
            // 后端就一定在，CI 也有一条断言盯着这个 jar 条目。
            // VLCJ 走 AWT/Swing、JNA 走 jdk.unsupported，逐个列模块很容易漏，
            // 漏了就是运行时 NoClassDefFoundError，这里直接带全套模块。
            includeAllModules = true

            windows {
                // 与 tauri.conf.json 的 identifier 保持一致，升级安装不会并列出两份
                upgradeUuid = "9d3b1f92-6f4d-4f0e-9e5d-2c7a4b6d81c3"
                menuGroup = "SilverMoon"
                dirChooser = true
                perUserInstall = true
                shortcut = true
            }
        }
    }
}
