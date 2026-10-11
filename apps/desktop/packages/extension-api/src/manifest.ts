/**
 * 扩展清单（`manifest.json`）的类型定义 —— 与宿主 Rust `ExtManifest` 逐字段对齐。
 *
 * 契约版本：扩展框架 v2（2026-10-11 冻结）。
 *
 * 两条最容易踩的规则先说在前面：
 *
 * 1. **字段一律 camelCase**。Rust 侧 `#[serde(rename_all = "camelCase")]`，
 *    写 `min_host_version` / `always_on_top` 这类蛇形名不会被识别，只会被静默忽略。
 * 2. **`minHostVersion` 比的是「扩展 API 版本」，不是产品版本号**。
 *    宿主侧常量 `EXT_API_VERSION = 2.0.0`（Rust `commands/extension.rs`），
 *    产品版本（`silvermoon.config.json` 里的 0.1.0）与它无关。
 *    这与 VS Code 的 `engines.vscode` 是同一套思路：宿主契约独立版本化。
 */

/** 宿主当前的扩展 API 版本（Rust `commands/extension.rs::EXT_API_VERSION`）。 */
export const EXT_API_VERSION = "2.0.0";

/**
 * 调用扩展引擎任意方法所需的权限。
 * 引擎调用的**唯一**入口，缺它时 `ext_invoke` 直接拒绝。
 */
export const PERM_INVOKE = "ext:invoke";

/**
 * 由宿主代执行「打开 / 在文件管理器中定位」所需的权限。
 * `open` / `reveal` 不会转发给引擎，一律由宿主执行（见冻结契约「宿主保留方法」）。
 */
export const PERM_OPEN = "opener:open-path";

/**
 * 已知权限词表。
 *
 * 注意：宿主的校验逻辑是「`permissions` 数组里有没有这一项」，
 * 并不会因为出现未知字符串而报错。这里给全量联合类型只是为了编辑器补全与拼写检查；
 * 作者若需要完整 `string[]` 语义，用 {@link ExtensionPermission} 的 `(string & {})` 分支即可。
 */
export type KnownPermission = typeof PERM_INVOKE | typeof PERM_OPEN;

/**
 * 权限标识。
 *
 * - 整个 `permissions` 字段**省略** = legacy 包，宿主放行（UI 会提示用户）；
 * - 一旦声明数组，宿主就**逐项严格校验**，未声明的能力调用会被拒绝。
 *
 * 当前图省事写未知字符串仍能装，但不会带来任何能力（等于白写），且未来收紧后会变成硬错误。
 */
export type ExtensionPermission = KnownPermission | (string & {});

/**
 * 激活事件：决定扩展何时被拉起。
 *
 * - `"onStartup"` —— 宿主启动时就拉起（**省略 `activationEvents` 时的默认行为**，即旧包行为）；
 * - `"onHotkey"`  —— 用户按下扩展声明的全局热键时拉起；
 * - `"onTray"`    —— 用户点击扩展声明的托盘项时拉起；
 * - `"onInvoke"`  —— 宿主/前端首次调用该扩展的引擎方法时拉起（懒加载）。
 *
 * 声明多个即为「任一命中」。
 */
export type ActivationEvent = "onStartup" | "onHotkey" | "onTray" | "onInvoke";

/** 扩展引擎声明（Rust `ExtEngine`）：一个由宿主拉起的本地进程，经 localhost HTTP 提供服务。 */
export interface ExtEngine {
  /**
   * 引擎可执行文件，**相对扩展根目录**。
   * 以 `.py` 结尾时宿主会用系统 Python（python / python3 / py）拉起（源码模式）；
   * Windows 上非 `.py` 且未写扩展名时宿主会自动补 `.exe`。
   */
  cmd: string;
  /**
   * 传给引擎的命令行参数。
   * Rust 侧默认空数组，因此**可省略**（省略等价于 `[]`）。
   */
  args?: string[];
  /**
   * 宿主会注入的环境变量名，其值恒为扩展私有数据目录 `<扩展目录>/data`（目录会被自动创建）。
   * 引擎把索引、缓存等写到这个变量指向的路径里，卸载时随扩展目录一起清掉。
   */
  supportEnv?: string;
  /**
   * 引擎就绪行模式，缺省 `"READY <port>"`。
   *
   * 宿主**逐行扫描** stdout（不是只读第一行 —— 引擎完全可以在就绪前先打日志），
   * 把模式与每一行都**按空白切段逐段比对**，`<port>` 段解析为端口号；
   * 命中即握手成功，20 秒超时。
   *
   * 因此可以自定义，例如 `"listening on <port>"`。注意：
   * - 段数必须与引擎实际打印的行**完全一致**（多一段/少一段都不匹配）；
   * - `<port>` 之外的字面量要**逐字相同**（区分大小写）；
   * - 一行里出现多个 `<port>` 时以最后一段为准（正常写法只有一个）。
   */
  readyLine?: string;
}

