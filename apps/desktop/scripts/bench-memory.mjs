#!/usr/bin/env node
/**
 * bench:memory —— 内存基准报告的读取与前后对比。
 *
 * ## 用法
 *
 * ```
 * node scripts/bench-memory.mjs                 # 读默认目录里最新的一份报告
 * node scripts/bench-memory.mjs <report.json>   # 读指定报告
 * node scripts/bench-memory.mjs <旧.json> <新.json>   # 两份对比
 * ```
 *
 * 报告由应用内「设置 → 关于与更新 → 内存基准测试」导出，
 * 落在 `<数据目录>/bench/bench-<时间戳>.json`（Windows 的默认位置见 `defaultBenchDir()`）。
 *
 * ## 为什么单独一个脚本
 *
 * 内存优化的结论必须**可比**：同一个人、同一台机器、同一套五组口径。
 * 应用内表格只展示当次；要做「这次改动到底省了多少」，就得把两份 JSON 摆在一起看
 * 各进程的差值。脚本不做任何猜测——只读报告里的数字。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 应用根目录（apps/desktop）。 */
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 数据目录的标识符取自单一真源，避免与运行时不一致。 */
function identifier() {
  try {
    return JSON.parse(readFileSync(path.join(appRoot, "src-tauri/silvermoon.config.json"), "utf8"))
      .identifier;
  } catch {
    return "SilverMoon";
  }
}

/** 默认报告目录：与 Electron 主进程的 `dataDir()` 口径一致（Windows 为 %APPDATA%）。 */
function defaultBenchDir() {
  const appData =
    process.env.APPDATA ??
    (process.platform === "darwin"
      ? path.join(process.env.HOME ?? "", "Library", "Application Support")
      : path.join(process.env.HOME ?? "", ".config"));
  return path.join(appData, identifier(), "bench");
}

/** 目录里最新的报告文件（按文件名排序，时间戳前缀天然有序）。 */
function newestReport(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("bench-") && f.endsWith(".json"))
    .sort();
  if (files.length === 0) return null;
  return path.join(dir, files[files.length - 1]);
}

function loadReport(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object" || !raw.summary) {
    throw new Error(`${file} 不是一份内存基准报告（缺少 summary）`);
  }
  if (raw.version !== 1) {
    console.warn(`警告：报告版本为 ${raw.version}，本脚本按 v1 解析，字段可能有出入。`);
  }
  return raw;
}

/** 定宽表格行（中文按 2 列宽计，避免错位）。 */
function width(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\uFFDC]/.test(ch) ? 2 : 1;
  return w;
}
function pad(s, n) {
  const w = width(s);
  return String(s) + " ".repeat(Math.max(0, n - w));
}
function row(cells, widths) {
  return cells.map((c, i) => pad(c, widths[i])).join("  ");
}

/** 打印单份报告。 */
function printReport(r) {
  const s = r.summary;
  console.log(`报告：${r.startedAt} → ${r.endedAt}`);
  console.log(
    `采样：${s.sampleCount} 条 / 间隔 ${r.intervalMs}ms / 时长 ${(s.durationMs / 1000).toFixed(1)}s`,
  );
  console.log("");
  console.log(`冷启动基线：${s.baselineMB} MB`);
  console.log(`会话峰值  ：${s.maxMB} MB（+${s.deltaMaxMB}，@ ${(s.maxAtMs / 1000).toFixed(1)}s）`);
  console.log(`会话末值  ：${s.finalMB} MB（+${s.deltaFinalMB}）`);
  console.log(`会话最低  ：${s.minMB} MB（@ ${(s.minAtMs / 1000).toFixed(1)}s）`);

  if (s.markSummary?.length) {
    console.log("\n五组口径（相对基线）：");
    const widths = [16, 10, 12, 12];
    console.log(row(["步骤", "时刻", "工作集", "Δ 基线"], widths));
    console.log("-".repeat(widths.reduce((a, b) => a + b + 2, -2)));
    for (const m of s.markSummary) {
      console.log(
        row(
          [
            m.label,
            `${(m.t / 1000).toFixed(1)}s`,
            `${m.totalMB} MB`,
            `${m.deltaMB >= 0 ? "+" : ""}${m.deltaMB} MB`,
          ],
          widths,
        ),
      );
    }
  }

  if (s.processPeaks?.length) {
    console.log("\n各进程峰值（本会话采样到的最大工作集）：");
    const widths = [10, 22, 14, 14];
    console.log(row(["类型", "进程 / 窗口", "最大工作集", "进程自报峰值"], widths));
    console.log("-".repeat(widths.reduce((a, b) => a + b + 2, -2)));
    for (const p of s.processPeaks.slice(0, 12)) {
      console.log(
        row(
          [p.type, p.name || "(匿名)", `${p.maxWorkingSetMB} MB`, `${p.peakWorkingSetMB} MB`],
          widths,
        ),
      );
    }
  }
}

