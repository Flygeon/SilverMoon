# 音乐标签写入（Write Music Tags）实现契约

> 状态：**已冻结**。所有实现者必须按本文件的接口名 / 文件名 / i18n 键名 / IPC 载荷执行。
> 需要变更时：先改本文件，再在 Team 里广播，不要各自发明。

> **v2 变更（当前生效）**：已按要求**移除 Music Tag Web 外部服务**，改为本机聚合
> QQ / 网易 / 酷狗 / 咪咕 / 酷我 五源搜索 + 相似度打分（见文末「追加契约 v2」）。
> 下文 §1 / §5.2 中关于 Music Tag Web 的部分**已作废**，仅作历史记录。

## 0. 需求（来自用户）

1. 右键菜单新增「写音乐标签」——本地歌曲与在线歌曲都要有。
2. 选中后打开 Dialog：
   - 可从 **Music Tag Web** 服务端 API 搜索候选并一键填充；
   - 所有字段**可手动编辑**；
   - 点「应用」生效。
   - **「还原默认」**：清空自定义音乐标签。
3. 对本地与在线都生效：
   - 本地 = 用 **taglib-wasm** 直接写音乐文件（标签 + 封面 + 歌词）；
   - 在线 = **内存写入 + 磁盘缓存**（封面/歌词落盘缓存，播放时覆盖平台原始数据）。

参考仓库已克隆在 `/tmp/music-tag-web`（xhongc/music-tag-web）。

---

## 1. Music Tag Web 服务端 API（已核对源码）

Base URL 由用户在设置里填（如 `http://192.168.1.10:8000`）。

- 认证：`POST {base}/api/token/`，JSON body `{ "username": "...", "password": "..." }`，
  返回 `{ "token": "<jwt>", "user": ... }`；后续请求带 `Authorization: JWT <token>`。
  其余接口全部要求 `IsAuthenticated`（见 `django_vue_cli/settings.py` 的 REST_FRAMEWORK）。
- 统一响应包：`{ "result": bool, "code": "200"/"400", "data": <T>, "message": string }`。
  失败时 `result=false`，`message` 为中文原因（如「文件夹不存在」）。

用到的三个 action（全部 POST，body 为 JSON）：

| 用途 | 路径 | 请求体 | 响应 data |
|---|---|---|---|
| 按标题搜候选 | `/api/fetch_id3_by_title/` | `{ resource, title, full_path? }` | 歌曲数组 |
| 取歌词 | `/api/fetch_lyric/` | `{ resource, song_id }` | LRC 文本 |
| 翻译歌词 | `/api/translation_lyc/` | `{ lyc }` | 带「」译文行的 LRC |

`resource` 取值（服务端 `MusicResource.get_resource`）：
`netease` | `qmusic` | `migu` | `kugou` | `kuwo` | `acoustid` | `smart_tag`。

各源返回的歌曲对象（**归一化前**，字段名不统一，但一定有）：

- 公共：`name`(标题)、`artist`、`album`、`id`(字符串，取歌词用)、`album_img`(封面 URL)、`year`
- `netease`：`id` 为数字；`year` 由 `publishTime` 转成 `"2005"`；`album_img` 为 netease 图床。
- `qmusic`：`id` = song mid；另外有 `musicid`、`mid`、`notice`(音质)、`readableText`。
- `migu`：`id` = `copyrightId`；`album_img` 是 120px 小图。
- `kugou`：`id` = `FileHash`；`name`/`artist` 可能残留 `<em>` 高亮标签，**必须清洗**；
  `album_img` 是 `{size}` 占位 URL，需要替换成 `150`。
- `kuwo`：`id` = `rid`；`year` 恒为 `""`。
- `smart_tag`：把 `{title, full_path}` 作为 title 传（由服务端多源评分聚合，返回按 score 排序的前 15）。
  `full_path` 是**服务端机器上的路径**，本地写入场景下服务端没有这个文件，仍可传空串，
  服务端读取失败会走标题匹配，只是少了相似度加分。
- `acoustid`：title 必须传 `full_path`（声纹匹配），本地场景基本不可用，保留但不作为默认。

归一化（前端 `musicTagApi.ts` 负责）：`<em>` 清洗、`{size}`→`150`、`year` 只保留 4 位数字、
`id` 一律转字符串。**候选对象同时保留原始 JSON 在 `raw` 字段**里，便于调试。

## 2. taglib-wasm 选型结论（已在本机实测）

- 版本 `taglib-wasm@2.3.0`（内置 TagLib 2.3.2），ESM-only，Node/Electron 端走 **WASI 后端**。
- **必须显式给 wasm 文件路径**：`TagLib.initialize({ wasmUrl: "<绝对路径>/taglib-wasi.wasm", forceWasmType: "wasi" })`。
  - 不带 `wasmUrl` 时 Node/Electron 下必然失败（`createRequire(undefined)` → `ERR_INVALID_ARG_VALUE`）；
  - 不要用 `wasmBinary`：那是 EmScripten 后端，Node 下会因缺 `wasi_snapshot_preview1` import 而 abort。
- 主进程是 **esbuild 打成 CJS** 的（`scripts/build-electron.mjs`），而 taglib-wasm 是 ESM：
  - 正确姿势：把 `taglib-wasm`、`taglib-wasm/simple` 标为 **external**，运行时用 CJS 里的
    `await import("taglib-wasm/simple")`（Node 原生支持从 CJS 动态 import ESM，**已实测通过**）。
  - **不要**把它 bundle 进 main.cjs：会破坏内部 `import.meta.url` / `createRequire` 的兜底路径（已实测失败）。
- 读写能力（已实测）：`applyTagsToFile`（简单 API，写盘）、`taglib.open(path)` → `file.tag().setXxx()`、
  `file.setLyrics([{text}])`、`file.setPictures([{ mimeType, data, type: "FrontCover" }])`、`file.saveToFile()`。
  读取：`readTags` / `readPictures` / `file.getLyrics()`。
- 支持格式（TagLib 原生）：mp3 / flac / m4a(mp4) / ogg / opus / wav / aiff / ape / wv / tta / dsf / wma 等。

---

## 3. 冻结契约 A：共享类型（`apps/desktop/shared/types.ts`，B 负责追加）

追加到文件末尾：