/** 扩展自带 web UI 的声明（Rust `ExtWeb`）。 */
export interface ExtWeb {
  /**
   * 相对扩展目录的前端产物目录，缺省 `"web/dist"`（宿主与 SDK 的 Vite 插件用同一默认值）。
   * 宿主加载的是其中的 `index.html`；`web.dist` 允许写多级路径（如 `"ui/out"`）。
   */
  dist?: string;
  /**
   * 未显式指定路由时的默认路由，即打开窗口时 iframe 的 `?route=` 取值。
   * 建议与 {@link ExtWindowContrib.route} 里的某一条对齐。
   */
  defaultRoute?: string;
}

/** 窗口贡献点（Rust `ExtWindowContrib`）。 */
export interface ExtWindowContrib {
  /**
   * 该窗口的路由名。宿主把它作为 `?route=` 传给扩展 UI；
   * 扩展自己怎么解释这个字符串由扩展决定（宿主不做路由表校验）。
   */
  route: string;
  /** 窗口标题；宿主最终显示为 `<产品名> · <title>`。 */
  title: string;
  /** 窗口初始宽度（逻辑像素），缺省 760。 */
  width?: number;
  /** 窗口初始高度（逻辑像素），缺省 520。 */
  height?: number;
  /**
   * 是否置顶。
   *
   * ⚠️ 宿主窗口是**单一共享窗口**（label `"extension"`），同一时刻只存在一个。
   * 窗口已存在时：`width`/`height`/`alwaysOnTop`/标题会在每次导航时被重新套用，
   * 但 `decorations` 只能在**创建那一刻**决定，之后切换扩展不会生效。
   */
  alwaysOnTop: boolean;
  /** 是否显示系统标题栏（`false` = 无边框，由扩展自绘）。只在窗口首次创建时生效，见上。 */
  decorations: boolean;
}

/**
 * 全局热键贡献点（Rust `ExtHotkey`）。
 * 热键由宿主代注册（扩展不直接持全局热键权限），仅在扩展已启用时注册。
 */
export interface ExtHotkey {
  /**
   * 快捷键串，语法同 tauri `global-shortcut`，例如 `"Ctrl+Alt+Space"`。
   * 解析失败时宿主只打日志并跳过，不会让扩展安装失败。
   */
  accelerator: string;
  /** 触发时打开（或切换）的路由。 */
  route: string;
  /**
   * 触发行为。Rust 侧缺省值是 `"toggle"`（省略即切换：窗口可见则关闭，否则打开）。
   *
   * ⚠️ 当前宿主只实现了 `"toggle"` 这一种：热键分支无条件调用
   * `toggle_extension_window`，`action` 的其他取值不会改变行为。
   * 因此这里收窄成字面量，避免作者写出「以为能 invoke」的清单。
   */
  action?: "toggle";
}

/** 托盘贡献点（Rust `ExtTrayItem`）。 */
export interface ExtTrayItem {
  /** 托盘项 id，在**同一个扩展内**唯一即可。宿主内部键为 `ext:<扩展 id>:<id>`。 */
  id: string;
  /** 托盘菜单里显示的文字。 */
  title: string;
  /**
   * 点击行为，两种前缀：
   * - `"open:<route>"`   —— 打开扩展窗口并导航到该路由；
   * - `"invoke:<method>"` —— 调用扩展引擎的方法，payload 为 `null`。
   *
   * 宿主用字符串前缀解析，写成其他形式会静默无反应。
   */
  action: `open:${string}` | `invoke:${string}`;
}

