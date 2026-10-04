#!/usr/bin/env node
/**
 * 校验启动器 exe 的资源与体积（纯 Node 解析 PE 头，不依赖 objdump/dumpbin）。
 *
 * 为什么自己解析 PE 而不调外部工具：
 * - objdump 只在 Linux 有；dumpbin 在 GitHub 的 pwsh 里也不保证在 PATH 上；
 * - 而「exe 里有没有 .rsrc 节」正是判断图标是否嵌进去的可靠依据。
 * 解析 PE 节表只需读固定偏移，几十行代码，跨平台行为一致。
 *
 * 起因是一次真实的静默失败：图标嵌入失败时 build.rs 只打 cargo:warning，
 * 构建照常成功 → CI 全绿，但发布版快捷方式是空白图标，直到用户装上才发现。
 * 所以这里必须抛错退出，而不是打印警告。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");

/** 各 profile / 工具链的候选路径（CI 用 release+msvc，本机常用 gnu）。 */
const CANDIDATES = [
  "splash/target/release/silvermoon-splash.exe",
  "splash/target/x86_64-pc-windows-gnu/release/silvermoon-splash.exe",
  "splash/target/x86_64-pc-windows-msvc/release/silvermoon-splash.exe",
];

const exePath = CANDIDATES.map((p) => path.join(appRoot, p)).find((p) => existsSync(p));
if (!exePath) {
  console.error("✗ 找不到启动器产物，已尝试：");
  for (const c of CANDIDATES) console.error("  " + c);
  process.exit(1);
}

/**
 * 读取 PE 文件的节名列表。
 *
 * 布局（全部小端）：
 *   0x3C  e_lfanew（DWORD）→ PE 头偏移
 *   PE 头 +0x04 = COFF 头 → +0x02 NumberOfSections（WORD），+0x10 SizeOfOptionalHeader
 *   节表紧随可选头之后，每项 40 字节，首 8 字节是节名。
 */
function peSections(buf) {
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
    throw new Error("不是有效的 PE 文件（缺少 MZ 头）");
  }
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.readUInt32LE(peOff) !== 0x00004550) {
    throw new Error("PE 签名无效 @0x" + peOff.toString(16));
  }
  const coff = peOff + 4;
  const numSections = buf.readUInt16LE(coff + 2);
  const optSize = buf.readUInt16LE(coff + 16);
  const tableOff = coff + 20 + optSize;
  if (numSections === 0 || numSections > 96) {
    throw new Error("节数量异常：" + numSections);
  }
  const names = [];
  for (let i = 0; i < numSections; i++) {
    const off = tableOff + i * 40;
    if (off + 8 > buf.length) throw new Error("节表越界");
    names.push(buf.toString("ascii", off, off + 8).replace(/\0+$/, ""));
  }
  return names;
}

let buf;
try {
  buf = readFileSync(exePath);
} catch (e) {
  console.error("✗ 读取失败：" + e.message);
  process.exit(1);
}

let sections;
try {
  sections = peSections(buf);
} catch (e) {
  console.error("✗ 解析 PE 失败：" + e.message);
  process.exit(1);
}

const sizeKb = statSync(exePath).size / 1024;
console.log("启动器：" + path.relative(appRoot, exePath));
console.log("  体积：" + sizeKb.toFixed(1) + " KB");
console.log("  节：" + sections.join(", "));

let failed = false;

// 1) 图标资源：.rsrc 节是图标/版本信息落地的标志
if (!sections.includes(".rsrc")) {
  console.error("✗ 缺少 .rsrc 节 —— 图标未嵌入，桌面快捷方式会是空白方块。");
  console.error("  检查 splash/build.rs 的资源编译是否成功（构建日志搜 cargo:warning）。");
  failed = true;
} else {
  console.log("  ✓ 含 .rsrc 节（图标资源已嵌入）");
}

// 2) 体积下限：嵌入 7 种尺寸图标约 +140KB；太小说明其实没嵌进去
if (sizeKb < 380) {
  console.error("✗ 体积偏小（" + sizeKb.toFixed(1) + " KB < 380 KB），疑似未嵌入图标");
  failed = true;
}

// 3) 体积上限：防止哪天被误配成臃肿产物（C# 自包含曾达 153MB）
if (sizeKb > 5 * 1024) {
  console.error("✗ 体积异常（" + (sizeKb / 1024).toFixed(1) + " MB），预期小于 0.5MB");
  failed = true;
}

if (failed) process.exit(1);
console.log("✓ 启动器资源校验通过");