```ts
// ---- 音乐标签写入 ----

/** Music Tag Web 的数据源（对应服务端 MusicResource.get_resource） */
export type MusicTagSource =
  | "netease"
  | "qmusic"
  | "migu"
  | "kugou"
  | "kuwo"
  | "acoustid"
  | "smart_tag";

/** 一条可写入歌曲的音乐标签字段（全部 string，空串 = 不修改该字段） */
export interface MusicTagFields {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  /** 年份，原样字符串（"2005" / "2005-10-31" / ""） */
  year: string;
  /** 音轨号，保留 "3/12" 这种原始写法 */
  trackNo: string;
  discNo: string;
  genre: string;
  comment: string;
  /** 未同步歌词纯文本（LRC 或纯文本） */
  lyrics: string;
}

/** 封面处理方式：keep 保留原封面 / set 用新图替换 / remove 删除封面 */
export type MusicTagCoverMode = "keep" | "set" | "remove";

/** 封面图片（base64，可带 dataURL 前缀） */
export interface MusicTagCover {
  base64: string;
  mimeType: string;
}

/** 「写音乐标签」的目标 */
export type MusicTagTarget =
  | { kind: "local"; fileId: string; path: string; label: string }
  | { kind: "online"; song: OnlineSong; label: string };

/** API 搜索返回的归一化候选 */
export interface MusicTagSearchResult {
  source: MusicTagSource;
  /** 源内歌曲 id（取歌词用） */
  songId: string;
  title: string;
  artist: string;
  album: string;
  year: string;
  coverUrl: string;
  /** 原始 JSON，调试用 */
  raw?: Record<string, unknown>;
}

/** 在线歌曲的标签覆盖（内存 + 磁盘缓存共用） */
export interface AppliedOnlineTags {
  /** `${server}:​${id}` */
  key: string;
  fields: MusicTagFields;
  /** 磁盘缓存封面绝对路径（asset:// 用） */
  coverPath?: string | null;
  /** 写入时间（ms） */
  cachedAt: number;
}
```

注意：`AppliedOnlineTags` 的 key 写法是 **`${server ?? "netease"}:${id}`**（反引号模板字符串）。

## 4. 冻结契约 B：主进程 IPC（`musicTags` 通道，A 负责）

渲染进程统一走 `@/ipc/bridge` 的 `callBridge<T>("musicTags", payload)`。
**本通道共 11 个 op**（下表全量；T2 必须全部实现），对应渲染层 capabilities 的 13 个方法（§5.1）。
所有 op 的 `payload` / 返回：

| op | payload | 返回 |
|---|---|---|
| `writeLocal` | `{ path: string; fields: MusicTagFields; coverMode?: MusicTagCoverMode; coverBase64?: string; coverMime?: string }` | `{ path: string }` |
| `readLocal` | `{ path: string }` | `{ fields: MusicTagFields; hasCover: boolean }` |
| `backupLocal` | `{ path: string; fields: MusicTagFields }` | `{ created: boolean }` |
| `readLocalBackup` | `{ path: string }` | `MusicTagFields | null` |
| `cacheOnline` | `{ key: string; fields: MusicTagFields; coverMode?: MusicTagCoverMode; coverBase64?: string; coverMime?: string }` | `AppliedOnlineTags` |
| `readOnline` | `{ key: string }` | `AppliedOnlineTags | null` |
| `removeOnline` | `{ key: string }` | `{ removed: boolean }` |
| `listOnline` | `{}` | `AppliedOnlineTags[]` |
| `readLyrics` | `{ key: string; kind?: "tag" \| "original" }` | `string \| null`（kind 缺省 `tag`：旁路歌词文件；`original`：备份里的原始歌词） |
| `writeLyrics` | `{ key: string; lyrics: string }` | `{ written: boolean }`（空串 = 删除旁路文件） |
| `readOriginal` | `{ key: string }` | `MusicTagFields \| null`（= 在线覆盖记录的 `original`） |
| `writeOriginal` | `{ key: string; fields: Partial<MusicTagFields> }` | `AppliedOnlineTags`（**只合并/补齐 `original`**，不改 `fields`；无记录时建一条 fields 全空、original=给定值 的记录） |

> 旁路歌词文件：`userData/music-tags/lyrics/<sha1(key)>.txt`；在线歌曲没有可写文件，
> 因此「写音乐标签」里的歌词单独存这份旁路。**这三个 op 是 Lead 在 player.ts 歌词回退链里使用的**。

语义要求：
- `writeLocal`：字段**空串 = 清空该标签**（用户手动删掉即为清空）。`coverMode` 缺省 `keep`。
  写入成功后返回；上层再调 Rust 的 `get_metadata` 刷新库。
- `readLocal`：读文件当前标签（taglib 读；失败回退空字段，不抛）。
- `backupLocal`：把「写入前」的原始字段存到 `userData/music-tags/local-backup/<sha1(path)>.json`，
  **仅当备份不存在时创建**（created=true），否则返回 created=false（不覆盖最原始的备份）。
- 在线缓存目录：`userData/music-tags/`，索引 `index.json`，封面 `cover-<sha1(key)>.<jpg|png|gif|webp>`。
  `cacheOnline` 的 `coverMode` 缺省 `keep`（保留已有缓存封面）；`remove` 删掉缓存封面。
- 主进程文件：`electron/tag-writer.ts`（**纯 Node，不 import electron，供 Node 验证脚本直测**）
  与 `electron/tags.ts`（electron 胶水：缓存目录 + 通道 handler）。
- wasm 定位顺序（三级兜底，任一命中即可）：
  1. `createRequire(import.meta.url).resolve("taglib-wasm/package.json")` 同目录 `dist/taglib-wasi.wasm`；
  2. `path.join(process.resourcesPath, "taglib-wasm", "taglib-wasi.wasm")`；
  3. `path.join(app.getAppPath(), "node_modules", "taglib-wasm", "dist", "taglib-wasi.wasm")`。