/**
 * 皮肤贡献点（Rust `ExtTheme`；`ext_themes()` 会补上 `extId` / `dir` / `absDir`，见 {@link ExtThemeEntry}）。
 *
 * 「装皮肤 = 装扩展」：宿主设置页不再有独立的皮肤入口，
 * 皮肤随扩展分发，由 `ext_themes` / `ext_theme_load` 两个命令读取。
 */
export interface ExtThemeContrib {
  /** 皮肤 id，在**同一个扩展内**唯一即可（宿主跨扩展时以 `extId` 区分）。 */
  id: string;
  /** 皮肤显示名。 */
  name: string;
  /**
   * 扩展目录内 `skin.json` 的**相对路径**（POSIX 分隔符），例如 `"themes/sakura/skin.json"`。
   *
   * 宿主按这个路径读文件；`skin.json` 的字段结构由 `src/utils/skinSchema.ts` 校验，
   * 与「皮肤包」时代完全一致 —— 扩展只是换了一种分发方式。
   *
   * ⚠️ 宿主会做防穿越校验：**绝对路径或含 `..` 的路径会被拒绝**。
   */
  path: string;
}

/** 扩展设置项类型。 */
export type SettingFieldType = "bool" | "text" | "number" | "paths" | "enum";

/** 一条设置项声明（`contributes.settings.schema[]`）。 */
export interface SettingField {
  /** 设置项键名，在扩展内唯一。桥客户端 `settings.get()` 返回的对象以它为键。 */
  key: string;
  /** 控件类型，决定宿主用什么 UI 渲染。 */
  type: SettingFieldType;
  /** 显示用的标签文字。 */
  label: string;
  /** 默认值；`type` 为 `"number"` 时应当是数字，为 `"paths"` 时通常是字符串数组。 */
  default?: unknown;
  /** 仅在 `type: "enum"` 时有意义：下拉选项的字面量列表。 */
  options?: string[];
}

/** 设置贡献点（Rust `ExtSettings`；`schema` 是扩展自解释的开放 JSON，宿主按项渲染）。 */
export interface ExtSettings {
  schema: SettingField[];
}

/** 贡献点集合（Rust `ExtContributes`）。 */
export interface ExtContributes {
  /** 窗口贡献点。Rust 侧缺省空数组，可省略。 */
  windows?: ExtWindowContrib[];
  /** 全局热键贡献点。Rust 侧缺省空数组，可省略。 */
  hotkeys?: ExtHotkey[];
  /** 托盘贡献点。Rust 侧缺省空数组，可省略。 */
  tray?: ExtTrayItem[];
  /** 设置项 schema；省略则不渲染设置面板。 */
  settings?: ExtSettings;
  /** 皮肤贡献点；省略表示该扩展不带皮肤。 */
  themes?: ExtThemeContrib[];
}

/**
 * 扩展清单（`manifest.json`，对应 Rust `ExtManifest`）。
 *
 * 必填字段只有 {@link id} 与 {@link name}（Rust 侧两者无 `#[serde(default)]`）。
 * 其余字段缺省时行为如下：
 *
 * | 字段 | 省略时的行为 |
 * | --- | --- |
 * | `minHostVersion` | 不校验版本（等价于永远兼容） |
 * | `engines` | 不拉起引擎；`ext:invoke` 会失败 |
 * | `web` | 前端产物目录取默认 `web/dist`，默认路由为空 |
 * | `contributes` | 无任何窗口 / 热键 / 托盘 / 设置 / 皮肤 |
 * | `permissions` | **legacy 放行**：宿主不做权限校验，UI 会提示用户 |
 * | `activationEvents` | 等同 `["onStartup"]`（旧包行为） |
 */
