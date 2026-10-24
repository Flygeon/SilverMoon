/**
 * 启动器主题提示（theme-hint.json）的契约测试。
 *
 * ## 它守的是什么回归
 *
 * 提交 `ea37c91`（凭据改用 safeStorage 加密）把 `settings.json` 变成了加密信封
 * `{"__smEnc":"v1","data":"..."}`，但**没有同步更新启动器**：启动器是 Rust + Win32
 * 的原生程序，用明文 JSON 解析 —— 读不到 `settings.theme`，只能回退系统亮色，
 * 于是「不管设置里是深色还是浅色，启动器永远是白底」。
 *
 * 修复方式是让主进程把**最终明暗**写成明文小文件给启动器读。这里锁住那份文件的
 * 内容契约，以及「保存设置时必须同步写出」这个行为。
 *
 * 启动器侧的解析（`splash/src/prefs.rs` 的 `theme_hint_from_json`）与这里**必须
 * 一一对应**：改了一边就要改另一边。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// store.ts 依赖 secure-store（顶层 import electron 的 safeStorage），
// 单测里换成可用的假实现，只为验证「保存 settings 时同步写 hint」这条行为。
vi.mock("../secure-store", () => ({
  writeEncryptedFile: (filePath: string, plain: string) => {
    writeFileSync(filePath, plain, "utf8");
  },
  readEncryptedFile: (filePath: string) => {
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  },
}));

import { initStore, handleStore } from "../store";
import { THEME_HINT_FILE, writeThemeHint } from "../theme-hint";

describe("theme-hint：启动器读取的明暗提示", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sm-theme-"));
    initStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function readHint(): { dark?: unknown } | null {
    const p = path.join(dir, THEME_HINT_FILE);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as { dark?: unknown };
  }

  it("writeThemeHint 写出 { dark: true/false }", () => {
    writeThemeHint(dir, true);
    expect(readHint()).toEqual({ dark: true });
    writeThemeHint(dir, false);
    expect(readHint()).toEqual({ dark: false });
  });

  it("保存 settings（theme=dark）时自动写出 dark:true", async () => {
    await handleStore({
      file: "settings.json",
      op: "set",
      key: "settings",
      value: { theme: "dark" },
    });
    await handleStore({ file: "settings.json", op: "save" });
    expect(readHint()).toEqual({ dark: true });
  });

  it("保存 settings（theme=light）时自动写出 dark:false", async () => {
    await handleStore({
      file: "settings.json",
      op: "set",
      key: "settings",
      value: { theme: "light" },
    });
    await handleStore({ file: "settings.json", op: "save" });
    expect(readHint()).toEqual({ dark: false });
  });

  it("theme=system 时不写提示（交给启动器按系统判断）", async () => {
    await handleStore({
      file: "settings.json",
      op: "set",
      key: "settings",
      value: { theme: "dark" },
    });
    await handleStore({ file: "settings.json", op: "save" });
    expect(readHint()).toEqual({ dark: true });

    // 切成 system：不应覆盖成某个猜测值，也不应删除已有提示（保留上次显式选择更接近实情）
    await handleStore({
      file: "settings.json",
      op: "set",
      key: "settings",
      value: { theme: "system" },
    });
    await handleStore({ file: "settings.json", op: "save" });
    expect(readHint()).toEqual({ dark: true });
  });

  it("其它 store 落盘不会误写 hint", async () => {
    await handleStore({ file: "bangumi.json", op: "set", key: "x", value: { theme: "dark" } });
    await handleStore({ file: "bangumi.json", op: "save" });
    expect(existsSync(path.join(dir, THEME_HINT_FILE))).toBe(false);
  });

  it("设置损坏（settings 不是对象）时不影响保存，也不写 hint", async () => {
    await handleStore({
      file: "settings.json",
      op: "set",
      key: "settings",
      value: "not-an-object",
    });
    await handleStore({ file: "settings.json", op: "save" });
    expect(existsSync(path.join(dir, THEME_HINT_FILE))).toBe(false);
  });
});