打包（A 负责）：
- `package.json`：`dependencies` 加 `"taglib-wasm": "^2.3.0"`；新增脚本 `"verify:music-tags": "node scripts/verify-music-tags.mjs"`。
- `scripts/build-electron.mjs`：`external` 增加 `"taglib-wasm"` 与 `"taglib-wasm/simple"`（**务必**，否则 bundle 后必挂）。
- `electron-builder.yml`：`files` 里在 `"!node_modules/**/*"` **之前**加
  `- node_modules/taglib-wasm/dist/**/*`；顶层加 `asarUnpack: - node_modules/taglib-wasm/**`；
  并在三个平台的 `extraResources` 各加一条
  `from: node_modules/taglib-wasm/dist/taglib-wasi.wasm` / `to: taglib-wasm/taglib-wasi.wasm`。
- `scripts/verify-music-tags.mjs`：用 esbuild 把 `electron/tag-writer.ts` 打成临时 ESM（external taglib-wasm），
  在临时目录里生成一个最小 WAV/MP3，真实跑一遍「写标签 → 读回 → 写封面 → 读回 → 清空字段 → 备份/缓存读回」，
  断言失败即 `process.exit(1)`。**这是本地唯一能跑的真实写入验证，必须通过。**

## 5. 冻结契约 C：渲染层（C 负责）

### 5.1 `src/capabilities/index.ts` 新增（在返回对象末尾）

```ts
  // ---- 音乐标签写入 ----
  /** 本地：写标签（含封面/歌词）。coverMode 缺省 keep */
  writeLocalMusicTags(
    path: string,
    fields: MusicTagFields,
    cover?: { mode: MusicTagCoverMode; image?: MusicTagCover },
  ): Promise<void>;
  /** 本地：读当前标签 */
  readLocalMusicTags(path: string): Promise<{ fields: MusicTagFields; hasCover: boolean }>;
  /** 本地：写入前备份（只在无备份时创建） */
  backupLocalMusicTags(path: string, fields: MusicTagFields): Promise<boolean>;
  /** 本地：读写入前备份 */
  readLocalMusicTagsBackup(path: string): Promise<MusicTagFields | null>;
  /** 在线：写内存 + 磁盘缓存 */
  cacheOnlineMusicTags(
    key: string,
    fields: MusicTagFields,
    cover?: { mode: MusicTagCoverMode; image?: MusicTagCover },
  ): Promise<AppliedOnlineTags>;
  /** 在线：读磁盘缓存（无则 null） */
  readOnlineMusicTags(key: string): Promise<AppliedOnlineTags | null>;
  /** 在线：删缓存（还原默认） */
  removeOnlineMusicTags(key: string): Promise<boolean>;
  /** 在线：全量列出（启动时水合内存） */
  listOnlineMusicTags(): Promise<AppliedOnlineTags[]>;
  /** 本地文件路径 → 库内 fileId（用于刷新元数据；找不到返回 null） */
  musicTagFileId(path: string): Promise<string | null>;
  /** 在线：读旁路歌词（写标签时保存的歌词文本；无则 null） */
  readOnlineMusicTagLyrics(key: string): Promise<string | null>;
  /** 在线：写/清旁路歌词（空串 = 删除） */
  writeOnlineMusicTagLyrics(key: string, lyrics: string): Promise<void>;
  /** 在线：读覆盖前平台原始标签快照 */
  readOnlineMusicTagOriginal(key: string): Promise<MusicTagFields | null>;
  /** 在线：补齐原始标签快照（只填缺的字段，不覆盖已有值） */
  cacheOnlineMusicTagOriginal(key: string, fields: Partial<MusicTagFields>): Promise<void>;
```

`musicTagFileId` 用 `listFiles({ search: <文件名>, limit: 20 })` 过滤 `path` 严格相等实现。
浏览器 mock（`src/capabilities/mock.ts`）里这些方法返回空实现（写内存 Map 即可）。

### 5.2 `src/utils/musicTagApi.ts`（B 负责，C 调用）

```ts
export interface MusicTagApiConfig { baseUrl: string; username: string; password: string }
export function configureMusicTagApi(cfg: MusicTagApiConfig): void;   // 变化时清 token
export function musicTagApiConfigured(): boolean;                      // baseUrl 非空
export async function testMusicTagApi(cfg: MusicTagApiConfig): Promise<{ ok: boolean; message: string }>;
export async function searchMusicTagSongs(source: MusicTagSource, title: string, fullPath?: string): Promise<MusicTagSearchResult[]>;
export async function fetchMusicTagLyrics(source: MusicTagSource, songId: string): Promise<string>;
export async function translateMusicTagLyrics(lrc: string): Promise<string>;
/** 下载封面 → base64（走主进程网络栈，规避 CORS/防盗链）；失败返回 null */
export async function fetchCoverAsBase64(url: string): Promise<MusicTagCover | null>;
```

实现要点：用 `@/ipc/http` 的 `fetch`（主进程网络栈，无 CORS）；token 内存缓存 + 401 时重登一次；
响应包 `result=false` → `throw new Error(message)`；网络错误 → 中文可读错误。
**登录失败要给出明确提示**（设置里没填 / 密码错 / 服务不可达）。

### 5.3 `src/stores/musicTags.ts`（C 负责，Lead 在 player.ts 里用）

```ts
export const useMusicTagsStore = defineStore("musicTags", () => {
  /** key = `${server ?? "netease"}:${id}` */
  function keyOf(song: { id: string; server?: MusicServer }): string;
  /** 同步取内存覆盖 */
  function get(song: { id: string; server?: MusicServer }): AppliedOnlineTags | undefined;
  /** 内存没有时读磁盘缓存并写入内存（并发去重） */
  function resolve(song: { id: string; server?: MusicServer }): Promise<AppliedOnlineTags | undefined>;
  /** 启动水合：listOnlineMusicTags() → 内存 */
  function hydrate(): Promise<void>;
  /** 应用：写内存 + 磁盘缓存，返回结果 */
  function apply(song: { id: string; server?: MusicServer }, fields: MusicTagFields,
                 cover?: { mode: MusicTagCoverMode; image?: MusicTagCover }): Promise<AppliedOnlineTags>;
  /** 还原默认：删磁盘缓存 + 内存 */
  function clear(song: { id: string; server?: MusicTagServer }): Promise<void>;
  /** 把覆盖转成播放器可直接用的形式（封面路径已在主进程落盘，这里只拼 asset://） */
  function playbackOverride(song: { id: string; server?: MusicServer }):
    { title: string; artist: string; album: string; coverUrl?: string } | undefined;
});
```
（类型以 `MusicServer` / `MediaEntry` 同款为准；`clear` 的参数类型是 `{ id: string; server?: MusicServer }`。）

