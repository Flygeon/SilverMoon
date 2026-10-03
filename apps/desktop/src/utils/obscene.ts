/**
 * 不雅用语遮蔽（AMLL TTML 的 `amll:obscene`）。
 *
 * 与 AMLL 一致挂在**词级**，且在渲染前统一处理（见 maskObsceneUnits 的说明）。
 */
import type { LyricLine } from "@shared/types";

/** 遮蔽模式：关闭 / 全遮蔽 / 保留首尾字符 */
export type ObsceneMode = "off" | "full" | "partial";

/**
 * 遮蔽单个词文本。
 *
 * 与 AMLL（packages/core/src/lyric-player/base/lyric-data-manager.ts:144-157）一致：
 * - `full`：每个**非空白**字符替换为遮蔽字符，空白保留（英文词间空格不能被吃掉）；
 * - `partial`：保留 trim 后的首尾字符，只替换中间；trim 后长度 ≤ 2 时退化为全遮蔽；
 * - 遮蔽字符默认 `*`。
 */
export function maskWordText(text: string, mode: ObsceneMode, maskChar = "*"): string {
  if (mode === "off") return text;
  if (mode === "full") return text.replace(/\S/g, maskChar);

  const trimmed = text.trim();
  if (trimmed.length <= 2) return text.replace(/\S/g, maskChar);
  // 用 indexOf 定位 trim 后的区间，保留首尾字符与两端的空白
  const startPos = text.indexOf(trimmed);
  const endPos = startPos + trimmed.length - 1;
  return (
    text.slice(0, startPos + 1) +
    text.slice(startPos + 1, endPos).replace(/\S/g, maskChar) +
    text.slice(endPos)
  );
}

/**
 * 对歌词序列做遮蔽（**返回新数组，不改动入参**）。
 *
 * 之所以放在渲染前而不是渲染时：遮蔽会改变字形宽度，若在渲染时才换字，
 * 逐字填充的行程会与实测宽度错位；而且被遮蔽的音节不该再套用原字形的强调效果。
 *
 * 同时保持 `line.text` 与 `line.units[].text` 一致——两者不一致时渲染层会
 * 在「整行纯文本」与「逐字 span」两条路径间出现不同文本。
 */
export function maskObsceneUnits(
  lines: LyricLine[],
  mode: ObsceneMode,
  maskChar = "*",
): LyricLine[] {
  if (mode === "off") return lines;
  return lines.map((line) => {
    const hasObscene =
      line.units?.some((u) => u.obscene) ||
      // 行文本可能是由带标记的 units 拼出来的；没有 units 时无从判断，跳过
      false;
    if (!hasObscene) return line;

    const units = line.units!.map((u) =>
      u.obscene ? { ...u, text: maskWordText(u.text, mode, maskChar) } : u,
    );
    // 行文本按遮蔽后的 units 重新拼接（保留 units 自带的词尾空格）
    const text = units
      .map((u) => u.text)
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    return { ...line, text, units };
  });
}
