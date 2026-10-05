pub mod anime;
pub mod boot_trace;
pub mod commands;
pub mod error;
pub mod kugou;
pub mod media;
pub mod netease;
pub mod novel;
pub mod novel_auth;
pub mod novel_bqg;
pub mod osu;
pub mod pixiv;
pub mod tray;
pub mod webdav;

pub use error::{LumiLunaError, Result as LumiLunaResult};

use serde::{Deserialize, Serialize};
use silvermoon_ipc::HostApi;

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

#[cfg_attr(mobile, silvermoon_ipc::mobile_entry_point)]
pub fn run() {
    // Win7 诊断：`run()` 内部有若干库初始化（SQLite、TLS、正则引擎等），
    // 任何一处踩到 Win8+ API 都会让进程在**没有输出**的情况下消失。
    // 每阶段进入前先落盘一行，崩溃时最后一行即区间下界。
    // 详见 `boot_trace` 的模块文档。
    use boot_trace::{step, Phase};

    step("run() 开始：准备构造 IPC Builder（此前的静态初始化已完成）");

    // 桌面框架的插件机制在这里整体不存在：dialog / fs / store / http 是纯前端能力，
    // 由渲染进程经 Electron 主进程实现；opener / global-shortcut 在 Rust 侧各只有
    // 一处调用点，已在 IPC 层里直接实现（见 crates/silvermoon-ipc/src/plugins.rs）。
    silvermoon_ipc::Builder::default()
        .setup(|app| {
            step("setup 闭包已进入（IPC 框架初始化完成）");

            // 索引库落盘在 app data 目录，重启后保留扫描结果
            let db_phase = Phase::begin("打开数据库（rusqlite bundled SQLite）");
            let conn = open_db(app.handle())?;
            db_phase.done();
            app.manage(commands::DbState(std::sync::Mutex::new(conn)));
            app.manage(commands::JobState(std::sync::Mutex::new(
                std::collections::HashMap::new(),
            )));

            // Windows 系统媒体控件（SMTC）会话
            #[cfg(all(windows, feature = "smtc"))]
            {
                step("初始化 SMTC（Win10+ 系统媒体控件）");
                commands::smtc::setup(app.handle());
                boot_trace::info("SMTC 初始化完成");
            }
            #[cfg(not(all(windows, feature = "smtc")))]
            {
                // Win7 版走这条：SMTC 是 WinRT/Win10+ API，win7 feature 会关掉它。
                // 显式记一行，避免日后误判「SMTC 没跑是因为坏了」。
                boot_trace::info("跳过 SMTC（非 Windows 或 win7 feature 未启用）");
            }

            // 扩展框架：发现 extensions/、拉起引擎、注册热键（须在 tray 之前，托盘菜单要读扩展贡献）
            step("初始化扩展框架（扫描 extensions/、引擎、热键）");
            if let Err(error) = commands::extension::setup(app.handle()) {
                boot_trace::error(&format!("扩展框架初始化失败（不致命）：{error}"));
                eprintln!("setup extensions failed: {error}");
            } else {
                boot_trace::info("扩展框架初始化完成");
            }

            // 系统托盘（播放控制 / 显示主界面 / 退出）
            step("初始化系统托盘");
            if let Err(error) = tray::setup(app.handle()) {
                boot_trace::error(&format!("托盘初始化失败（不致命）：{error}"));
                eprintln!("setup tray failed: {error}");
            } else {
                boot_trace::info("系统托盘初始化完成");
            }

            // 在线番剧：内置规则种子 + 隐藏取流 webview
            step("初始化在线番剧模块（规则种子）");
            anime::setup(app.handle());
            boot_trace::info("在线番剧模块初始化完成");

            // 在线图片（Pixiv）：加载持久化登录态
            step("初始化在线图片模块（Pixiv 登录态）");
            pixiv::setup(app.handle());
            boot_trace::info("在线图片模块初始化完成");

            step("setup 闭包全部完成，交还给 IPC 框架");
            Ok(())
        })
        .invoke_handler(silvermoon_ipc::generate_handler![
            commands::app::exit_app,
            commands::app::open_devtools,
            commands::app::is_safe_mode,
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
            // 本地音频标签读写（Win7 兼容版用；正式版走 Electron 侧的 taglib-wasm）
            commands::tags::tags_read_local,
            commands::tags::tags_write_local,
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
        ])
        .run(silvermoon_ipc::generate_context!())
        .expect("SilverMoon 后端启动失败");
    // 正常返回时也记一笔（`expect` 已处理失败路径，能走到这里是优雅退出）。
    boot_trace::info("IPC 服务已退出，run() 收尾");
}

/// 打开磁盘数据库；目录不可用时退回内存库，保证应用仍能启动。
///
/// 内部用 `anyhow` 链式传播并附加上下文，对外暴露统一的 `LumiLunaError`。
fn open_db(app: &silvermoon_ipc::Host) -> LumiLunaResult<rusqlite::Connection> {
    open_db_inner(app).map_err(|e| LumiLunaError::Other(e.to_string()))
}

/// `open_db` 的细分打点版。
///
/// 拆到这个粒度是因为 **`rusqlite` 开了 `bundled`**：SQLite 的 C 代码被静态编进
/// 我们的二进制，其中的 `GetSystemTimePreciseAsFileTime` 等调用属于 Win8+ API。
/// 这类调用**不会**出现在 PE 导入表里（由 CRT 动态解析），因此 `objdump -p` 那套
/// 静态闸门查不出来 —— 只能靠运行时打点。见 `doc/win7-electron22.md` 第 6 节。
fn open_db_inner(app: &silvermoon_ipc::Host) -> anyhow::Result<rusqlite::Connection> {
    use anyhow::Context;
    use boot_trace::{note_result, step};

    step("解析 app_data_dir");
    let conn = match app.path().app_data_dir() {
        Ok(dir) => {
            boot_trace::info(&format!("app_data_dir = {}", dir.display()));
            step("创建 app data 目录");
            note_result(
                "创建 app data 目录",
                std::fs::create_dir_all(&dir)
                    .with_context(|| format!("create app data dir {:?}", dir)),
            )?;
            step("打开 library.db（进入 rusqlite/SQLite C 代码）");
            note_result(
                "打开 library.db",
                rusqlite::Connection::open(dir.join("library.db")).context("open library.db"),
            )?
        }
        Err(e) => {
            boot_trace::warn(&format!("app_data_dir 不可用（{e:?}），改用内存库"));
            step("打开内存库");
            note_result(
                "打开内存库",
                rusqlite::Connection::open_in_memory().context("open in-memory db"),
            )?
        }
    };
    boot_trace::info("数据库连接已建立，开始建表");
    note_result(
        "初始化数据库 schema",
        commands::init_db(&conn).context("init db schema"),
    )?;
    boot_trace::info("数据库 schema 就绪");
    Ok(conn)
}
