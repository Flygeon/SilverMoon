import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * AutoMix「过渡收尾撞上曲尾」竞态的守卫。
 *
 * ## 这个 bug 长什么样
 *
 * planMix 的 `fadeOutAt = 曲长 − 过渡时长`，过渡**恰好收在曲尾**，所以
 * `ended` 事件必然与进行中的过渡撞上。若 `ended` 处理器照常调 `next()`：
 *
 *   1. next() → playFromQueue → invalidatePrepared
 *   2. invalidatePrepared 把**正在淡入的那个 deck** 清源
 *      （pause + removeAttribute("src") + load()）
 *   3. runMix 随后仍把 audioEl 提升到那个已经没源的 deck
 *   4. 提升时的 playFromQueue(skipStart) 又抑制了起播
 *   → 表现：**进度条跑完切下一首，直接没声音**
 *
 * 这是事件时序问题，无法用单测复现（需要真实 audio 元素 + rAF 交叉淡化），
 * 因此用静态守卫钉住三处不变量。本仓库已有同类先例（chipClick / splashContract /
 * libraryShallowRef）。
 */

const SRC = readFileSync(fileURLToPath(new URL("../player.ts", import.meta.url)), "utf8");

/** 取从某标记开始的片段（用长度限制避免匹配到无关区域）。 */
function from(marker: string, len: number): string {
  const i = SRC.indexOf(marker);
  return i < 0 ? "" : SRC.slice(i, i + len);
}

describe("AutoMix 过渡与曲尾的竞态守卫", () => {
  it("ended 处理器必须先检查 mixing —— 否则会清掉正在淡入的 deck", () => {
    const b = from('el.addEventListener("ended"', 1600);
    expect(b, "没找到 ended 处理器").not.toBe("");
    expect(b, "ended 缺少 mixing 防重入闸").toMatch(/if \(mixing\.value\) return;/);
  });

  it("那道闸必须排在 next() 之前（顺序反了就失效）", () => {
    const b = from('el.addEventListener("ended"', 1600);
    const guard = b.indexOf("if (mixing.value) return;");
    const call = b.indexOf("void next();");
    expect(guard).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(guard, "mixing 检查必须在 next() 之前").toBeLessThan(call);
  });

  it("runMix 在 crossfade 之前检查世代号，避免提升已清源的 deck", () => {
    const b = from("const myGen = ++mixGeneration;", 3000);
    expect(b).not.toBe("");
    const check = b.indexOf("myGen !== mixGeneration");
    const fade = b.indexOf("decks.crossfade(");
    expect(check, "缺少世代号中断检查").toBeGreaterThan(-1);
    expect(fade).toBeGreaterThan(-1);
    expect(check, "中断检查必须在 crossfade 之前").toBeLessThan(fade);
  });

  it("放弃过渡时要把当前 deck 的增益恢复为 1（否则交回去仍是静音）", () => {
    // 锚在「带花括号的中断检查」上——while 循环里那句是 `... break;`，不带花括号
    const b = from("if (myGen !== mixGeneration) {", 400);
    expect(b).not.toBe("");
    expect(b).toMatch(/decks\.setGain\(currentDeck, 1\)/);
    expect(b).toMatch(/decks\.setGain\(to, 0\)/);
  });

  it("invalidatePrepared 会自增世代号（切歌时让进行中的过渡放弃）", () => {
    const b = from("function invalidatePrepared(", 500);
    expect(b).not.toBe("");
    expect(b, "invalidatePrepared 必须自增 mixGeneration").toMatch(/mixGeneration\+\+/);
  });
});
