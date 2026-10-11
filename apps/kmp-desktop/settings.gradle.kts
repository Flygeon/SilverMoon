// SilverMoon KMP 桌面端 —— Gradle 多模块工程。
//
// 现阶段只启用 Windows/JVM 目标（desktop）。Android / iOS 目标一旦要接，
// 只需在各模块的 kotlin { } 里补上对应 target，UI 与数据层代码无需改动
// （commonMain 里没有任何 JVM-only API）。
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
        google()
        maven("https://maven.pkg.jetbrains.space/public/p/compose/dev")
    }
}

rootProject.name = "silvermoon-kmp"

include(":composeApp")
