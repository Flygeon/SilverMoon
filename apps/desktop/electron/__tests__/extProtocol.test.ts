/**
 * `ext:` 协议的路径逃逸防护。
 *
 * 这段是**安全边界**：判断写漏，恶意扩展就能读到扩展目录以外的任意文件
 * （把 capabilities/extension.json 里「只允许读 extensions/**」整个绕开）。
 * 所以把判定抽成纯函数 `extIsServable`，在这里逐条喂逃逸用例。
 *
 * 用例集合照搬 Tauri 时代 `src-tauri/src/ext_protocol.rs` 的语义，
 * 以及 verify-rust-pure.mjs 里那份（随该文件删除而失效的）断言。
 */
import { describe, it, expect } from "vitest";
// 从 extPathGuard 导入而不是 protocols：后者顶层 `import { protocol } from "electron"`，
// vitest 里会去加载真实 Electron 二进制、import 阶段就挂。与 cspPolicy / csp 拆开同理。
import { extIsServable } from "../extPathGuard";

const ROOT = "C:/Users/x/AppData/Roaming/cn.cool.silvermoon/extensions";
const D = ROOT;

describe("extIsServable：扩展目录边界", () => {
  it("放行扩展目录内的正常产物", () => {
    expect(extIsServable(ROOT, `${D}/miaohui/web/dist/index.html`)).toBe(
      `${D}/miaohui/web/dist/index.html`,
    );
  });

  it("放行大小写不同的同一路径（Windows 路径不区分大小写）", () => {
    expect(extIsServable(ROOT, `${D}/MiaoHui/web/dist/index.html`)).not.toBeNull();
  });

  it("放行反斜杠写法的路径", () => {
    expect(extIsServable(ROOT, `${D}\\miaohui\\web\\dist\\index.html`)).not.toBeNull();
  });

  it("放行根目录本身带尾部斜杠的前缀", () => {
    expect(extIsServable(`${ROOT}/`, `${D}/a/b.js`)).not.toBeNull();
  });
});

describe("extIsServable：拒绝逃逸", () => {
  it("拒绝 .. 逐段逃逸", () => {
    expect(extIsServable(ROOT, `${D}/miaohui/../../../Windows/win.ini`)).toBeNull();
  });

  it("拒绝 .. 之后仍回到根内的路径（严格模式：一律拒绝）", () => {
    // 刻意比 path.resolve 更严：规范化后虽然还在根内，但产物里不该出现 ..
    expect(extIsServable(ROOT, `${D}/miaohui/../miaohui/web/dist/a.js`)).toBeNull();
  });

  it("拒绝根的兄弟目录", () => {
    expect(
      extIsServable(ROOT, "C:/Users/x/AppData/Roaming/cn.cool.silvermoon/skins/x/skin.json"),
    ).toBeNull();
  });

  it("拒绝前缀相同的兄弟目录（extensions-evil）——经典前缀匹配漏洞", () => {
    expect(extIsServable(ROOT, `${D}-evil/x/a.js`)).toBeNull();
  });

  it("拒绝指向系统文件的绝对路径", () => {
    expect(extIsServable(ROOT, "C:/Windows/win.ini")).toBeNull();
  });

  it("拒绝空路径", () => {
    expect(extIsServable(ROOT, "")).toBeNull();
  });

  it("拒绝仅斜杠", () => {
    expect(extIsServable(ROOT, "/")).toBeNull();
  });

  it("拒绝相对路径（非绝对）", () => {
    expect(extIsServable(ROOT, "miaohui/web/dist/a.js")).toBeNull();
  });

  it("拒绝编码解码后的 .. 形态", () => {
    expect(extIsServable(ROOT, `${D}/miaohui/../Windows/win.ini`)).toBeNull();
  });

  it("拒绝反斜杠形式的 ..（Windows 上会被当分隔符）", () => {
    expect(extIsServable(ROOT, `${D}\\miaohui\\..\\..\\Windows\\win.ini`)).toBeNull();
  });
});