/** 打印两份报告的差值。 */
function printDiff(oldR, newR) {
  const a = oldR.summary;
  const b = newR.summary;
  const d = (x, y) => {
    const v = Math.round((y - x) * 10) / 10;
    return `${v >= 0 ? "+" : ""}${v}`;
  };
  console.log(`旧：${oldR.startedAt}`);
  console.log(`新：${newR.startedAt}`);
  console.log("");
  const widths = [18, 14, 14, 12];
  console.log(row(["指标", "旧", "新", "差值"], widths));
  console.log("-".repeat(widths.reduce((x, y) => x + y + 2, -2)));
  console.log(
    row(
      ["冷启动基线", `${a.baselineMB} MB`, `${b.baselineMB} MB`, d(a.baselineMB, b.baselineMB)],
      widths,
    ),
  );
  console.log(row(["会话峰值", `${a.maxMB} MB`, `${b.maxMB} MB`, d(a.maxMB, b.maxMB)], widths));
  console.log(
    row(
      ["峰值增量", `${a.deltaMaxMB} MB`, `${b.deltaMaxMB} MB`, d(a.deltaMaxMB, b.deltaMaxMB)],
      widths,
    ),
  );
  console.log(
    row(["会话末值", `${a.finalMB} MB`, `${b.finalMB} MB`, d(a.finalMB, b.finalMB)], widths),
  );

  // 按标记标签对齐两组口径
  const labels = new Set([
    ...(a.markSummary ?? []).map((m) => m.label),
    ...(b.markSummary ?? []).map((m) => m.label),
  ]);
  if (labels.size) {
    console.log("\n各口径 Δ 基线对比：");
    const w2 = [16, 14, 14, 12];
    console.log(row(["步骤", "旧 Δ", "新 Δ", "差值"], w2));
    console.log("-".repeat(w2.reduce((x, y) => x + y + 2, -2)));
    for (const label of labels) {
      const ma = (a.markSummary ?? []).find((m) => m.label === label);
      const mb = (b.markSummary ?? []).find((m) => m.label === label);
      const va = ma ? ma.deltaMB : null;
      const vb = mb ? mb.deltaMB : null;
      console.log(
        row(
          [
            label,
            va === null ? "—" : `${va >= 0 ? "+" : ""}${va} MB`,
            vb === null ? "—" : `${vb >= 0 ? "+" : ""}${vb} MB`,
            va === null || vb === null ? "—" : d(va, vb),
          ],
          w2,
        ),
      );
    }
  }
}

// ------------------------------------------------------------------ 入口

const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  console.log("用法：node scripts/bench-memory.mjs [报告.json] [新报告.json]");
  process.exit(0);
}

try {
  if (args.length >= 2) {
    printDiff(loadReport(args[0]), loadReport(args[1]));
  } else {
    let file = args[0];
    if (!file) {
      const dir = defaultBenchDir();
      if (!statSync(dir, { throwIfNoEntry: false })) {
        console.error(`没有找到报告目录：${dir}`);
        console.error("先在应用里跑一次「设置 → 关于与更新 → 内存基准测试 → 导出报告」。");
        process.exit(1);
      }
      file = newestReport(dir);
      if (!file) {
        console.error(`报告目录为空：${dir}`);
        process.exit(1);
      }
      console.log(`（读取最新报告：${path.basename(file)}）\n`);
    }
    printReport(loadReport(file));
  }
} catch (error) {
  console.error(`读取失败：${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
