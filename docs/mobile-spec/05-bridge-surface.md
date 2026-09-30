# 05 · 音乐模块桥调用清点（Flutter WebView 重写用）

> ⚠️ **已废弃（2026-09-30，commit 44c0a59）**：本文是为「WebView 复用桌面 Vue 前端」做的
> 桌面端桥调用清点；移动端最终走**原生实现**，JS 桥（BridgeService）已删除。
> 在线能力现由 apps/mobile/lib/services/bridge_online.dart 的 OnlineMusicService 提供。
> 本文只作历史记录，**不要照做**。

> 本文只做**只读静态清点**，未修改任何源码（除本文件）。
>
> 清点范围：以任务给定的 stores / views / components / utils 清单为起点，沿 import（含动态 import() 与 new URL(..., import.meta.url)）递归展开到 src/ipc/。
> 判定依据：apps/desktop/src/ipc/bridge.ts 的 window.__SILVERMOON__（invoke / invokeBatch / call / emitTo，以及移动端专用的 assetBase）。
>
> **重要更正**：任务清单里的 src/components/SourceSheet.vue **不是音乐组件**，它只被 components/AnimeOnlineView.vue 使用，内容是番剧播放源选择，并会把 stores/anime.ts 及整套番剧 util（animeFetcher / animeRules / bangumiApi / animeLog …）拉进依赖图。本文的「音乐闭包」**已剔除 SourceSheet 及其番剧子树**；若把它算进来，闭包会从 66 个文件膨胀到 76 个，并多出 11 个番剧命令。番剧相关命令不列入本文主表。

---