```ts
// 写入草稿与归一化（同文件或 src/utils/musicTagDraft.ts，C 决定，测试要覆盖）
export function emptyMusicTagFields(): MusicTagFields;
export function fieldsFromMediaEntry(entry: MediaEntry, lyrics?: string | null): MusicTagFields;
export function fieldsFromOnlineSong(song: OnlineSong, lyrics?: string | null): MusicTagFields;
export function fieldsFromSearchResult(r: MusicTagSearchResult): MusicTagFields;
export function fieldsDirty(a: MusicTagFields, b: MusicTagFields): boolean;
```

### 5.4 Dialog（C 负责）

- `src/composables/useMusicTagDialog.ts`：
  ```ts
  export function openMusicTagDialog(target: MusicTagTarget): void;
  export function useMusicTagDialog(): { state };  // 全局单例 reactive
  ```
  state 至少含：`visible`、`target`、`fields`、`original`（打开时快照）、`source`(MusicTagSource)、
  `keyword`、`results`、`searching`、`applying`、`error`、`notice`、`coverPreview`(dataURL|null)、
  `coverMode`、`hasLocalBackup`。
- `src/components/MusicTagDialog.vue`：M3 风格（参考 `TextPrompt.vue` / `SourceSheet.vue` 的写法与 token），
  在 `App.vue` 挂载（`<MusicTagDialog />`）。内容：
  1. 顶部：目标名 + 本地/在线标签；
  2. 数据源选择（7 个 source）+ 搜索框 + 「从 API 获取」按钮 + 候选列表（点击填充）；
  3. 封面预览 + 「选择图片」（读本地图 → base64）/「移除封面」；
  4. 字段表单：title / artist / album / albumArtist / year / trackNo / discNo / genre / comment / lyrics（多行）；
  5. 底部：「还原默认」+「取消」+「应用」。
- **「还原默认」语义（用户明确要求）**：
  - 在线目标：`musicTags.clear(song)` → 立即恢复平台原始数据（内存 + 磁盘缓存都清掉），Dialog 关闭并提示；
  - 本地目标：存在「写入前备份」→ 用备份字段覆盖表单并**立即应用**（回到写入前）；否则 → 表单恢复为
    打开时的原始值（丢弃本次编辑，不写盘）。两种都要 toast 提示。
- 「应用」：本地 → `backupLocalMusicTags`（首次）→ `writeLocalMusicTags` → 刷新库元数据（`library.refresh` + `getMetadata`）；
  在线 → `musicTags.apply` → `player.refreshTagOverrides()`。成功/失败都要提示，失败不关窗。
- 无 API 配置时：显示「未配置 Music Tag Web API」提示 + 跳设置入口，但**手动填写仍然可用**。

### 5.5 右键菜单接入（C 负责）

- `src/components/TrackList.vue`：菜单加 `{ id: "write-tags", label: t("musicTag.menu"), icon: "sell" }`，
  选择后 `openMusicTagDialog({ kind: "local", fileId: item.id, path: item.path, label: titleOf(item) })`。
- `src/views/MusicView.vue` `onSongContext`：加同款项，目标为
  `{ kind: "online", song, label: song.name }`。

### 5.6 全局轻提示（C 负责）

`src/components/AppToast.vue`（新）：`useAppToast()` 暴露 `show(message)`，`App.vue` 挂 `<AppToast />`，
Teleport 到 body，3s 自动消失。Dialog 与菜单用它提示成败（复用 `--md-sys-color-*` token）。

### 5.7 播放器集成（**Lead 负责**，`src/stores/player.ts`）

- `loadOnlineSong` 之后套用 `musicTags.playbackOverride(song)`（title/artist/album/cover 优先用覆盖值）；
- 导出 `refreshTagOverrides()`：对当前在线曲目重新套用覆盖（Dialog 应用/还原后调用）。

## 6. 冻结契约 D：i18n 键（B 负责，中英双语都要）

命名空间 `musicTag`，键名固定如下（C 直接引用，不得另造）：

`menu`、`dialogTitle`、`targetLocal`、`targetOnline`、`source`、`keyword`、
`search`、`searching`、`noResults`、`searchFailed`、`fetchFromApi`、
`cover`、`pickCover`、`removeCover`、`coverKeep`、`lyrics`、`lyricsPlaceholder`、
`apply`、`applying`、`applied`、`applyFailed`、`cancel`、`close`、
`reset`、`resetOnline`、`resetLocalBackup`、`resetLocalOriginal`、`resetDone`、`resetFailed`、
`apiSection`、`apiUrl`、`apiUser`、`apiPass`、`apiTest`、`apiOk`、`apiFail`、
`notConfigured`、`notConfiguredHint`、`openSettings`、`manualHint`、`fields`、
`title`、`artist`、`album`、`albumArtist`、`year`、`trackNo`、`discNo`、`genre`、`comment`、
`backupRestored`、`onlineCached`、`coverTooLarge`

## 7. 文件归属（write scope，**不要越界写别人的文件**）

| 成员 | 独占文件 |
|---|---|
| B `api-core` | `shared/types.ts`、`shared/i18n.ts`、`src/stores/settings.ts`、`src/utils/musicTagApi.ts`、`src/utils/__tests__/musicTagApi.test.ts` |
| A `main-native` | `electron/tag-writer.ts`(新)、`electron/tags.ts`(新)、`electron/ipc.ts`、`scripts/build-electron.mjs`、`scripts/verify-music-tags.mjs`(新)、`package.json`、`package-lock.json`、`electron-builder.yml` |
| C `renderer-ui` | `src/capabilities/index.ts`、`src/capabilities/mock.ts`、`src/stores/musicTags.ts`(新)、`src/utils/musicTagDraft.ts`(新)、`src/utils/__tests__/musicTagDraft.test.ts`、`src/components/MusicTagDialog.vue`(新)、`src/components/AppToast.vue`(新)、`src/composables/useMusicTagDialog.ts`(新)、`src/components/TrackList.vue`、`src/views/MusicView.vue`、`src/views/SettingsView.vue`、`src/App.vue` |
| D `verifier` | `src/utils/__tests__/musicTagFlow.test.ts`(新)、`apps/desktop/doc/music-tags-verification.md`(新报告)。**只读他人源码，不改** |
| Lead | `src/stores/player.ts`、本文件、最终验收 |

