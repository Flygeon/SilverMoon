package cn.cool.silvermoon.ui.nav

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Favorite
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Image
import androidx.compose.material.icons.filled.MenuBook
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Settings
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * 页面枚举。
 *
 * 刻意用枚举而不是 navigation-compose：桌面端没有系统返回栈，路由表也很浅，
 * 一个状态变量就能表达"当前在哪一页"（web 端是 vue-router 的 hash 路由）。
 * 需要深链 / 多窗口路由时再换成 androidx.navigation（依赖已列在版本目录里）。
 */
enum class Destination(
    val route: String,
    /** 侧栏文案（中文为主，i18n 接入后换成 key）。 */
    val label: String,
    /** 媒体库类型过滤：image / video / audio / book；null 表示不是库页。 */
    val libraryKind: String?,
    val icon: ImageVector,
) {
    Images("images", "图片", "image", Icons.Filled.Image),
    Videos("videos", "视频", "video", Icons.Filled.Movie),
    Music("music", "音乐", "audio", Icons.Filled.MusicNote),
    Books("books", "书籍", "book", Icons.Filled.MenuBook),
    Treasure("treasure", "百宝箱", null, Icons.Filled.Apps),
    Folders("folders", "文件夹", null, Icons.Filled.Folder),
    Favorites("favorites", "收藏", null, Icons.Filled.Favorite),
    History("history", "历史", null, Icons.Filled.History),
    Player("player", "正在播放", null, Icons.Filled.MusicNote),
    Settings("settings", "设置", null, Icons.Filled.Settings);

    companion object {
        /** 侧栏主区（web 端 navItems 的顺序：图片 / 视频 / 音乐 / 书籍 / 百宝箱）。 */
        val primary: List<Destination> = listOf(Images, Videos, Music, Books, Treasure)

        /** 从媒体库类型反查页面。 */
        fun fromLibraryKind(kind: String): Destination =
            entries.firstOrNull { it.libraryKind == kind } ?: Images

        fun fromRoute(route: String): Destination =
            entries.firstOrNull { it.route == route } ?: Images
    }
}
