pub mod anime;
pub mod app_meta;
pub mod bilibili;
pub mod boot_log;
pub mod commands;
pub mod cover;
pub mod error;
pub mod gpu_canvas;
pub mod kugou;
pub mod media;
pub mod netease;
pub mod novel;
pub mod novel_auth;
pub mod novel_bqg;
pub mod osu;
pub mod pixiv;
pub mod splash;
pub mod tray;
pub mod webdav;

pub use error::{LumiLunaError, Result as LumiLunaResult};

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// 文件索引记录
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct MediaFile {
    pub id: String,
    pub path: String,
    pub parent: String,
    pub name: String,
    pub ext: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub size: i64,
    pub mtime: i64,
    pub scanned_at: i64,
    pub deleted: i64,
}

/// 媒体元数据。字段以 camelCase 过桥，与前端 TS 类型一一对应。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    pub file_id: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub year: Option<i64>,
    pub track_no: Option<i64>,
    pub disc_no: Option<i64>,
    pub duration_ms: Option<i64>,
    pub bitrate: Option<i64>,
    pub sample_rate: Option<i64>,
    pub channels: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub orientation: Option<i64>,
    pub codec: Option<String>,
    pub fps: Option<f64>,
    pub taken_at: Option<i64>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<i64>,
    pub exposure: Option<String>,
    pub f_number: Option<f64>,
    pub focal_length: Option<f64>,
    pub gps_lat: Option<f64>,
    pub gps_lng: Option<f64>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub language: Option<String>,
    pub page_count: Option<i64>,
    pub chapter_count: Option<i64>,
    pub has_cover: bool,
    pub has_lyrics: bool,
}

/// 列表项：files 与 media_metadata 的扁平化联接结果。
/// 列表页一次拿全展示所需字段，避免逐条再发 get_metadata。
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    pub id: String,
    pub path: String,
    pub parent: String,
    pub name: String,
    pub ext: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub size: i64,
    pub mtime: i64,
    pub scanned_at: i64,
    pub deleted: i64,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub codec: Option<String>,
    pub fps: Option<f64>,
    pub taken_at: Option<i64>,
    pub has_cover: bool,
    pub favorite: bool,
    /// 缩略图磁盘缓存路径（**已生成时**才有值，未生成时为 None）。
    ///
    /// 列表接口顺带带上它，前端可直接拼 `asset://` URL 交给 <img> 流式加载，
    /// 无需为每张图再发一次 get_thumbnail——大图库滚动时"缓存命中"这条路径的命令数
    /// 从 O(可见项) 降到 0。未命中项由前端经批量通道一次补齐。
    pub thumb_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Song {
    pub file: MediaFile,
    pub meta: MediaMetadata,
    pub cover_base64: Option<String>,
    pub lyrics: Option<String>,
}

// ---------------------------------------------------------------------------
// GPU 画布命令
//
// 三个命令都是**薄封装**：真正的逻辑在 gpu_canvas 模块里。放在这里是因为
// Tauri 的 `generate_handler!` 需要命令在 crate 根部可见。
//
// 注意它们是 `async`：Tauri 文档明确写着「在同步命令或事件处理器里建窗会在
// Windows 上死锁」（wry#583），而这些命令会触发建窗。
// ---------------------------------------------------------------------------

/// 打开 GPU 画布窗口。参数是画布区域的**逻辑像素**坐标与尺寸。
#[tauri::command]
async fn gpu_canvas_open(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    gpu_canvas::open(
        &app,
        gpu_canvas::CanvasRect {
            x,
            y,
            width,
            height,
        },
    )
}

/// 更新 GPU 画布窗口的位置与尺寸（前端布局变化时调用）。
#[tauri::command]
async fn gpu_canvas_resize(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    gpu_canvas::resize(
        &app,
        gpu_canvas::CanvasRect {
            x,
            y,
            width,
            height,
        },
    )
}

