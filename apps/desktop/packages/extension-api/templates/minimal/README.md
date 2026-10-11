# 最小扩展模板

一个**纯前端**扩展（没有引擎进程）的最小可跑骨架。复制这个目录，改 `manifest.json` 的
`id` / `name` 就能开工。

```text
minimal/
├── manifest.json     扩展清单（宿主安装时读它）
├── vite.config.ts    接入 @silvermoon/extension-api/vite
├── index.html        扩展 UI 页面
└── src/main.ts       入口：建桥、读路由、调宿主
```

## 跑起来

```bash
npm install        # 装上 @silvermoon/extension-api / vite / typescript
npm run dev        # 浏览器里先调 UI（此时没有宿主，桥会打一条警告，调用一律失败）
npm run build      # 产出到 web/dist
```

然后**把整个目录打包成 zip**，在银月的「扩展」页用「从 zip 安装」装上即可。

## 关键约定（改了就不工作）

| 约定                                                            | 为什么                                                          |
| --------------------------------------------------------------- | --------------------------------------------------------------- |
| 产物目录必须是 `web/dist`（或 manifest 里 `web.dist` 写的那个） | 宿主按 `<扩展目录>/<web.dist>/index.html` 定位 UI               |
| `vite.config.ts` 必须用插件（或手动设 `base: "./"`）            | 扩展 UI 经自定义协议 `ext://` 加载，绝对路径 `/assets/…` 会 404 |
| 清单字段一律 camelCase                                          | Rust 侧 `rename_all = "camelCase"`，蛇形名会被静默忽略          |
| `minHostVersion` 写真实区间，别写 `"*"`                         | `"*"` 会被宿主明确拒绝；它比的是**扩展 API 版本**（当前 2.0.0） |
| 不需要引擎就别写 `engines`                                      | 宿主不会去拉进程，`ext:invoke` 之外的调用直接失败               |

## 下一步

- 需要后端逻辑 → 加 `engines`，引擎在 stdout 打 `READY <port>`；
- 需要设置项 → 加 `contributes.settings.schema`，前端用 `bridge.settings.get()` 读；
- 想分发皮肤 → 加 `contributes.themes`，详见 SDK 的 README。