## 0. 桥的形态与调用链

   音乐代码
     ├─ capabilities.xxx(...)                 → src/capabilities/index.ts（唯一汇聚点）
     │     └─ safeInvoke(cmd, args)           → invoke(cmd, args) → window.__SILVERMOON__.invoke
     │        （invokeBatch 批量：getThumbnails 用）
     ├─ 直接 import @/ipc/*                    → callBridge(channel, payload)
     │     ├─ ipc/http.ts   → "http"
     │     ├─ ipc/fs.ts     → "fs"
     │     ├─ ipc/dialog.ts → "dialog"
     │     ├─ ipc/store.ts  → "store"
     │     ├─ ipc/opener.ts → "opener"（经 capabilities 转发）
     │     ├─ ipc/window.ts → "window"（bridge.call 直连）
     │     └─ ipc/app.ts    → "app"
     ├─ ipc/events.ts listen(event)            → DOM CustomEvent("silvermoon:event")，不占 channel
     └─ ipc/invoke.ts toAssetUrl(path)         → asset://localhost/<path>（移动端 assetBase + encodeURIComponent）

约定：invoke 的参数键用 **camelCase**，后端 silvermoon-ipc 命令宏负责映射到 Rust 形参（file_id ← fileId）。下表的「参数键」就是前端实际发送的键。

---

## 1. Rust 命令（invoke）

共 **58** 条（音乐闭包内去重后按名字排序）。「调用点」列给出**业务侧**调用位置；capabilities/index.ts 是统一封装层，命令字符串在那里落到 safeInvoke。

| 命令名 | 参数键与类型 | 返回值形状 | 调用点（文件:行） | 用途 |
|---|---|---|---|---|
| count_files | { query: ListQuery \| null } | number | stores/library.ts:119 | 当前过滤条件下的曲目总数 |
| end_play_session | { input: PlaySessionEnd } | void | stores/player.ts:171 | 结束听歌会话，落库时长/完成度 |
| ffmpeg_set_path | { dir: string \| null } | FfmpegStatus | stores/settings.ts:493 | 把 ffmpeg 目录同步给 Rust（**非音乐**，视频/探测用） |
| get_song | { fileId: string } | Song（{ file, meta, coverBase64?, lyrics? }） | stores/player.ts:763 | 切本地歌时按需拉全量（含内嵌封面 base64 与歌词原文） |
| get_thumbnail | { fileId: string; size?: number }（默认 320） | string \| null（磁盘缓存路径，前端转 asset://） | capabilities/index.ts:195（单张）、:216（invokeBatch 批量）；业务侧 stores/library.ts:190/223 | 生成/取回音频封面缩略图 |
| is_safe_mode | {} | boolean | stores/skins.ts:83 | 皮肤安全模式逃生通道（**非音乐**） |
| kugou_captcha_sent | { mobile: string } | void | stores/kugou.ts:181 | 酷狗手机号登录发短信验证码 |
| kugou_cover | { url: string } | string（dataURL） | utils/onlineCache.ts:109 | 酷狗图床无 CORS 头，走 Rust 代理取封面并缓存 |
| kugou_everyday_recommend | {} | unknown（上游原始 JSON） | components/KugouFeed.vue:38、views/MusicView.vue:345 | 酷狗每日推荐歌单 |
| kugou_login_cellphone | { mobile: string; code: string } | KugouProfile | stores/kugou.ts:212 | 酷狗手机号+验证码登录 |
| kugou_login_qr_check | { key: string } | KugouQrCheck | stores/kugou.ts:120 | 酷狗扫码轮询 |
| kugou_login_qr_key | {} | KugouQrKey（{ key, url }） | stores/kugou.ts:98 | 取酷狗扫码二维码 key/内容 |
| kugou_login_status | {} | KugouLoginStatus | stores/kugou.ts:71 | 读本地酷狗登录态与签到日历（不发网络） |
| kugou_logout | {} | void | stores/kugou.ts:249 | 退出酷狗登录（清账号 cookie，保留设备身份） |
| kugou_rank_list | { zone?: string \| null } | unknown（原始 JSON） | views/MusicView.vue:326 | 酷狗排行榜卡片列表 |
| kugou_rank_songs | { rankCid: string; page?: number \| null; pagesize?: number \| null } | unknown（原始 JSON） | views/MusicView.vue:338 | 某榜单的歌曲列表 |
| kugou_search | { keyword: string; page?: number \| null; pagesize?: number \| null } | unknown（原始 JSON） | views/MusicView.vue:381 | 酷狗关键词搜索（meting 实例不放行酷狗，故走 Rust） |
| kugou_sign_in | {} | KugouSignInResult（{ ok, message, ssaCode, svip }） | stores/kugou.ts:231 | 酷狗每日签到（畅听 VIP + 概念版） |
| kugou_song_url | { hash: string; albumAudioId?: string \| null; albumId?: string \| null; quality?: string \| null } | KugouSongUrl（{ url, quality, trial }） | utils/kugou.ts:295 | 解析酷狗播放直链（列表不带直链，播放前惰性解析） |
| library_counts | { minSize?: number } | Record<string, number> | stores/library.ts:178 | 各类型媒体条数（音乐 tab 角标） |
| list_files | { query: ListQuery \| null } | MediaEntry[] | stores/library.ts:118、:151 | 本地曲库分页查询（搜索/排序/体积过滤下推 SQL） |
| netease_account | {} | NeteaseProfile（{ userId, nickname, avatarUrl }） | stores/netease.ts:51、:110 | 校验登录态 / 扫码成功后补全账号信息 |
| netease_cloud | { offset?: number; limit?: number } | NeteaseCloudPage（{ songs, hasMore, count }） | stores/netease.ts:239、:248 | 网易云盘分页 |
| netease_daily_recommend_songs | {} | NeteaseSong[] | components/NowPlayingFeed.vue:47 | 每日推荐歌曲 |
| netease_likelist | { uid: number } | number[] | stores/netease.ts:258 | 拉「我喜欢的音乐」id 集合（红心状态） |
| netease_login_cellphone | { phone: string; captcha: string; ctcode?: string \| null } | NeteaseProfile | stores/netease.ts:196 | 网易云手机号登录 |
| netease_login_qr_check | { key: string } | NeteaseQrCheck（{ code, nickname?, avatarUrl? }） | stores/netease.ts:99 | 网易云扫码轮询（800/801/802/803） |
| netease_login_qr_key | {} | string（unikey） | stores/netease.ts:76 | 取网易云扫码 unikey（前端用 qrcode 库出图） |
| netease_logout | {} | void | stores/netease.ts:216 | 退出网易云登录 |
| netease_personal_fm | {} | NeteaseSong[] | components/NowPlayingFeed.vue:48 | 私人 FM |
| netease_playlist_detail | { id: number } | NeteaseSong[] | views/MusicView.vue:287、:526 | 歌单/我的歌单详情 |
| netease_recommend_playlists | { limit?: number }（默认 20） | NeteaseRecommendPlaylist[] | components/NowPlayingFeed.vue:46 | 推荐歌单卡片 |
| netease_set_song_liked | { id: number; like: boolean } | void | stores/netease.ts:280 | 红心/取消红心 |
| netease_sms_captcha_sent | { phone: string; ctcode?: string \| null } | void | stores/netease.ts:164 | 网易云手机号登录发短信验证码 |
| netease_song_comments | { id: number; offset?: number; limit?: number } | NeteaseCommentsPage | components/CommentsPanel.vue:80、:95 | 歌曲评论分页（含热评） |
| netease_song_url | { ids: number[] }（每批 ≤30） | { id: number; url: string }[] | utils/netease.ts:17 | 批量解析网易云播放直链 |
| netease_user_playlists | { offset?: number; limit?: number }（默认 0/100） | NeteasePlaylist[] | stores/netease.ts:231 | 我的歌单列表 |
| record_play | { fileId: string } | void | stores/player.ts:766 | 记录一次播放（历史/统计） |
| save_thumbnail | { fileId: string; size?: number; jpeg: number[] } | string \| null（磁盘路径） | stores/library.ts:257（capabilities.saveThumbnail） | 回存前端渲染的封面（**PDF 首页专用**，音乐不触发） |
| scan_cancel | { jobId: string } | void | stores/library.ts:331 | 取消曲库扫描 |
| scan_start | { config: ScanConfig }（{ dirs, maxDepth?, followLinks?, forceReparse? }） | { jobId: string } | stores/library.ts:295 | 启动曲库扫描 |
| scan_status | { jobId: string } | ScanProgress \| null | stores/library.ts:309 | 轮询扫描进度（无事件通道时兜底） |
| skin_abort | { staging: string } | void | stores/skins.ts:176、:200 | 放弃 ZIP 皮肤 staging（**非音乐**） |
| skin_commit | { staging: string; id: string } | void | stores/skins.ts:209 | 提交 ZIP 皮肤入库（**非音乐**） |
| skin_delete | { id: string } | void | stores/skins.ts:123 | 删除皮肤（**非音乐**） |
| skin_dir | {} | string | stores/skins.ts:62 | 皮肤库根目录（拼 asset:// 用，**非音乐**） |
| skin_list | {} | SkinEntry[] | stores/skins.ts:56 | 皮肤清单（**非音乐**） |
| skin_load | { id: string } | LoadedSkin（{ json?, files }） | stores/skins.ts:64 | 读取皮肤文档与资产清单（**非音乐**） |
| skin_read_external_file | { path: string } | string | stores/skins.ts:145 | 读取用户选中的外部皮肤文件（**非音乐**） |
| skin_save | { id: string; json: string } | void | stores/skins.ts:211 | 保存 JSON 皮肤（**非音乐**） |
| skin_stage_zip | { path: string } | StagedSkin（{ staging, json, files }） | stores/skins.ts:168 | ZIP 皮肤解压到 staging（**非音乐**） |
| smtc_set_media | { title: string; artist?: string \| null; album?: string \| null; durationMs: number; filePath: string; coverUrl?: string \| null } | void | stores/player.ts:731、:878、:951 | 推送媒体元数据到 Windows 系统媒体控件（换歌） |
| smtc_set_playback | { playing: boolean; positionMs: number; durationMs: number } | void | stores/player.ts:312 | 推送播放状态/进度（节流 500ms） |
| start_play_session | { input: PlaySessionStart } | void | stores/player.ts:212 | 开始听歌会话（统计） |
| thumbnail_cache_path | { fileId: string; size?: number } | string \| null（磁盘路径） | stores/library.ts:249（capabilities.thumbnailCachePath） | 探测缩略图缓存是否存在（**PDF 封面专用**，音乐不触发） |
| toggle_favorite | { fileId: string } | boolean（新状态） | stores/library.ts:336 | 收藏/取消收藏曲目 |
| webdav_configure | { url: string; username: string; password: string } | void | stores/settings.ts:477 | 把 WebDAV 配置推给 Rust |
| webdav_media_url | { path: string } | string（本地代理 URL） | stores/player.ts:902、:906 | WebDAV 音频/歌词取本地代理直链 |

### 1.1 分类与取舍

- **音乐核心（45 条）**：count_files, end_play_session, get_song, get_thumbnail, kugou_*(13), library_counts, list_files, netease_*(16), record_play, scan_cancel, scan_start, scan_status, smtc_set_media, smtc_set_playback, start_play_session, toggle_favorite, webdav_configure, webdav_media_url。
- **间接引入但音乐不触发（13 条）**：ffmpeg_set_path（视频/探测）、is_safe_mode 与 skin_*（10 条，皮肤系统）、thumbnail_cache_path / save_thumbnail（2 条，PDF 封面兜底）。
- **未被音乐调用但同族存在**（本文不计入 58）：kugou_playlist_detail、kugou_account、get_metadata、list_favorites、list_history、get_listen_stats、list_listen_stats、list_top_tracks、listen_source_breakdown、app_log、exit_app、open_devtools、clear_thumbnail_cache、ffmpeg_status、ffmpeg_download_url 等。
- **批量通道**：getThumbnails 不发新命令，而是把 N 条 { cmd: "get_thumbnail", args: { fileId, size } } 通过 invokeBatch 一次往返（capabilities/index.ts:215）。

---

## 2. 主进程能力（callBridge channel）

真实 channel 字符串共 **7** 个（音乐闭包内）。payload 第一层都带 op（store/path 风格）或直接是结构化字段（http）。

| channel | op 与 payload | 返回值 | 调用点（文件:行） | 用途 |
|---|---|---|---|---|
| "http" | 无 op。{ url: string; method: string; headers: [string,string][]; body: string \| null } | { status, statusText, url, headers: [k,v][], body: Uint8Array }（ipc/http.ts 再包成标准 Response） | utils/kgMusic.ts:32、utils/qqMusic.ts:91（实现见 ipc/http.ts:95） | 由主进程网络栈发起请求，绕开 CORS：酷狗签名接口、QQ 音乐接口与歌词 |
| "fs" | op="readFile" { path } → Uint8Array；op="readFileBase64" { path } → string；op="writeFile" { path, data }；op="writeFileBase64" { path, data }；op="writeTextFile" { path, contents }；另有 exists/mkdir/remove/copyFile/rename/stat/readDir | 见左 | utils/wordAnalysis.ts:27（readFile）、components/AudioEffectsPanel.vue:12（writeTextFile）、capabilities/index.ts:874（writeFile，downloadTo）、stores/library.ts:252（readFile，仅 PDF） | 逐字精排读本地音频字节、导出音效预设、下载落盘 |
| "dialog" | op="save" { options: { defaultPath, title?, filters? } }；op="open" { options: {...} } | string \| null（取消为 null） | capabilities/index.ts:865（pickSavePath）、components/AudioEffectsPanel.vue:11（save） | 选择下载音频/封面、导出音效预设的目标路径 |
| "store" | op ∈ get/set/delete/has/keys/values/entries/length/clear/reset/reload/save/close/path，{ file: string; key?: string; value?: unknown } | 依 op 而定（T \| null / boolean / string[] / number / string / void） | stores/settings.ts:47（settings.json）、stores/audioEffects.ts:16（audio-effects.json），实现见 ipc/store.ts:42-114 | 设置与音效配置的 JSON 文件持久化 |
| "opener" | op="openUrl" { url, openWith }；op="reveal" { path }；op="openPath" { path, openWith } | void | capabilities/index.ts:841/850/845；业务侧 components/AudioEffectsPanel.vue:153、components/TrackList.vue:98、components/MediaGrid.vue:59 | 系统浏览器打开链接、文件管理器定位歌曲文件 |
| "window" | op ∈ create/exists/list/watchClose/preventClose/isMaximized/isVisible/minimize/toggleMaximize/close/destroy/hide/show/focus/setTitle/setAlwaysOnTop/setIgnoreCursorEvents/outerPosition/outerSize/setPosition/setSize，{ target \| label, options?, x?, y?, width?, height? } | 依 op 而定 | utils/desktopLyrics.ts:55/62/85（createWindow/getWindowByLabel/getCurrentWindow）、composables/useWindowDrag.ts:11（getCurrentWindow）；PlayerView 自绘标题栏 | 桌面歌词独立置顶透明窗、播放器页窗口拖拽/最小化/关闭 |
| "app" | op="version" {} | string | stores/skins.ts:19（动态 import @/ipc/app 的 getVersion） | 皮肤 minAppVersion 门槛校验（**非音乐**） |

补充：

- "emit"（ipc/events.ts:116 的 emit()）与 bridge.emitTo **在音乐闭包内未被使用**；桌面歌词走 emitTo（utils/desktopLyrics.ts:96/106/116/126），它不是 call channel。
- "path"（ipc/paths.ts）与 "dragdrop" 不在音乐闭包内。
- ipc/events.ts 的 listen() 不占 channel：主进程把事件转成 DOM CustomEvent("silvermoon:event")。音乐闭包订阅的事件名："scan:progress"（capabilities/index.ts:170）、"smtc:command"（:343）。

---

## 3. asset:// 使用点

toAssetUrl 定义在 ipc/invoke.ts:38：

- 桌面端 → asset://localhost/<每段 encodeURIComponent 的路径>（Electron asset: 协议处理器映射磁盘文件，**支持 Range**，音视频可拖动进度）。
- 移动端 → 若 window.__SILVERMOON__.assetBase 存在，返回 assetBase 拼上 encodeURIComponent(path)（invoke.ts:46-49）。assetBase 声明见 ipc/bridge.ts:26-30，由 src/mobile/shim.ts:148-156 从 <meta name="sm-asset-base"> 读取——**Flutter 侧必须提供这个 loopback HTTP 服务，否则本地音频/缩略图全不可用**。

| 位置 | 形式 | 用途 |
|---|---|---|
| ipc/invoke.ts:38-56 | toAssetUrl(filePath) | 统一转换入口；已是 http(s):/data:/blob:/asset:/app: 前缀则原样返回 |
| stores/player.ts:35-36 | toMediaSrc(path) → toAssetUrl(path) | **本地音频 <audio src>**（NowPlaying.src） |
| stores/library.ts:206-207 | capabilities.thumbUrl(entry.thumbPath) | 列表带出的**缩略图磁盘路径 → <img>**（零命令路径） |
| capabilities/index.ts:197 / 221 / 226 / 237 / 246 | getThumbnail / getThumbnails / thumbUrl / thumbnailCachePath / saveThumbnail 的返回值 | 缩略图 **封面 <img>**（音频/视频/图片/PDF 通用） |
| utils/skinLoader.ts:48-63 | resolveAssetRef → toAssetUrl(assetBase 拼 norm) | **皮肤 CSS 的 url()**、背景图、SVG 图标、字体资产 |
| stores/skins.ts:33 | 注释：skin_dir 根目录用于拼 asset:// | 皮肤资产基准目录 |
| components/MediaGrid.vue:9 | 注释 | 说明缩略图走 asset:// 而非 base64（内存由 webview 回收） |

**不走 asset:// 的音乐资源**：

- 在线封面 → app-cover://img/<encodeURIComponent(url)>（utils/onlineCache.ts:69-73，由 Electron 主进程协议处理器伪装 Referer/UA + 磁盘缓存 + 并发去重）。components/CachedCover.vue:21 消费。
- 酷狗封面（无 CORS 头）→ capabilities.kugouCover(url) 返回 dataURL，并写入 IndexedDB（utils/onlineCache.ts:108-113）。
- 本地内嵌封面 → get_song 返回的 coverBase64（dataURL），非 asset://。
- WebDAV 音频 → webdav_media_url 返回的本地代理 URL。

---

## 4. 浏览器原生 API 依赖

这一节是 Flutter WebView 移植的关键：**音频音效、逐字精排、缓存三条链路都直接依赖 Web 平台能力，没有走桥**。

| API | 来源文件:行 | 用途 |
|---|---|---|
| AudioContext / webkitAudioContext | utils/audioEffects.ts:61-63 | 音效引擎懒创建（首次开音效才建） |
| createMediaElementSource | utils/audioEffects.ts:65 | 把全局 <audio> 接入 WebAudio 图 |
| GainNode / BiquadFilterNode / ConvolverNode / ChannelSplitterNode / ChannelMergerNode / AudioBuffer / createBuffer | utils/audioEffects.ts:36-52、:195-206 | EQ、低音增强、混响（脉冲响应）、立体声宽度 |
| HTMLAudioElement（new Audio()） | stores/player.ts:235 | **全局唯一播放器**，timeupdate/loadedmetadata/play/pause/seeked/ended/error 事件驱动 UI、SMTC、听歌统计 |
| OfflineAudioContext + decodeAudioData | utils/wordAnalysis.ts:41-42 | 离线解码音频为 44.1k 单声道 PCM |
| Worker（new Worker(new URL("../workers/wordAnalysis.worker.ts", import.meta.url), { type: "module" })） | utils/wordAnalysis.ts:55 | 起 FFT 起音检测 Worker（源文件 src/workers/wordAnalysis.worker.ts，209 行，纯计算，无桥调用） |
| postMessage(pcm, [pcm.buffer]) Transferable | utils/wordAnalysis.ts:70 | 把 PCM 零拷贝转给 Worker |
| indexedDB | utils/wordCache.ts:22（库 lumiluna，store wordTimes）；utils/onlineCache.ts:18（库 lumiluna-online，store kv） | 逐字精排时间轴缓存；在线封面 dataURL + meting 歌词文本缓存 |
| FileReader + readAsDataURL | utils/onlineCache.ts:86-89 | Blob → dataURL |
| 全局 fetch（**未过桥**） | utils/meting.ts:65、utils/onlineCache.ts:122、stores/player.ts:808/907、capabilities/index.ts:871（downloadTo） | meting 搜索/歌单/歌词、封面直连下载、在线 LRC 拉取、下载落盘 |
| TextDecoder | stores/player.ts:46-52（utf-8/gbk/big5/shift_jis 探测）、utils/krc.ts:35、utils/qrc.ts:483 | 歌词文本解码（含多编码兜底） |
| TextEncoder | utils/md5.ts:22、ipc/bridge.ts:152 | 字符串→UTF-8 字节 |
| atob / btoa | utils/krc.ts:17、ipc/fs.ts:10/16/22 | base64 解码 KRC / 二进制过桥回退 |
| DataView + Uint8Array | utils/md5.ts:26-30、:77-78 | 纯 JS MD5（酷狗签名） |
| pako（JS zlib 库，非浏览器原生但属 Web 依赖） | utils/krc.ts:34、utils/qrc.ts:446 | KRC/QRC 解压；**刻意不用 DecompressionStream**（尾部填充字节会报错） |
| Intl.Segmenter（grapheme 粒度） | utils/lyricTimeline.ts:18-19 | 歌词分词/逐字单元切分（带 "Segmenter" in Intl 兜底） |
| requestAnimationFrame | components/LyricsView.vue:123/160/202、components/FluidBackground.vue:167/169、components/SegmentedTabs.vue:38/75/76、composables/useWindowDrag.ts:142 | 歌词滚动/背景动画/分段指示器/窗口拖拽节流 |
| ResizeObserver | components/LyricsView.vue:154/158、components/MediaGrid.vue:128/154 | 歌词行布局测量、网格列数测量 |
| Canvas 2D getContext("2d") + drawImage + getImageData | stores/player.ts:61-70（getDominantColors）、components/FluidBackground.vue:96/115 | 封面主色提取（4 象限均值）、动态背景纹理 |
| new Image()（含 crossOrigin） | stores/player.ts:711/845/857、components/FluidBackground.vue:174 | 取封面像素、背景图 |
| WebGL（经 @applemusic-like-lyrics/core 的 BackgroundRender + MeshGradientRenderer） | components/AmllBackground.vue:10 | AMLL 网格渐变背景 |
| navigator.clipboard.writeText | components/AudioEffectsPanel.vue:84-85 | 复制音效分享码 |
| URL.createObjectURL + Blob | components/AudioEffectsPanel.vue:162 | 导出音效预设 JSON 下载 |
| matchMedia("(prefers-color-scheme: dark)") | stores/settings.ts:433/449/450 | 跟随系统深浅色（含 change 监听） |
| document.documentElement.style/setAttribute | utils/dynamicTheme.ts:70-83、stores/settings.ts:434 | 动态配色令牌 / data-theme |
| document.visibilitychange、document.hidden | stores/settings.ts:420-421、components/AmllBackground.vue:20/36/47 | 后台暂停动画 / 隐藏时落盘 |
| window.addEventListener("beforeunload") | stores/player.ts:1185、stores/settings.ts:419 | 退出前 flush 听歌会话 / 保存设置 |

**明确未使用**（音乐模块内）：

- localStorage / sessionStorage：音乐模块**零使用**。全仓库仅 views/SettingsView.vue:54/75 与 composables/useDesktopChrome.ts:55 用 localStorage 存 lumiluna-devtools-enabled（开发者工具开关），与音乐无关。
- MediaSession、AudioWorklet、WebSocket、EventSource、requestIdleCallback：均未找到。

> 结论：utils/audioEffects.ts（WebAudio 音效）、utils/wordAnalysis.ts + workers/wordAnalysis.worker.ts（离线解码 + Worker FFT）、utils/wordCache.ts / utils/onlineCache.ts（IndexedDB）是三条**纯 Web 平台**链路。Flutter WebView 里它们能原样跑；但若目标是 Flutter 原生播放（非 WebView 内 <audio>），音效与逐字精排需要另找方案（原生音频处理 + Dart/FFI FFT），否则会与桌面端行为不一致。

---

## 5. QQ 音乐与逐字歌词

### 5.1 src/utils/qqMusic.ts（QQ 音乐 API 客户端，280 行）

移植自 LDDC core/api/lyrics/qm.py，**只做「搜索歌曲 + 拉取歌词」**，不做账号登录。

- 接口：POST https://u.y.qq.com/cgi-bin/musicu.fcg，匿名 session cookie 固定 tmeLoginType=-1;（qqMusic.ts:63）——**没有任何 QQ 账号凭据、cookie 持久化或扫码逻辑**。
- 入口函数：
  - export async function qqSearchSongs(keyword: string): Promise<QqSongInfo[]>（:136）
  - export async function qqFetchLyrics(song: QqSongInfo): Promise<LyricLine[] \| null>（:223）
  - export interface QqSongInfo（:20，含 id/mid/name/artist/durationMs 等）
- 内部：ensureSession()（:98）首次取 session；desktopSafeFetch()（:89）在桌面端动态 import("@/ipc/http") 走 **"http" channel**，浏览器预览退化为全局 fetch；parseTrack(encrypted)（:194）把响应里的 hex 密文交给 qrcDecrypt。
- **桥依赖**：仅 "http" channel（经 @/ipc/http）。**不调用任何 invoke 命令**。

### 5.2 src/utils/qrc.ts（QRC 解密 + 解析，625 行）

纯前端实现，无桥调用（依赖 pako + 纯 JS 3DES）。

- export interface QrcDecryptOptions { local?: boolean }（:449）
- export async function qrcDecrypt(encrypted: string \| Uint8Array, options?: QrcDecryptOptions): Promise<string>（:455）
  - hex/字节 →（可选 QMC1 异或 + 跳 11 字节头）→ 8 字节块 **3DES 解密**（tripledesKeySetup/tripledesCrypt）→ **pako zlib 解压** → UTF-8 明文。
- export function qrcToRawLines(sQrc: string): QrcLine[] \| null（:508）——解析 <Lyric_1 LyricContent="...">，行格式 [start,duration]...，字格式 text(start,duration)，输出**毫秒**时间轴 QrcLine { start, end, words[] }。
- export function rawLinesToLyricLines(lines: QrcLine[]): LyricLine[]（:558）——毫秒 → 秒，生成 units: WordUnit[]。
- export function hasWordLevel(lines: LyricLine[]): boolean（:574）——是否含逐字（任一行 units.length > 1）。
- export function mergeQqLyrics(orig: LyricLine[], trans: LyricLine[] \| null, roma: LyricLine[] \| null): LyricLine[]（:582）——原文/翻译/罗马音按索引配对，行数不等时按起始时间贪心最近匹配。

### 5.3 src/utils/krc.ts（酷狗 KRC 解密 + 解析，160 行）

移植自 LDDC krc_decrypt + krc2mdata，纯前端，无桥调用。

- export async function krcDecrypt(b64content: string): Promise<string>（:27）——base64 → 跳过 4 字节头 → 逐字节异或（密钥字节 @Gaw^2tGQ61- 加 0xce 0xd2 6e 69）→ pako.inflate → UTF-8。
- export interface KrcLine { start; end; words[] }（:45）
- export function krcToRawLines(krc: string): { lines: KrcLine[]; translations: (string\|null)[]; romaji: (string\|null)[]; tags: ... }（:55）——解析 [start,duration] 行与 <start,duration,?> 字单元，并解析 [language:...] 语言轨（翻译/罗马音）。
- export function krcLinesToLyricLines(parsed): LyricLine[]（:140）——毫秒 → 秒，空文本行跳过，翻译/罗马音按索引合并。

### 5.4 src/utils/kgMusic.ts（酷狗歌词回退源，266 行）

- export async function kgSearchSongs(keyword: string): Promise<KgSongInfo[]>（:160）
- export async function kgFetchLyrics(song: KgSongInfo): Promise<LyricLine[] \| null>（:206）
- 带 MD5 签名（utils/md5.ts，纯 JS）构造酷狗请求，桌面端经 @/ipc/http 的 **"http" channel**（:32）。
- **桥依赖**：仅 "http" channel。

### 5.5 src/utils/preciseLyrics.ts（精确歌词编排，335 行）

回退链编排器：**用户偏好来源（默认 QQ）→ 另一云端（QQ ⇄ 酷狗）→ 已登录网易云时追加 Meting → 调用方回退本地歌词**。

- export type LyricSource = "qq" \| "kg" \| "meting"；LyricSourcePref = LyricSource \| "local"
- export type PreciseLyricsResult（:37）：成功 { ok: true, source, lines, songId, songTitle, wordLevel, fromCache }；失败 { ok: false, reason: "missing-info"\|"search-failed"\|"no-match"\|"no-lyrics", detail? }
- export async function fetchCloudLyrics(opts: PreciseLyricsOptions): Promise<PreciseLyricsResult>（:288）——入口。PreciseLyricsOptions 见 :270。
- 匹配规则：去括号归一化标题 → 「同名 + 时长差 ≤ ±1s」→ 取前 5 个候选 → 优先含逐字的结果。
- 缓存：进程内 Map，成功 1h / 失败 10min，键含来源顺序。
- **桥依赖**：间接依赖 "http"（QQ/KG）与全局 fetch（Meting）；lrcGet/lrcSet 走 IndexedDB。**不直接 invoke**。

### 5.6 src/utils/lyricTimeline.ts（歌词时间轴，286 行）

- tokenizeLyric(text): string[]（:16）——Intl.Segmenter grapheme 分词。
- buildRoughUnits(text, start, end): WordUnit[]（:57）——按字数**均匀粗排**逐字时间。
- attachRoughTimeline(lines): void（:79）——给无 units 的行补粗排时间轴。
- META_RE（:96）、buildLyricSequence(rawLines, detectInstrumental = true): LyricLine[]（:135）、parseLrc(text, detectInstrumental = true): LyricLine[]（:200）——双语 LRC 解析。
- filterInstrumentalPlaceholder(lines): LyricLine[] \| null（:282）——识别「作词/作曲/编曲」三点与长间奏，插入 instrumental 标记行。
- 桥依赖：无。

### 5.7 与 utils/wordAnalysis.ts 的关系

preciseLyrics 产出的是**官方逐字时间轴**；当来源只有逐行时，wordAnalysis.analyzeSongWords(source, lines, key)（:81）用 OfflineAudioContext + Worker FFT **音频起音检测**补齐逐字（见 §4），结果写 IndexedDB。applyPreciseWordTimes / getPreciseWordTimes（wordAnalysis.ts 后半）供 player store 调用。

---

## 6. 账号登录

**结论：音乐模块有登录，但只有网易云与酷狗两家；QQ 音乐没有登录。**

### 6.1 网易云（有：扫码 + 手机号验证码）

- 入口（capabilities）：netease_login_qr_key → netease_login_qr_check；netease_sms_captcha_sent → netease_login_cellphone；netease_account 校验登录态；netease_logout 退出。
- 前端入口：stores/netease.ts 的 useNeteaseStore → init()（:48 校验）、openQr()（:70 取 unikey + QRCode.toDataURL("https://music.163.com/login?codekey=<key>")）、poll()（:90 轮询 800/801/802/803）、sendSms()、phoneLogin()、logout()。
- 持久化：**Rust 侧** backend/src/netease.rs，落盘文件 netease.json（PERSIST_FILE，:80）于 app_data_dir，存 cookie（含 MUSIC_U）+ 设备指纹 + 账号缓存；重启自动恢复（:8-9、:141 load_persist、:151 save_persist）。凭据不进 WebView。
- 登录成功后前端拉歌单/云盘/红心（refreshPlaylists / refreshCloudCount / refreshLikedSongs）。

### 6.2 酷狗（有：扫码 + 手机号验证码 + 每日签到）

- 入口（capabilities）：kugou_login_status、kugou_login_qr_key、kugou_login_qr_check、kugou_captcha_sent、kugou_login_cellphone、kugou_logout、kugou_sign_in（另有未在音乐闭包使用的 kugou_account）。
- 前端入口：stores/kugou.ts 的 useKugouStore → init()/refreshStatus()（:71）、openQr()（:98）、sendSms()（:181）、phoneLogin()（:212）、signIn()（:231）、logout()（:249）。
- 持久化：**Rust 侧** backend/src/kugou.rs，落盘文件 kugou.json（PERSIST_FILE，:28），存 cookie jar + 账号信息 + 本地签到记录；退出只清账号凭据、保留设备身份 cookie（:151-159）。

### 6.3 QQ 音乐（无登录）

- utils/qqMusic.ts 只做匿名 GetSession + 搜索/歌词，cookie 固定 tmeLoginType=-1;。
- 全仓库搜索 qq_login / qqLogin / musicu 等均无命中；capabilities 中没有任何 qq_* 命令。
- **明确写：QQ 音乐无登录**（无扫码、无手机号、无 cookie 持久化、无 VIP 鉴权）。

### 6.4 其它

- meting（utils/meting.ts）是第三方聚合 API，无需登录；但 preciseLyrics 只在**已登录网易云**时才把 Meting 追加进回退链（见文件头注释 :4-5）。
- 未发现网易云/酷狗以外的音乐账号登录。

---

## 7. 统计

| 指标 | 数值 |
|---|---|
| 音乐闭包文件数（剔除番剧子树） | **66** |
| 其中直接承载桥调用的文件 | **27** |
| Rust 命令（invoke）总数 | **58** |
| — 音乐核心命令 | **45** |
| — 间接引入但音乐不触发 | **13**（skin_* 9 + is_safe_mode 1 + ffmpeg_set_path 1 + thumbnail_cache_path/save_thumbnail 2） |
| 主进程 channel 总数 | **7**（http、fs、dialog、store、opener、window、app） |
| 音乐订阅的事件名 | 2（scan:progress、smtc:command） |
| 桥方法 | 4（invoke、invokeBatch、call、emitTo）+ 1 字段（assetBase，仅移动端） |
| 未走桥的 Web 平台链路 | WebAudio 音效、OfflineAudioContext + Worker FFT、IndexedDB ×2、全局 fetch |

### 7.1 最小可跑通集合（「本地曲库 + 在线搜索播放 + 歌词」）

**Rust 命令（最少 12 条，含 3 条可选）**

| 必需 | 命令 | 说明 |
|---|---|---|
| ✅ | list_files | 本地曲库列表（含 thumbPath） |
| ✅ | count_files | 总数/分页 |
| ✅ | library_counts | 类型角标 |
| ✅ | get_thumbnail | 音频封面（列表未带 thumbPath 时的批量补齐） |
| ✅ | get_song | 切本地歌取元数据 + 内嵌封面/歌词 |
| ✅ | scan_start | 首次导入曲库 |
| ✅ | scan_status | 扫描进度（无事件通道时兜底） |
| ✅ | scan_cancel | 取消扫描 |
| ✅ | netease_song_url | 网易云在线播放直链（Rust 侧匿名注册即可用） |
| ✅ | kugou_song_url | 酷狗在线播放直链（列表不带直链，必需） |
| ✅ | kugou_search | 酷狗搜索（meting 不放行酷狗） |
| ✅ | kugou_cover | 酷狗封面代理（无 CORS，缺失则封面全裂） |
| 可选 | kugou_rank_list + kugou_rank_songs + kugou_everyday_recommend | 酷狗榜单/每日推荐 |
| 可选 | netease_playlist_detail + netease_recommend_playlists | 网易云歌单/推荐 |

> 说明：meting 搜索/歌单/歌词走**全局 fetch**，不需要 Rust 命令；但 kugou_search / kugou_rank_* 必须走 Rust（CORS + 签名）。

**主进程 channel（最少 1 个必需 + assetBase 字段 + 2 个可选）**

| 必需 | channel | 说明 |
|---|---|---|
| ✅ | "http" | QQ/酷狗歌词与酷狗签名请求（preciseLyrics → qqMusic/kgMusic） |
| ✅ | assetBase（window.__SILVERMOON__ 字段，不是 channel） | Flutter 侧 loopback HTTP 服务，本地音频 Range 播放 + 缩略图 |
| 可选 | "fs" | 逐字精排读本地音频字节（不启用 wordAnalysis 则不需要） |
| 可选 | "dialog" + "fs" | 下载音频/封面到本地 |

**事件**：scan:progress（有则用，无则退化到 scan_status 轮询——代码已实现 pollIfNoEvents 兜底）。

**不需要**：登录相关命令（网易云/酷狗扫码、短信、签到）、smtc_*（Windows 专有）、webdav_*、store / window / opener / app channel、全部 skin_*。歌词只需 meting（全局 fetch + IndexedDB）即可跑通「逐行歌词 + 粗排逐字」；官方逐字（QQ/KG）才需要 "http"。

### 7.2 建议的 Dart 侧实现顺序

1. assetBase loopback HTTP 服务（Range 支持）+ get_thumbnail / list_files / get_song / scan_* → 本地曲库可播。
2. "http" channel + kugou_search / kugou_song_url / kugou_cover / netease_song_url → 在线搜索播放。
3. meting 全局 fetch 直连（无需 Dart 参与）+ IndexedDB 歌词缓存 → 逐行歌词。
4. "http" channel + qqSearchSongs / qqFetchLyrics / kgSearchSongs / kgFetchLyrics + qrcDecrypt / krcDecrypt（纯 Dart 移植）→ 官方逐字歌词。
5. （可选）"fs" + OfflineAudioContext/Worker 等价物 → 音频起音精排。

---

## 附：与既有文档的关系

- docs/mobile-spec/02-playback.md：播放队列、音效、统计的行为规格（本文不重复）。
- docs/mobile-spec/04-lyrics.md：歌词来源链、QRC/KRC 协议细节（本文 §5 只给桥视角的入口签名与依赖）。
- 本文 05：**桥调用面**——Dart 侧需要实现的全部命令/channel/asset 约定与 Web 平台依赖。