export interface ExtManifest {
  /**
   * 扩展唯一标识。同时用于：
   * 安装目录名（`<appData>/extensions/<id>/`）、桥消息的 `source`（`ext:<id>`）、
   * 皮肤归属（`extId`）。建议小写字母 / 数字 / 连字符。
   *
   * ⚠️ 宿主未校验字符集，但目录名来自它 —— 不要放路径分隔符或 `..`。
   */
  id: string;
  /** 人类可读的扩展名。 */
  name: string;
  /**
   * 扩展版本（建议 SemVer）。
   *
   * 注意：宿主**目前只把它当字符串展示**，不做版本比较、也不参与更新判断；
   * 决定「能不能装」的是 {@link minHostVersion}。
   */
  version?: string;
  /** 作者。纯展示字段。 */
  author?: string;
  /** 许可证标识（如 `"MIT"`）。纯展示字段。 */
  license?: string;
  /**
   * 要求的**扩展 API 版本区间**（semver range，如 `">=2.0.0"`）。
   *
   * 比较对象是 {@link EXT_API_VERSION}（当前 `2.0.0`），**不是产品版本号**。
   * - 省略 / 空串：不校验；
   * - `"*"`：**被明确拒绝**（逼作者给真实区间，照 VS Code 的做法）；
   * - 不满足：安装时当场拒绝（并清理 staging），载入时标记 `incompatible` 并跳过拉起引擎。
   */
  minHostVersion?: string;
  /** 引擎声明；省略表示纯前端扩展。 */
  engines?: ExtEngine;
  /** 前端 UI 声明；省略时按 `web/dist` 默认值加载。 */
  web?: ExtWeb;
  /** 贡献点。 */
  contributes?: ExtContributes;
  /**
   * 权限清单。
   * - **省略整个字段** = legacy 包，宿主放行（UI 提示用户）；
   * - 声明数组后逐项严格校验。
   */
  permissions?: ExtensionPermission[];
  /**
   * 激活事件；**省略 = 等同 `["onStartup"]`**（旧包行为，宿主启动即拉起引擎）。
   *
   * 宿主 `wants_startup()` 的判定：声明了数组就**只认显式的 `onStartup`**（大小写不敏感），
   * 因此 `["onHotkey"]` 这类扩展启动时不会被拉起，改为首次被热键 / 托盘 / 调用触达时懒启动。
   * 写多个即为「任一命中」。
   */
  activationEvents?: ActivationEvent[];
}

/**
 * 扩展作者写 `manifest.json` 时的类型助手：只为拿到编辑器的字段补全与拼写检查，
 * 返回值就是原样传入的对象，不做任何运行时校验。
 *
 * ```ts
 * // manifest.ts（构建期用 vite.config / 脚本生成 manifest.json 时）
 * export default defineManifest({ id: "hello", name: "Hello" });
 * ```
 *
 * 注意：`manifest.json` 本身是 JSON，写死时**不能带类型**，因此最实用的用法是把这份清单
 * 与 {@link ExtManifest} 交叉校验（例如在 CI 里 `const m: ExtManifest = require("./manifest.json")`）。
 */
export function defineManifest(manifest: ExtManifest): ExtManifest {
  return manifest;
}

/**
 * 皮肤文件的列表项形状 —— 对应 Rust `ext_themes()` 的返回值。
 *
 * 扩展作者一般用不到它；这里导出是为了让「宿主侧消费皮肤」的代码有统一类型
 * （前端把它合并进 `src/stores/skins.ts` 时用得到）。
 */
export interface ExtThemeEntry {
  /** 皮肤所属扩展 id。 */
  extId: string;
  /** 皮肤 id（即 {@link ExtThemeContrib.id}）。 */
  id: string;
  /** 皮肤显示名（即 {@link ExtThemeContrib.name}）。 */
  name: string;
  /** `skin.json` 的路径（即 {@link ExtThemeContrib.path}，扩展根目录相对路径）。 */
  path: string;
  /** `skin.json` **所在目录**（扩展根目录相对路径），素材引用以它为基准。 */
  dir: string;
  /** 同一目录的**绝对路径**。由宿主给出，前端不要自行拼接应用数据目录。 */
  absDir: string;
}

/** `ext_theme_load(extId, themeId)` 的返回值，与皮肤包时代的 `skin_load` 同形。 */
export interface ExtThemeLoadResult {
  /** `skin.json` 的原文；读不到时为 `null`。 */
  json: string | null;
  /** `skin.json` 所在目录（扩展根目录相对路径）；读不到时为 `null`。 */
  dir: string | null;
  /** 同一目录的绝对路径，即皮肤引擎的基准目录；读不到时为 `null`。 */
  absDir: string | null;
  /**
   * 主题目录内的文件清单，路径**相对主题目录**（与 `skin_load` 的 `files` 同口径）。
   * 直接喂给前端的 `validateSkin(json, { files })` 即可 —— 该校验器假定基准 =
   * `skin.json` 所在目录。
   */
  files: string[];
}
