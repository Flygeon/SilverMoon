# 示例扩展（Example Extensions）

本目录存放扩展框架的示例，**不随应用构建打包**。想体验请自行安装：

- **从文件夹安装**（开发时最方便）：设置 → 扩展 → 「从文件夹安装」→ 选中某个示例目录；
- **装 zip 包**：先把示例目录**里面的内容**（`manifest.json` 必须在包根）打成 zip，再安装。

装坏界面时用 `--safe-mode` 启动应用即可恢复。

## 清单

| 扩展 | 带引擎 | 演示内容 |
|------|--------|----------|
| [`hello-world/`](./hello-world/) | ✅ Python | **最小可用扩展**：`READY <port>` 握手、按路径分发方法的引擎；前端桥读取/写入设置（`settings:get` / `settings:set`）并调用引擎方法（`greet` / `status` / `remember` / `recall`）；`activationEvents` 懒加载与最小权限 |
| [`skin-manager/`](./skin-manager/) | ❌ | **皮肤扩展**：`contributes.themes` 声明两套自带皮肤（v1 纯令牌 + v2 资产版），UI 调 `themes:list` / `themes:apply` / `themes:clear` 列出、切换、恢复；演示扩展目录内相对路径资源（背景图 + SVG 图标包） |

## 开发扩展

- 字段与协议全量说明：[`doc/扩展开发指南.md`](../../doc/扩展开发指南.md)
- 系统设计与演进：[`doc/扩展系统调研与插件化演进方案.md`](../../doc/扩展系统调研与插件化演进方案.md)
- 皮肤文件格式：[`doc/皮肤开发指南.md`](../../doc/doc/皮肤开发指南.md)

## 打包速览

```bash
# 在扩展目录「内部」打包：manifest.json 必须位于压缩包根目录
cd hello-world
Compress-Archive -Path * -DestinationPath ../hello-world.zip -Force
```

```
hello-world.zip
├── manifest.json        ← 在根，不能套一层目录
├── engine/serve.py
└── web/dist/index.html
```
