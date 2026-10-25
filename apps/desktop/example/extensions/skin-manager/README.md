# skin-manager —— 皮肤扩展示例

演示**新的皮肤分发模型**：设置页不再管理皮肤，**皮肤随扩展分发、由扩展 UI 切换**。
这个扩展把两套皮肤装进自己的包里，并提供一个管理界面。

> 皮肤文件格式本身没有变，仍然以 `doc/archive/皮肤开发指南.md` 为准。
> 本文只讲「扩展怎么封装皮肤」。

## 结构

```
skin-manager/
├── manifest.json                     ← contributes.themes 声明两套皮肤
├── themes/
│   ├── aurora/skin.json              ← v1 纯令牌皮肤（无外部资源）
│   └── sakura/                       ← v2 资产皮肤
│       ├── skin.json
│       └── assets/
│           ├── bg.png                ← background.light/dark.image 引用
│           └── icons/
│               ├── home.svg          ← 文件名 = Material Symbols 图标名
│               └── settings.svg
└── web/dist/index.html               ← 管理界面（纯静态单文件）
```

**没有 `engine/`** —— `themes:*` 是宿主保留方法，不转发引擎，所以本扩展不需要引擎进程。

## 怎么跑

1. 设置 → **扩展** → 「从文件夹安装」→ 选中本目录；
2. `Ctrl+Alt+S` 或托盘「皮肤管理」打开界面；
3. 点任意主题的「应用」→ 主界面外观立即变化；点「恢复默认外观」还原。

## 关键点：三样东西、三个基准

这是写皮肤扩展最容易错的地方。

**桥方法**（扩展 UI 调用）：

| 方法 | payload | 返回 |
|------|---------|------|
| `themes:list` | `{}` | `[{ extId, id, name, path }]` |
| `themes:apply` | `{ extId, themeId }` | `{ ok: true }` |
| `themes:clear` | `{ extId? }` | `{ ok: true }` |

> **`themes:list` 是全量的**：它返回**所有已启用扩展**声明的主题，每项带 `extId`，
> 不按调用方过滤 —— 这是有意设计，这样「皮肤市场」类扩展才能一次列出机器上全部可用皮肤。
> 要只看自己的，得按 `extId` 自己筛。本示例就是这么做的：卡片只渲染属于自己的，
> 同时在工具栏下方用一行小字报告「共返回 N 套，其中别的扩展 M 套」。

**宿主内部**走 Tauri 命令 `ext_theme_load(extId, themeId)`，返回：

```jsonc
{
  "json":   "{ \"formatVersion\": 2, ... }",  // skin.json 原文
  "dir":    "themes/sakura",                 // ← 相对【扩展根目录】
  "absDir": "C:\\...\\extensions\\skin-manager\\themes\\sakura",
  "files":  [                                // ← 相对【主题目录本身】，与 skin_load 同口径
    "skin.json",
    "assets/bg.png",
    "assets/icons/home.svg",
    "assets/icons/settings.svg"
  ]
}
```

| 字段 | 基准 | 例 |
|------|------|-----|
| `dir` | **扩展根目录** | `themes/sakura` |
| `absDir` | 绝对路径 | `C:\...\themes\sakura` |
| `files` | **主题目录本身** | `assets/bg.png` |
| skin.json 内部的 `image` / `icons.svg.dir` | **主题目录本身**（与 `files` 同基准） | `assets/bg.png` |

> **`files` 和 skin.json 内部的引用是同一个基准（主题目录），所以 `files` 可以直接喂给校验器：**
>
> ```ts
> const { json, dir, files } = await invoke("ext_theme_load", { extId, themeId });
> const v = validateSkin(json, { files });   // ✅ 直接可用，无需裁剪前缀
> // 绝对路径 = <appData>/extensions/<extId>/ + dir + / + 引用
> ```

宿主拿到 `dir` 拼 base，再把 skin.json 里的相对引用接上去，得到
`.../extensions/skin-manager/themes/sakura/assets/bg.png`，图片经 `ext:` 协议取
（独立 origin，不再用 `asset:`）。

## 两套皮肤演示了什么

| 主题 | 格式 | 演示 |
|------|------|------|
| `aurora` 极光 | v1 | 纯结构化令牌 + 一小段 CSS；不引用任何外部资源 |
| `sakura` 樱 | **v2** | 背景图（浅/深双遮罩）+ SVG 图标包（`home` / `settings`）+ 布局令牌（`--lm-nav-width`） |

`sakura` 存在的意义是证明：**扩展目录里的相对路径资源是能用的** —— 这对背景图/字体类
皮肤很关键，也是「皮肤随扩展分发」相对旧模型的主要收益。
（背景图是一张脚本生成的真实 64×64 PNG，不是占位空文件 —— 导入后能直接看到效果。）

## 自己改的时候注意

- `themes[].id` 是**扩展命名空间内**的 id，宿主以 `(扩展 id, 主题 id)` 二元组寻址，
  与 `skins/` 库里同名皮肤不冲突；持久化键为 `ext:<extId>:<themeId>`。
- 图标文件名必须是 Material Symbols 图标名（`home.svg`、`music_note.svg`…），
  且只允许小写字母/数字/下划线；颜色会自动跟随界面文字色，SVG 里填什么都行。
- v2 皮肤要求资源真实存在：`background.light.image` 引用的文件不在 `files` 里会直接被拒。
- 皮肤校验在宿主侧，用的还是那套 `src/utils/skinSchema.ts`：令牌不在白名单、值越界、
  资源引用不存在都会**拒绝应用**并在 UI 里回错误文本。
- 皮肤把界面改坏时，用 `--safe-mode` 启动应用可以回到默认外观。

完整字段说明见 `doc/扩展开发指南.md` 第八章。
