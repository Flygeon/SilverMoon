package cn.cool.silvermoon.data

/** 读取设置文件内容；不存在时返回 null。 */
expect fun platformReadSettings(): String?

/** 写入设置文件内容（原子替换）。 */
expect fun platformWriteSettings(text: String)

/** 应用数据目录的展示路径（设置页里给用户看"数据存在哪"）。 */
expect fun platformAppDataDir(): String

/** 平台是否处于深色模式（Windows 读注册表 AppsUseLightTheme）。 */
expect fun platformIsDarkMode(): Boolean

/** 打开系统目录选择器；用户取消时返回 null。 */
expect fun chooseDirectory(title: String): String?
