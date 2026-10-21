/**
 * `ext:` 协议的路径逃逸防护 —— **纯函数，不 import electron**。
 *
 * ## 为什么单独一个文件
 *
 * 这段是**安全边界**：判断写漏，恶意扩展就能读到扩展目录以外的任意文件，
 * 把 `capabilities/extension.json` 里「只允许读 extensions/**」整个绕开。
 * 所以它必须能被单测直接覆盖（`electron/__tests__/extProtocol.test.ts`）。
 *
 * 而 `protocols.ts` 顶层 `import { net, protocol } from "electron"`，在 vitest 里
 * 会去加载真实 Electron 二进制、import 阶段就挂 —— 与 `cspPolicy.ts` / `csp.ts`
 * 拆开是同一个理由。
 *
 * ## 语义来源
 *
 * 照搬 Tauri 时代的 `src-tauri/src/ext_protocol.rs`（迁回 Electron 时漏搬了，
 * 见 `doc/AGENTS.md` 的 Gotchas 与 `doc/LOG.md` 待办）。
 * 那边的实现踩过一次坑并写在注释里，这里保留同样的取舍：
 * **统一分隔符 → 逐段查 `..` → 大小写无关的前缀比较**，三者在任何平台同义。
 */

/**
 * 前缀比较：统一分隔符 + 忽略大小写。
 *
 * 末尾那个分隔符不能省 —— 没有它，`…/extensions-evil` 会被误判成在
 * `…/extensions` 之内（经典前缀匹配漏洞，有对应用例守着）。
 *
 * 忽略大小写是为了 Windows（同一路径两侧大小写可能不同）。在区分大小写的
 * 文件系统上这偏宽松，但方向是安全的：最坏只是去读一个「仅大小写不同」的
 * 路径，而它并不存在，读失败即 404，不构成逃逸。
 */
export function startsWithCi(root: string, candidate: string): boolean {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const p = candidate.replace(/\\/g, "/").toLowerCase();
  if (!r) return false;
  return p === r || p.startsWith(`${r}/`);
}

/**
 * 判断一个**已解码**的请求路径是否可以服务；可以则返回要读取的路径。
 *
 * ## 为什么全程走字符串、不走 `path.resolve`
 *
 * `path.resolve` 会把 `..` 规范化掉，于是「有 `..` 但最终仍落在根内」的路径
 * 会被放行。这里刻意**更严**：只要出现 `..` 段就拒绝。扩展 UI 是构建产物，
 * 正常路径里本来就不该出现 `..`。
 *
 * 同时也不用 `realpath` 解符号链接：路径可能尚不存在，且它在各平台行为有差异。
 * 代价是「扩展目录内放软链指向外部」这种情形挡不住 —— 但那是扩展作者主动
 * 装进自己目录的内容，威胁模型不同层级，不在本函数职责内。
 *
 * @param root    扩展根目录（`<app_data_dir>/extensions`）
 * @param decoded 已做百分号解码的请求路径（`new URL(...).pathname` 去掉前导斜杠后的形态）
 * @returns 可服务时返回原路径，否则 `null`
 */
export function extIsServable(root: string, decoded: string): string | null {
  const trimmed = decoded.replace(/^\/+/, "");
  if (!trimmed) return null;

  // 反斜杠也视作分隔符：URL 里是 '/'，但 Windows 上可能被写成 '\'
  const unified = trimmed.replace(/\\/g, "/");
  if (unified.split("/").some((seg) => seg === "..")) return null;
  if (!startsWithCi(root, trimmed)) return null;

  return trimmed;
}