## 8. 验证命令（每个成员提交前自跑）

```bash
cd apps/desktop
npm run typecheck                 # vue-tsc --noEmit && tsc -p tsconfig.electron.json
npx vitest run                    # 现有 603 个用例不得回归
npm run lint                      # eslint .
npm run build:main                # esbuild 主进程打包（A 必跑）
npm run verify:music-tags         # 真实 taglib-wasm 写入验证（A 必跑）
npx prettier --check <你改过的文件>
```

## 9. 已知风险 / 注意

- 本项目**没有 Rust 工具链**（`cargo: command not found`），不要试图改 / 编译 Rust；库刷新统一用
  `capabilities.getMetadata(fileId)`。
- `src/stores/player.ts` 2000+ 行，改动要贴着现有风格，别顺手重构。
- 渲染进程所有网络请求必须走 `@/ipc/http`（主进程网络栈），不能用裸 `fetch`（CORS）。
- 不要在 UI 里用 emoji，图标一律 `material-symbols-outlined`。
- 命令错误的 reject 值是**原始字符串**（不是 Error），拼提示时别包 `Error`。

---

# 追加契约 v2：去掉 Music Tag Web，改为本地智能匹配

> 目标（用户明确要求）：**删除「Music Tag Web 服务地址」设置项与整个外部服务依赖**，
> 改为在本机聚合各平台搜索 + 相似度打分。补 Migu / Kuwo 两个新源。

## 10. 数据源（全部实测通过，勿凭猜测改参数）

| source | 搜索接口 | 关键点 |
|---|---|---|
| `qq` | 已有 `src/utils/qqMusic.ts` 的 `qqSearchSongs(keyword)` | 返回 `QqSongInfo{id,mid,title,subtitle,artist,album,durationMs}`；封面需 album mid（见下） |
| `netease` | `GET https://music.163.com/api/cloudsearch/pc?s=<kw>&type=1&offset=0&limit=10` | 需 `Referer: https://music.163.com/`；结果在 `result.songs[]`：`name` / `ar[].name` / `al.name` / `al.picUrl` / `id` / `publishTime`(ms) |
| `kugou` | **已有** Rust 命令 `capabilities.kugouSearch(keyword)` | 返回原始 JSON，用现有 `kugouToOnlineSongs()` 归一化；`song.id`=`FileHash`，`pic` 已是 `{size}`→150 的图 |
| `migu` | `GET https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?text=<kw>&pageNo=1&pageSize=10&isCopyright=1&sort=1&searchSwitch={"song":1}` | UA 用 iPhone Safari；结果 `songResultData.result[]`：`name` / `singers[].name` / `albums[].name` / `copyrightId` / `lyricUrl`(可直接文本拉取) / `imgItems[].img`(webp) |
| `kuwo` | `GET https://search.kuwo.cn/r.s?client=kt&all=<kw>&pn=0&rn=10&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1&ft=music&encoding=utf8&rformat=json` | **必须带 `uid`/`ver`/`vipver`**（缺了会返回 ALBUM 为空的旧格式，实测）；响应是**单引号 JSON**，要容错解析；结果 `abslist[]`：`NAME`/`ARTIST`/`ALBUM`/`DC_TARGETID`/`DURATION`(秒)/`web_albumpic_short` |

封面的构造（已实测 200）：
- qq：`https://y.gtimg.cn/music/photo_new/T002R300x300M000<albumMid>.jpg`（albumMid 来自搜索结果 `album.mid`）
- migu：直接用 `imgItems[0].img`（webp，可显示）
- kuwo：`https://img1.kuwo.cn/star/albumcover/120/<web_albumpic_short>`
- netease：`al.picUrl`
- kugou：`song.pic`（`kugouToOnlineSongs` 已处理）

歌词接口（已实测）：
- netease：`GET /api/song/lyric?id=<id>&lv=-1&kv=-1&tv=-1` → `lrc.lyric` ✅
- migu：搜索结果里的 `lyricUrl` 直接 GET 就是 LRC 文本 ✅
- kuwo：`GET http://kuwo.cn/newh5/singles/songinfoandlrc?musicId=<DC_TARGETID>` → `data.lrclist[].{time,lineLyric}`，需自己拼 `[mm:ss.xx]` ✅
- qq：已有 `qqFetchLyrics(QqSongInfo)`（返回 `LyricLine[]`，需再拼回 LRC 文本）✅
- kugou：`http://m.kugou.com/app/i/krc.php?cmd=100&timelength=999999&hash=<FileHash>`（**best-effort**：实测部分 hash 返回空，失败就返回空串，不报错）

## 11. 冻结接口：`src/utils/musicTagSources.ts`（**Lead 负责**）

```ts
/** 一次源搜索的结果（含失败原因，用于 UI 提示「部分源失败」） */
export interface MusicTagSourceOutcome {
  source: MusicTagSource;
  results: MusicTagSearchResult[];
  error?: string;
}

/** 单源搜索；失败抛错（由调用方聚合） */
export function searchMusicTagSource(source: MusicTagSource, keyword: string): Promise<MusicTagSearchResult[]>;

/** 并发搜全部源；单个源失败不影响其它源，失败原因放进 outcome.error */
export function searchAllMusicTagSources(keyword: string): Promise<MusicTagSourceOutcome[]>;

/** 智能排序：按标题/艺术家/专辑相似度打分（移植 music-tag-web 的 match_score/match_artist） */
export function smartTagRank(
  seed: { title: string; artist: string; album: string },
  results: MusicTagSearchResult[],
): MusicTagSearchResult[];

/** 取某候选的歌词全文（LRC 文本）；无则空串 */
export function fetchTagLyrics(result: MusicTagSearchResult): Promise<string>;

/** 源 → i18n 键名（musicTag.sourceXxx） */
export function musicTagSourceLabelKey(source: MusicTagSource): string;
```

**类型改动**（B 负责）：`MusicTagSource` 改为本地五源；`MusicTagSearchResult` 加两个可选字段：