/// 关闭 GPU 画布窗口并停止渲染线程。
#[tauri::command]
async fn gpu_canvas_close(app: tauri::AppHandle) -> Result<(), String> {
    gpu_canvas::close(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 这一段（Builder 构建 + 插件 init + 配置里的窗口创建）在 setup 之前完成，
    // 是「进程启动 → 窗口出现」里最不透明的一段，因此入口处单独打点。
    // 最早的时刻把启动动画拉起来：它是个独立的原生小程序，毫秒级就能出画面，
    // 用来盖住 Tauri 那 1~2 秒的冷启动空窗（详见 splash.rs 的说明）。
    // 失败/缺失都不影响启动 —— 那时窗口就由「首屏就绪」或看门狗直接显示。
    let splash_started = splash::spawn();
    boot_log::record(if splash_started {
        "run() 开始（启动动画已拉起）"
    } else {
        "run() 开始（无启动动画）"
    });
    let app = tauri::Builder::default()
        // 插件顺序无关紧要，但 dialog / fs / store / http 是纯前端能力
        // （渲染进程经 @tauri-apps/plugin-* 直接调用），Rust 侧不引用它们。
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // app-cover:// 是在线封面的取图代理（绕 CORS + 防盗链伪装 + 磁盘缓存）。
        // 必须在 **Builder** 阶段注册：该 API 只存在于 Builder，setup 里的
        // AppHandle 没有这个能力；且要早于任何窗口开始加载。
        .register_asynchronous_uri_scheme_protocol("app-cover", |ctx, request, responder| {
            cover::handle_request(ctx, request, responder);
        })
        // 主窗口在 tauri.conf.json 里是 `visible: false` 创建的，**显示时机交给
        // `splash::reveal()` 这一个入口**（见 splash.rs）：
        //   - 有启动动画 → 前端报就绪后，启动动画淡出，再显示主窗口（两端交叠）；
        //   - 没有启动动画 → 前端报就绪后直接显示；
        //   - 10 秒看门狗 → 无论前面发生什么都强制显示。
        //
        // 这里只保留打点，**不再负责显示**。历史：更早是先「ContentLoading 即显示」，
        // 更早是 Electron 的 ready-to-show（archive/electron-host/electron/windows.ts）。
        // 现在改成「等首屏真的画好再显示」，用户第一眼看到的就是成品而不是中间态。
        //
        // ⚠️ 用**全局** on_page_load（挂在 Builder 上，对所有 webview 生效），
        // 而不是给主窗口单独建 WebviewWindowBuilder —— 配置里的窗口由
        // `WebviewWindowBuilder::from_config` 在 setup 之前统一创建，代码里再建一次
        // 会变成两个窗口。各窗口按自己的 label 过滤即可。
        .on_page_load(|webview, payload| {
            if webview.label() != "main" {
                return;
            }
            // 两个事件在 WebView2 上的真实对应（见 wry 的 webview2/mod.rs）：
            //   Started  = ContentLoading      —— 文档内容开始加载（首个脚本执行前）
            //   Finished = NavigationCompleted —— 整页资源（含 bundle）加载完
            //
            // 这两个点都**不再**用于显示窗口，只留作耗时对照（见 doc/TAURI-MIGRATION.md
            // 的启动时间线）。显示统一走 splash::reveal()。
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => {
                    boot_log::record("页面开始加载(ContentLoading)");
                }
                tauri::webview::PageLoadEvent::Finished => {
                    boot_log::record("页面加载完成(NavigationCompleted)");
                }
            }
        })
        .setup(|app| {
            // 绑定日志文件（此前攒下的打点会在这里补写），并记下 setup 起点。
            // 注意：配置里的窗口是在**进入本闭包之前**由 from_config 创建的，
            // 所以「run() 开始 → setup 开始」这段就是 Builder + 插件 init + 建窗口。
            boot_log::attach(app.handle());
            boot_log::record("setup 开始");
            // 登记句柄：之后「首屏就绪」或启动器淡出结束时，要靠它回到主线程显示窗口
            splash::set_app(app.handle().clone());
            // GPU 画布的会话状态（渲染线程的 running 标志）
            app.manage(gpu_canvas::CanvasState::default());

            // 兜底：万一 on_page_load 没触发（页面加载失败 / 资源挂住），
            // 主窗口会永远停在 hidden 状态 —— 那是「双击图标没反应」的最坏情况。
            // 这里独立起一个看门狗，到点只要还没可见就强制显示，宁可让用户看到
            // 一个报错页面，也不要让应用像没启动一样。
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    if let Some(window) = handle.get_webview_window("main") {
                        if !window.is_visible().unwrap_or(true) {
                            eprintln!("[silvermoon] 首屏就绪信号超时，强制显示主窗口");
                            boot_log::record("看门狗触发：强制显示主窗口");
                            // 与「首屏就绪」「启动器淡出结束」共用同一个显示入口，
                            // 避免两条路径各自 show 造成重复或竞争
                            splash::reveal();
                        }
                    }
                });
            }

            // 首个启动：把旧项目 LumiLuna 的数据目录整份复制过来（只读旧目录）。
            // 必须早于 open_db —— 否则新目录会被创建，迁移条件就不再成立。
            if let Ok(dir) = app.path().app_data_dir() {
                if app_meta::migrate_legacy_data(&dir) {
                    eprintln!("[silvermoon] 已从旧项目目录迁移数据到 {dir:?}");
                }
            }
            boot_log::record("旧数据迁移检查完成");
            // 索引库落盘在 app data 目录，重启后保留扫描结果
            let conn = open_db(app.handle()).map_err(|e| -> Box<dyn std::error::Error> {
                Box::new(std::io::Error::other(e.to_string()))
            })?;
            app.manage(commands::DbState(std::sync::Mutex::new(conn)));
            app.manage(commands::JobState(std::sync::Mutex::new(
                std::collections::HashMap::new(),
            )));
            boot_log::record("打开数据库 + 建表完成");

            // 以下每一步都在主线程上同步执行，且**早于事件循环启动**，
            // 因此它们全部计入「窗口出现」之前的时间。逐个打点是为了能看出
            // 到底是谁贵——排查启动慢时不用再猜。
            commands::smtc::setup(app.handle());
            boot_log::record("SMTC 初始化完成");

            // 扩展框架：发现 extensions/、拉起引擎、注册热键（须在 tray 之前，托盘菜单要读扩展贡献）
            if let Err(error) = commands::extension::setup(app.handle()) {
                eprintln!("setup extensions failed: {error}");
            }
            boot_log::record("扩展加载完成");

            // 系统托盘（播放控制 / 显示主界面 / 退出）
            if let Err(error) = tray::setup(app.handle()) {
                eprintln!("setup tray failed: {error}");
            }
            boot_log::record("托盘创建完成");

            // 在线番剧：内置规则种子 + 隐藏取流 webview
            anime::setup(app.handle());
            boot_log::record("番剧规则同步完成");

            // 在线图片（Pixiv）：加载持久化登录态
            pixiv::setup(app.handle());
            boot_log::record("setup 结束（即将进入事件循环）");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ---- 宿主能力（Electron 主进程侧的等价实现）----
            commands::music_tags::music_tags_op,
            commands::host::host_app,
            commands::host::host_updater,
            commands::host::host_path,
            commands::host::host_version,
            commands::host::host_app_exit,
            commands::host::host_clear_cover_cache,
            commands::host::host_legacy_migrated,
            commands::host::host_updater_check,
            commands::host::host_updater_install,
            commands::app::exit_app,
            commands::app::open_devtools,
            commands::app::is_safe_mode,
            // ---- B 站（协议在 silvermoon-bili crate，网络在本模块）----
            bilibili::bili_danmaku,
            // ---- 桌面环境集成（UDA：壁纸 / 常亮锁 / 系统通知 / 系统强调色）----
            commands::desktop::desktop_capabilities,
            commands::desktop::desktop_set_wallpaper,
            commands::desktop::desktop_get_wallpaper,
            commands::desktop::desktop_accent_color,
            commands::desktop::desktop_notify,
            commands::desktop::desktop_wakelock_acquire,
            commands::desktop::desktop_wakelock_release,
            commands::desktop::desktop_wakelock_status,
            commands::book::get_book_progress,
            commands::book::save_book_progress,
            commands::scan::scan_start,
            commands::scan::scan_cancel,
            commands::scan::scan_status,
            commands::scan::list_files,
            commands::scan::count_files,
            commands::scan::library_counts,
            commands::metadata::get_metadata,
            commands::skin::skin_read_external_file,
            commands::skin::skin_save,
            commands::skin::skin_list,
            commands::skin::skin_load,
            commands::skin::skin_delete,
            commands::skin::skin_stage_zip,
            commands::skin::skin_commit,
            commands::skin::skin_abort,
            commands::skin::skin_dir,
            commands::song::get_song,
            commands::song::record_play,
            commands::song::toggle_favorite,
            commands::song::list_favorites,
            commands::song::list_history,
            commands::song::list_trash,
            commands::song::empty_trash,
            commands::stats::start_play_session,
            commands::stats::end_play_session,
            commands::stats::get_listen_stats,
            commands::stats::list_listen_stats,
            commands::stats::list_top_tracks,
            commands::stats::listen_source_breakdown,
            commands::smtc::smtc_set_media,
            commands::smtc::smtc_set_playback,
            commands::thumbnail::get_thumbnail,
            commands::thumbnail::get_thumbnails,
            commands::thumbnail::thumbnail_cache_path,
            commands::thumbnail::save_thumbnail,
            commands::thumbnail::clear_thumbnail_cache,
            commands::ffmpeg::ffmpeg_status,
            commands::ffmpeg::ffmpeg_set_path,
            commands::ffmpeg::ffmpeg_download_url,
            webdav::webdav_configure,
            webdav::webdav_list,
            webdav::webdav_test,
            webdav::webdav_media_url,
            netease::netease_login_qr_key,
            netease::netease_login_qr_check,
            netease::netease_sms_captcha_sent,
            netease::netease_login_cellphone,
            netease::netease_account,
            netease::netease_user_playlists,
            netease::netease_playlist_detail,
            netease::netease_cloud,
            netease::netease_song_url,
            netease::netease_song_comments,
            netease::netease_set_song_liked,
            netease::netease_likelist,
            netease::netease_recommend_playlists,
            netease::netease_daily_recommend_songs,
            netease::netease_personal_fm,
            netease::netease_logout,
            // ---- 在线音乐（酷狗）----
            kugou::kugou_login_status,
            kugou::kugou_login_qr_key,
            kugou::kugou_login_qr_check,
            kugou::kugou_captcha_sent,
            kugou::kugou_login_cellphone,
            kugou::kugou_account,
            kugou::kugou_logout,
            kugou::kugou_sign_in,
            kugou::kugou_song_url,
            kugou::kugou_cover,
            kugou::kugou_search,
            kugou::kugou_playlist_detail,
            kugou::kugou_rank_list,
            kugou::kugou_rank_songs,
            kugou::kugou_everyday_recommend,
            kugou::kugou_recommend_songs,
            kugou::kugou_user_playlists,
            kugou::kugou_playlist_tracks,
            // ---- osu! 谱面源 ----
            osu::osu_search,
            osu::osu_download,
            osu::osu_import_archive,
            novel::novel_search,
            novel::novel_rank,
            novel::novel_category,
            novel::novel_recommend,
            novel::novel_detail,
            novel::novel_catalogue,
            novel::novel_content,
            novel::novel_shelf_list,
            novel::novel_shelf_add,
            novel::novel_shelf_remove,
            novel::novel_progress_get,
            novel::novel_progress_set,
            novel::novel_chapter_cache_get,
            novel::novel_chapter_cache_put,
            novel::novel_read_session_start,
            novel::novel_read_session_end,
            novel::novel_stats_get,
            novel::novel_stats_list,
            novel::novel_source_breakdown,
            novel::novel_top_books,
            novel_bqg::bqg_home,
            novel_bqg::bqg_detail,
            novel_bqg::bqg_search,
            novel_bqg::bqg_catalogue,
            novel_bqg::bqg_content,
            novel_auth::wenku8_login_submit,
            novel_auth::wenku8_login_status,
            novel_auth::wenku8_logout,
            novel_auth::wenku8_userinfo,
            novel_auth::wenku8_shelf_online,
            novel_auth::wenku8_login_open,
            novel_auth::wenku8_login_log,
            novel_auth::wenku8_login_poll,
            novel_auth::app_log,
            anime::anime_fetch,
            anime::anime_media_url,
            anime::anime_webview_resolve,
            anime::anime_rules_list,
            anime::anime_rules_save,
            anime::anime_rules_delete,
            anime::anime_rules_set_enabled,
            anime::anime_rules_index,
            anime::anime_history_list,
            anime::anime_history_upsert,
            anime::anime_history_delete,
            anime::anime_favorites_list,
            anime::anime_favorites_add,
            anime::anime_favorites_remove,
            // ---- 在线图片（Pixiv）----
            pixiv::pixiv_login_status,
            pixiv::pixiv_login_open,
            pixiv::pixiv_login_submit,
            pixiv::pixiv_logout,
            pixiv::pixiv_set_refresh_token,
            pixiv::pixiv_refresh_session,
            pixiv::pixiv_recommended,
            pixiv::pixiv_ranking,
            pixiv::pixiv_search,
            pixiv::pixiv_illust_detail,
            pixiv::pixiv_illust_comments,
            pixiv::pixiv_image,
            pixiv::pixiv_follow,
            pixiv::pixiv_next,
            pixiv::pixiv_bookmark_add,
            pixiv::pixiv_bookmark_delete,
            pixiv::pixiv_bookmark_detail,
            pixiv::pixiv_user_bookmarks,
            pixiv::pixiv_user_detail,
            pixiv::pixiv_user_illusts,
            pixiv::pixiv_follow_user,
            pixiv::pixiv_trending_tags,
            pixiv::pixiv_search_suggest,
            pixiv::pixiv_ugoira_frames,
            pixiv::pixiv_frame_bytes,
            // ---- 扩展框架 ----
            commands::extension::ext_list,
            commands::extension::ext_install,
            commands::extension::ext_uninstall,
            commands::extension::ext_set_enabled,
            commands::extension::ext_invoke,
            commands::extension::ext_open,
            // ---- GPU 画布（绘画）----
            gpu_canvas_open,
            gpu_canvas_resize,
            gpu_canvas_close,
        ])
        .build(tauri::generate_context!())
        .expect("SilverMoon 后端启动失败");
    // 这一刀把「run() 开始 → setup 开始」之间那段切开（实测约 1.2 秒，占稳态总耗时的一半以上）：
    //
    //   run() 开始 → 本行    : Builder 链 + generate_context + AppManager
    //                          （7 个插件的 initialize）+ **Runtime::new()**
    //   本行 → setup 开始    : 启动事件循环 → RuntimeRunEvent::Ready →
    //                          创建配置里的窗口 → **WebView2 环境创建** + assets
    //
    // 拆法是完全行为等价的：`Builder::run` 的实现本身就是
    // `self.build(context)?.run(|_, _| {})`（tauri 2.12.1 app.rs），
    // 这里只是把这两步摊开、在中间插一个打点，回调仍为空闭包。
    boot_log::record("Builder::build 完成（runtime + 插件 init）");
    app.run(|_, _| {});
}

/// 打开磁盘数据库；目录不可用时退回内存库，保证应用仍能启动。
///
/// 内部用 `anyhow` 链式传播并附加上下文，对外暴露统一的 `LumiLunaError`。
fn open_db(app: &tauri::AppHandle) -> LumiLunaResult<rusqlite::Connection> {
    open_db_inner(app).map_err(|e| LumiLunaError::Other(e.to_string()))
}

fn open_db_inner(app: &tauri::AppHandle) -> anyhow::Result<rusqlite::Connection> {
    use anyhow::Context;
    let conn = match app.path().app_data_dir() {
        Ok(dir) => {
            std::fs::create_dir_all(&dir)
                .with_context(|| format!("create app data dir {:?}", dir))?;
            rusqlite::Connection::open(dir.join("library.db")).context("open library.db")?
        }
        Err(_) => rusqlite::Connection::open_in_memory().context("open in-memory db")?,
    };
    commands::init_db(&conn).context("init db schema")?;
    Ok(conn)
}
