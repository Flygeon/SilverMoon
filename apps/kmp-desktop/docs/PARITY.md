# 与 web 端的对照表（1:1 复刻进度）

目标是把 apps/desktop（Tauri + Vue 3）的桌面端行为尽可能原样搬到 KMP。
下表按"数据面 / 表现面"分开记：**数据面基本一次性到位**（命令全部复用），
差的主要是视图。

图例：已完成 / 部分 / 待办

## 外壳与设计系统

| 能力 | 状态 | 说明 |
|---|---|---|
| MD3 配色 / 字体 / 形状 | 已完成 | MaterialExpressiveTheme + materialKolor 动态取色 |
| Monet 动态取色（种子色） | 已完成 | 设置页可选预设种子，默认取 web 端浅色 primary #1a5c9e |
| 浅色 / 深色 / 跟随系统 | 已完成 | 深色模式读注册表 AppsUseLightTheme |
| M3E 组件（按钮 / 加载指示器 / 弹簧动效） | 已完成 | 由 MaterialExpressiveTheme 提供 |
| 自绘无边框标题栏（48px） | 已完成 | 拖动 / 双击最大化 / 三键，替代 tauri 的 decorations:false |
| 左侧导航栏（88px，带数量角标） | 已完成 | 角标数来自 library_counts |
| 底部迷你播放器（72px） | 已完成 | 进度条 + 三键 + 曲目信息 |
| 内容区边距（24px） | 已完成 | Tokens.contentPadding |
| 系统托盘 | 待办 | 需要 JNA + Shell_NotifyIcon（web 端是 Rust tray.rs） |
| 全局热键 | 待办 | tauri-plugin-global-shortcut 的对应实现 |
| 皮肤系统（ZIP 资产 + CSS 注入） | 待办 | 依赖 CSS 注入，KMP 下需要另设计（见 ROADMAP） |
| 中英双语 i18n | 待办 | web 端词条在 shared/i18n.ts，迁移方式已定（见 ROADMAP） |
| 多窗口（桌面歌词 / 绘画 / 扩展宿主） | 待办 | Compose Desktop 支持多 Window，窗口内路由需要先定 |

## 本地媒体库

| 能力 | 状态 | 说明 |
|---|---|---|
| 目录扫描（白名单/黑名单、进度事件） | 已完成 | scan_start / scan_status / scan_cancel + scan:progress SSE |
| 列表查询（类型过滤 / 搜索 / 排序 / 分页） | 已完成 | list_files，条件与 web 端一致 |
| 元数据（音频标签 / EXIF / 视频信息） | 已完成 | get_metadata（数据面复用） |
| 缩略图（磁盘缓存 / 列表直出路径） | 部分 | 列表已经带 thumbPath，Coil 直接吃；批量补齐接口还没接 |
| 角标计数 | 已完成 | library_counts |
| 图片网格浏览 | 部分 | 网格 + 缩略图已通；全屏缩放查看器待补 |
| 视频播放 | 待办 | 需要先补视频画面（SwingPanel + libvlc video surface） |
| 文件夹视图 / 收藏 / 历史 / 回收站 | 部分 | 页面框架在位，列表视图待接 |
| 媒体库体积过滤 / 排除规则 | 已完成 | 设置页 + ScanConfig |

## 音乐播放器

| 能力 | 状态 | 说明 |
|---|---|---|
| 队列语义（顺序 / 随机 / 单曲循环） | 已完成 | PlayerStore，语义对齐 web 端 player.ts |
| 播放内核 | 部分 | libvlc（VLCJ），仅音频链路 |
| 进度 / 音量 / 拖拽跳转 | 已完成 | 500ms 轮询 libvlc 状态 |
| 逐字歌词（QRC/KRC/yrc/TTML） | 待办 | web 端解析器是 TS，需要移植到 Kotlin（工作量最大的单点） |
| 逐字歌词本地分析（Web Worker + FFT） | 待办 | 需要换成 Kotlin 协程 + JVM 音频分析 |
| 音效（EQ / 低音 / 混响 / 立体声宽度） | 待办 | libvlc 的 audio filters 或自建 DSP |
| 桌面歌词（透明置顶 + 穿透） | 待办 | 独立 Window + Win32 分层窗口 |
| SMTC（系统媒体控件） | 部分 | Rust 侧 smtc.rs 已在桥进程里初始化，Kotlin 侧尚未驱动它 |
| 在线音乐（网易云 / 酷狗 / Meting） | 部分 | 命令已全部桥接，视图待接 |

## 阅读 / 创作 / 在线源

| 能力 | 状态 | 说明 |
|---|---|---|
| EPUB / PDF 阅读器 | 待办 | Rust 侧提供进度存取；渲染需要 Kotlin 侧方案 |
| 创作工作台（Markdown 双栏） | 待办 | 需要 Markdown 渲染库（版本目录已备选） |
| 绘画工作台（leafer / wgpu 画布） | 待办 | web 端走 Rust wgpu 直绘窗口，KMP 下要么复用该窗口要么换 Skia |
| Pixiv / B 站 / 小说 / 番剧 / osu! | 部分 | 命令（含登录、取流、弹幕）全部可调用；页面视图待补 |
| WebDAV | 部分 | 同上 |
| 扩展框架 | 部分 | Rust 侧 ext_* 全部可用；扩展宿主窗口待接 |
| 自动更新 | 待办 | web 端 tauri-plugin-updater；KMP 侧需要新的更新通道 |

## 无法 1:1 的地方（如实说明）

1. **皮肤系统**：web 端是在页面里注入 CSS 变量与样式表实现的。Compose 没有 CSS，
   等价能力要改成"主题令牌覆盖 + 资产包解析"，语义会变，不能照搬。
2. **浏览器里的在线播放**：web 端靠 HLS.js / DASH(MSE) / ArtPlayer 在页面内解流。
   KMP 下这些必须落到 libvlc 或自建 MSE 等价层，链接协议（m3u8/dash）能复用，
   但播放器行为细节不可能逐像素一致。
3. **扩展宿主**：扩展是 HTML 子进程 + WebView。KMP 侧要么保留一个 WebView 组件
   专供扩展，要么改扩展的运行契约。