```ts
export type MusicTagSource = "qq" | "netease" | "kugou" | "migu" | "kuwo";

export interface MusicTagSearchResult {
  source: MusicTagSource;
  songId: string;
  title: string;
  artist: string;
  album: string;
  year: string;
  coverUrl: string;
  /** 该候选自带的歌词地址（migu 用；其它源留空） */
  lyricsUrl?: string;
  /** 封面尺寸等附加信息（qq 存 albumMid，kuwo 存 web_albumpic_short） */
  coverKey?: string;
  raw?: Record<string, unknown>;
}
```

## 12. 要删除的东西（**B 负责**）

1. 删除 `src/utils/musicTagApi.ts` 与 `src/utils/__tests__/musicTagApi.test.ts`。
2. `src/stores/settings.ts`：删掉 `musicTagApiUrl` / `musicTagApiUser` / `musicTagApiPass`（DEFAULTS + ref + return 三处）。
3. `shared/i18n.ts`：删掉 `musicTag` 命名空间里的 `apiSection/apiUrl/apiUser/apiPass/apiTest/apiOk/apiFail/notConfigured/notConfiguredHint/openSettings/manualHint`；
   新增：`sourceSmart`、`sourceQq`、`sourceNetease`、`sourceKugou`、`sourceMigu`、`sourceKuwo`、`smartHint`、`partialFailed`、`smartEmpty`。中英各一份，键集必须一致。
4. **不改** `src/util/musicTagLyrics.ts`、`electron/*`、`musicTags` store、capabilities（与本变更无关）。

## 13. UI 改动（**C 负责**）

1. `src/composables/useMusicTagDialog.ts`：
   - 删掉 `syncMusicTagApiConfig` / `musicTagApiConfigured` / `state.apiReady` / `isMusicTagApiReady`；
   - 新增 `state.mode: MusicTagSearchMode`（`"smart" | MusicTagSource`，默认 `"smart"`）与 `state.partialError: string`；
   - `searchTagCandidates()`：`smart` → `searchAllMusicTagSources(keyword)` → 汇总全部结果 → `smartTagRank(seed, all)` 取前 15；单源 → `searchMusicTagSource`；失败源写进 `partialError`（全部失败才返回错误文案）；
   - `fetchLyricsForResult(result)` 改用 `fetchTagLyrics(result)`；
   - 其余（apply/reset/syncLocalEntry/事件广播）保持不变。
2. `src/components/MusicTagDialog.vue`：删掉「未配置 API」提示条与「去设置」按钮；数据源下拉改为「智能匹配 + 5 个源」（智能为默认）；
   候选行显示来源标签；有 `partialError` 时在结果区显示一行弱提示。
3. `src/views/SettingsView.vue`：**整块删掉**「Music Tag Web」卡片（apiUrl/apiUser/apiPass/测试连接）及其相关 import/状态/样式。
4. 更新 `src/composables/__tests__/useMusicTagDialog.test.ts` 里对 `@/utils/musicTagApi` 的 mock → 改为 mock `@/utils/musicTagSources`。

## 14. 验收

```bash
cd apps/desktop
npm run typecheck && npx vitest run && npm run lint && npm run format:check
npm run build:renderer && npm run build:main && npm run verify:music-tags
```
另需 grep 确认全仓不再出现 `musicTagApiUrl` / `musicTagApi` / `Music Tag Web`（文档与 changelog 除外）。


---

# 追加契约 v3：本地右键入口 + 逐字歌词写标签

> 状态：**已实现并冻结**（2026-10-04）。
> 起因（用户原话）：「本地音乐右键没有写音乐标签的选项」+「能不能复用我的歌词获取服务，
> 写标签可以获取各个源的逐字歌词」。

## 15. 缺陷：本地音乐右键缺「写音乐标签」

### 根因

写标签功能（v2）只把菜单项接在**列表视图**与**在线歌曲**上：

| 入口 | 文件 | v2 状态 |
|---|---|---|
| 本地 · 列表视图 | `src/components/TrackList.vue` | ✅ 有 |
| 本地 · 网格视图（**默认**） | `src/components/MediaGrid.vue` | ❌ 只有「在资源管理器中显示」 |
| 在线歌曲（网格/列表） | `src/views/MusicView.vue` → `onSongContext` | ✅ 有 |

`MediaGrid` 是图片/视频/音乐/书籍**共用**组件，v2 只在 `TrackList` 里加菜单，
于是默认的网格视图下右键本地歌曲看不到该选项。

### 修法

1. `MediaGrid.onContextMenu` 按类型给菜单：`item.type === "audio"` 时追加
   `{ id: "write-tags", label: t("musicTag.menu"), icon: "sell" }`；其它类型保持只有「显示」。
2. 新增 `localTagTarget(item)`（`src/composables/useMusicTagDialog.ts`）作为**唯一**的
   本地目标构造函数，`MediaGrid` 与 `TrackList` 都改走它，避免两处手抄字段漂移。

### 接口（冻结）

```ts
/** 本地曲目 → 写标签目标（各入口共用） */
export function localTagTarget(item: MediaEntry): Extract<MusicTagTarget, { kind: "local" }>;
```

`MusicTagTarget` 的 local 分支新增三个**可选**字段，只服务逐字歌词的时长匹配：

```ts
| {
    kind: "local";
    fileId: string;
    path: string;
    label: string;
    artist?: string | null;    // 新增
    album?: string | null;     // 新增
    durationMs?: number | null; // 新增（±1s 匹配依赖它）
  }
```

回归测试：`src/components/__tests__/localMusicTagEntry.test.ts`
（含「非音频不给写标签」与两入口都走 `localTagTarget` 的源码断言）。

## 16. 逐字歌词：为什么是「增强型 LRC」

写标签最终只能落到**一个纯文本歌词字段**（taglib `setLyrics` → USLT / 内嵌歌词），
放不下 TTML / QRC / KRC 这些富格式。因此把逐字时间轴编码成**增强型 LRC**：

```
[00:12.34]<00:12.34>原<00:12.61>谅<00:12.88>我<00:13.20>
```

- 网易云 / QQ 音乐桌面版、foobar2000（Lyric Show 3）、MusicBee、AMLL 都认
  `<mm:ss.xx>` 词级标记 → **别的播放器也吃到逐字**；
- 不认的播放器当普通 LRC，去掉标记后照常按行显示（优雅降级）；
- 本项目的 `parseLrc` 同样识别它，写完立刻回放即逐字。

精度取**厘秒**（2 位小数）：这是增强型 LRC 的事实标准，第三方识别率最高。
末词补一个**空文本收尾标记** `<end>`，回读才能拿到正确尾音时长。

### 冻结接口：`src/utils/wordLevelLrc.ts`

```ts
/** 逐字时间轴 → 增强型 LRC 文本（无逐字的行写普通 LRC；空串=无可用歌词） */
export function serializeWordLevelLrc(lines: LyricLine[]): string;
/** 秒 → mm:ss.xx（厘秒，四舍五入，不产生 60 进位错误） */
export function formatLrcTime(total: number): string;
/** 一行是否有真正的逐字时间轴（判据：词元数 > 1） */
export function hasWordUnits(line: Pick<LyricLine, "units">): boolean;
export function hasAnyWordUnits(lines: LyricLine[]): boolean;
export function isWordLevelLyrics(lines: LyricLine[]): boolean;
/** 剥掉所有行上的 units（返回新数组）——写标签前必须做，见 §19 的 ⚠️ */
export function stripWordUnits(lines: LyricLine[]): LyricLine[];
/** `<mm:ss.xx>` 词级标记 → 秒（两位小数按厘秒、三位按毫秒） */
export function wordTagSeconds(minutes: string, seconds: string, fraction?: string): number;
```

### `parseLrc` 的签名扩展（`src/utils/lyricTimeline.ts`）

```ts
export function parseLrc(
  text: string,
  detectInstrumental?: boolean,  // 既有
  attachRoughUnits?: boolean,    // 新增，默认 true（保持既有行为）
): LyricLine[];
```

- 解析 `<mm:ss.xx>` 词级标记，套到对应行的 `units`（**覆盖**粗排）；
  仅当「词元拼接 == 清洗后的行文本」时套用，避免尾部括号译文被剥离导致逐字宽度错位；
  词级时间戳非单调（脏数据）时整行放弃，退回粗排。
- `attachRoughUnits=false` 时**不**给没有官方词级时间轴的行附粗排 units。

> ⚠️ **这个参数是必须的，不是可选的洁癖**：粗排 units 是渲染用的近似，每行都有。
> 写标签时若用 `units.length > 1` 判断「有没有逐字」，逐行 LRC 会被误判成逐字，
> 把伪时间轴以增强型 LRC 固化进用户文件、别的播放器按错误时间轴点亮。
> 因此**所有「取词 → 写标签」链路都必须剥掉粗排 units**：
> - `src/utils/musicTagWordLyrics.ts` 的 NetEase 逐行兜底：`parseLrc(lrc, true, false)`；
> - QQ / 酷狗 / AMLL 的逐字性由来源显式回报（`qqFetchLyricsDetailed` 等），
>   `toTagLyricsText(lines, wordLevel)` 在 `wordLevel=false` 时统一 `stripWordUnits()`；
> - `qqMusic.parseTrack` 的 LRC 兜底轨**保留**粗排 units（渲染逐字填充要用），
>   但如实回报 `wordLevel: false`——判定不再看 units。

> ⚠️ `attachRoughUnits=false` 的剥离判据必须是「**真的套用成功**的行时间戳集合」
> （`officialKeys`），不能是「这一行写过词级标记」：词级标记存在、但被下面的
> 文本一致性检查拒绝时，该行 units 仍是**粗排**，用后者判断会把它漏出去。

## 17. 逐字取词：`src/utils/musicTagWordLyrics.ts`

两条入口，各源能力**如实降级**：

```ts
/** 按对话框选中的候选取词 */
export function fetchWordLyricsForCandidate(
  result: MusicTagSearchResult,
): Promise<{ lines: LyricLine[]; source: LyricSource | "netease-ylrc"; wordLevel: boolean } | null>;

/** 按歌名+时长走「更精确的逐字歌词」回退链（AMLL → QQ → 酷狗 → Meting） */
export function fetchWordLyricsByMeta(
  meta: { title: string; artist?: string; durationMs?: number },
): Promise<{ hit: { lines: LyricLine[]; source: LyricSource | "netease-ylrc"; songTitle: string }; wordLevel: boolean } | null>;

/** 网易云 yrc 逐字轨解析（绝对毫秒，区别于 KRC 的相对行首） */
export function parseNeteaseYrc(text: string): LyricLine[];

/** 取到的歌词 → 写进标签文件的文本（走增强型 LRC） */
export function toTagLyricsText(lines: LyricLine[], wordLevel: boolean): string;
```

> ⚠️ **`wordLevel` 是调用方对「这份歌词是否官方逐字」的显式担保，不能从 units 反推。**
> `parseLrc` 给每行附的**粗排** units 同样满足「≥2 个词元」，反推会把伪时间轴写成
> 增强型 LRC 固化进用户文件。这个坑在开发中真实出现过：`preciseLyrics` 的 **Meting 分支**
> 返回的是**逐行**结果（`wordLevel: false`），但行上带着粗排 units，于是逐行歌词被
> 序列化成了增强型 LRC。
>
> 因此 `toTagLyricsText(lines, false)` 会先经 `stripWordUnits()` 剥掉 units 再序列化。
> **任何新的取词入口都必须显式传这个布尔值**，不要新增「只看 units」的序列化调用。

**任何失败返回 `null` 而不抛**：拿不到逐字时由调用方退回逐行，绝不卡住对话框。

### 各源逐字能力（实测）

| 源 | 接口 | 逐字？ |
|---|---|---|
| QQ | `qqFetchLyrics`（QRC，`GetPlayLyricInfo`） | ✅ 有 QRC 就有 |
| 酷狗 | `kgFetchLyrics`（KRC，需 FileHash） | ✅ 有 KRC 就有 |
| 网易云 | `/api/song/lyric/v1?...&yv=0` → `yrc` | ✅ 视歌曲而定（实测《富士山下》有 13KB yrc，《夜曲》无） |
| 咪咕 | 搜索结果的 `lyricUrl` | ❌ 只有逐行 |
| 酷我 | `songinfoandlrc` | ❌ 只有逐行 |
| AMLL TTML DB | 同播放链路 | ✅ 人工打轴 |

网易云 yrc 格式（与 KRC 的时间语义**不同**）：

```
[40450,4620](40450,280,0)原(40730,260,0)谅...
```

行首 `[行起点ms,行时长ms]`；每段 `(词起点ms,词时长ms,保留)` + 词文本。
**词时间是绝对毫秒**（KRC 是相对行首）——搞错会让整行逐字错到行首位置。

## 18. UI 改动

| 位置 | 改动 |
|---|---|
| 候选行 | 新增「逐字」按钮（`award_star`）：按该候选取 QRC/KRC/yrc；无富歌词则退它的逐行接口 |
| 搜索行末尾 | 新增「逐字歌词」按钮：不挑候选，按歌名+时长走 AMLL → QQ → 酷狗 回退链 |
| 歌词字段标签 | 真逐字显示「逐字」徽标（tertiary 色），逐行仍显示 `LRC`，用户一眼能分辨写进去的是什么 |
| 状态 | `fetchingWordLyrics`（与 `fetchingLyrics` 分开，各自转圈）、`lyricsWordLevel` |

### i18n 新增键（zh / en 各一份，键集必须一致）

`musicTag.wordLevelTag` / `musicTag.wordLyrics` / `musicTag.wordLyricsHint` /
`musicTag.wordLyricsEmpty`

## 19. 验收

```bash
cd apps/desktop
npm run typecheck && npx vitest run && npm run lint && npm run format:check
npm run build:renderer && npm run build:main
npm run verify:word-lyrics      # 端到端：纯逻辑 + 真实 taglib 落盘 + 真实网易云 yrc
```

新增测试：
- `src/utils/__tests__/wordLevelLrc.test.ts`：编码 / 时间格式 / 往返 / 脏数据降级；
- `src/utils/__tests__/musicTagWordLyrics.test.ts`：yrc 解析、各源取词与降级、回退链接线、
  **逐行不得写成伪逐字**（Meting 场景回归）；
- `src/components/__tests__/localMusicTagEntry.test.ts`：右键入口回归；
- `scripts/verify-word-lyrics.mjs`（`npm run verify:word-lyrics`）：用 esbuild 把纯逻辑打成
  临时 ESM 真跑一遍，并把逐字歌词经 taglib-wasm **真写进 WAV 再读回**断言词级标记完好；
  另含一次真实网易云 yrc 抓取（实测 59/59 行带词级时间轴）。当前 29/29 断言通过。

## 20. 写盘不变量（改这块前务必先读）

### 20.1 逐字性只能由来源**显式担保**，不能从 `units` 反推

`units.length > 1` 同时命中「官方逐字」与「本应用粗排」，两者语义完全不同。
因此代码里的规则是：

| 生产端 | 如何给出逐字性 |
|---|---|
| 网易云 yrc | `parseNeteaseYrc()` → 有词级行即逐字 |
| 网易云 LRC 兜底 | `parseLrc(lrc, true, false)` + `wordLevel: false` |
| QQ QRC / LRC 兜底 | `qqFetchLyricsDetailed()` → `wordLevel`（QRC=true / LRC=false） |
| 酷狗 KRC | `kgFetchLyrics()` → `hasWordLevel()`（KRC 的 units 是官方数据） |
| AMLL TTML | `wordLevel: true` |
| Meting | `wordLevel: false`（逐行） |

**写盘的唯一入口**是 `toTagLyricsText(lines, wordLevel)`：`wordLevel=false` 时经
`stripWordUnits()` 剥掉 units 再序列化。任何新取词入口都必须显式传这个布尔值。

> 真实缺陷（开发中被独立验证者发现）：`preciseLyrics` 的 **Meting 分支**返回
> `wordLevel:false` 的逐行歌词，但行上带着 `parseLrc` 给的粗排 units，对话框据此
> 写成了增强型 LRC——**伪时间轴被固化进用户文件**。已由 `toTagLyricsText` 的显式
> 参数 + `stripWordUnits()` 堵住，并有单测与 E2E 断言兜底。

### 20.2 序列化侧的保真规则

- **词元拼接必须等于行文本**才写词级标记（`unitsMatchText`）。对不上就按逐行写——
  宁可丢逐字，也不产生「自己写得出去、自己读不回来」的歌词。
- **尾部括号译文启发式有三种豁免**（否则都会**静默改字**）：
  1. 已有 `[tr:]` 标签；
  2. 该行带词级标记——括号是正文（`Hello (Live)` 否则回读成 `Hello` + `Live`；
     实测网易云 yrc 的 `…C.Y.Kong （江志仁）` 中招）；
  3. 同一时间戳**已有行**——这行本身就是独立译文行，
     否则 `中文（正式版）` 会被截成 `中文` + 译文 `正式版`。
- 间奏三点行（`instrumental`）不写进文件：它是渲染态占位。
- 词元里的 `<`/`>`/换行会被剥离，避免破坏标记结构。

### 20.3 时间戳

- 编码精度为**厘秒**（2 位小数）：这是增强型 LRC 的事实标准，第三方识别率最高；
  写 3 位毫秒部分实现会整条忽略词级标记，得不偿失。
- 解码端分钟接受 **2~3 位**（`[100:00.00]` 也能读回）：否则超过 99 分钟的音轨
  会写出自己读不回来的行。
- 词级时间戳非单调（脏数据）时整行退回粗排，宁可不逐字也不错位高亮。
- `parseNeteaseYrc` 的词时间是**绝对毫秒**（KRC 是相对行首），且行文本独立提取，
  坏数据不会吞字；词元对不上时保文本、弃时间轴。

## 21. 已知边界

- 咪咕 / 酷我的公开接口**没有**逐字时间轴：对话框会如实退回逐行 LRC，
  歌词标签只显示 `LRC` 而不是「逐字」——这是能力边界，不是缺陷。
- 网易云 `yrc` 逐字轨**视歌曲而定**（实测《富士山下》有、《夜曲》无）：
  无 yrc 时退回该曲的普通 LRC 并标 `LRC`。
- 增强型 LRC 的词级精度为**厘秒**，逐字时间轴最多有 ±5ms 的舍入误差。
- 逐字歌词写进的是**文件内的 USLT / 内嵌歌词**（纯文本）。写标签不会额外落 `.lrc`
  旁文件；播放时由 `parseLrc` 从标签文本还原词级时间轴。

