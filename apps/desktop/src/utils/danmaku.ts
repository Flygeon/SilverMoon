/**
 * 弹幕解析与适配层：DanDanPlay 原始条目 → artplayer-plugin-danmuku 期望格式。
 *
 * 参考项目对照：
 *   - Flutter `lib/utils/danmaku.dart`（mergeDuplicateDanmakus 5s 窗 + "xN"）
 *   - Flutter `lib/modules/danmaku/danmaku_module.dart`（DanmakuEntry fromJson）
 *   - Flutter `lib/pages/player/controller/player_danmaku_controller.dart`
 *     （addDanmakus 按秒分组索引、播放循环按秒投放）
 *
 * artplayer-plugin-danmuku 期望的 Danmu 形状：
 *   { text: string, time?: number, mode?: 0|1|2, color?: string, border?: boolean }
 *   - mode 0=滚动 / 1=顶部 / 2=底部（与 DanDanPlay 1/5/4 对应需要重映射）
 *   - color 是 CSS 字符串（"#rrggbb"），DanDanPlay 给的是十进制 RGB int，要转换
 *   - 加载方式：load() 接受函数/Promise/数组，函数返回 Promise<Danmu[]> 也行
 */
import type { DanmakuEntry } from "@shared/types";
import { danmakuLog } from "@/utils/danmakuLog";

/**
 * 源端弹幕模式 → artplayer-plugin-danmuku 模式。
 *
 * **这是全项目唯一的映射实现**，B 站与 DanDanPlay 两条链路都走这里。
 *
 * 两边语义必须对齐，且都以 artplayer-plugin-danmuku 的官方定义为准：
 *   artplayer: 0 = 滚动 / 1 = 顶部 / 2 = 底部
 *   （见其 types/artplayer-plugin-danmuku.d.ts 对 `mode` 的注释）
 *
 * 源端（B 站与 DanDanPlay 同构）: 1/2/3 = 滚动, 4 = 底部, 5 = 顶部。
 *
 * ⚠️ 这里曾经写成 `4 → 1`、`5 → 2`，即把「底部」映射成了「顶部」、反之亦然，
 * 表现为顶部弹幕从底部飘出来。插件自己的 XML 解析用的就是 `case 4: return 2;
 * case 5: return 1`，可直接对照。
 */
export function mapDanmakuMode(mode: number): 0 | 1 | 2 {
  if (mode === 4) return 2; // 底部
  if (mode === 5) return 1; // 顶部
  return 0; // 1/2/3 及其它一律按滚动
}

/** 十进制 RGB int → "#rrggbb" */
function colorHex(intColor: number): string {
  const n = intColor & 0xffffff;
  return `#${n.toString(16).padStart(6, "0")}`;
}

/** artplayer-plugin-danmuku 期望的弹幕项（直接复用其类型路径） */
export interface ArtDanmu {
  text: string;
  time: number;
  mode: 0 | 1 | 2;
  color: string;
  border?: boolean;
}

/** 单条 DanmakuEntry → artplayer 弹幕项 */
export function toArtDanmu(d: DanmakuEntry): ArtDanmu {
  return {
    text: d.text,
    time: d.time,
    mode: mapDanmakuMode(d.mode),
    color: colorHex(d.color),
    border: true,
  };
}

/** 应用时间轴偏移（毫秒）。正数：弹幕延后；负数：弹幕提前 */
export function applyTimeOffset(entries: ArtDanmu[], offsetMs: number): ArtDanmu[] {
  if (!offsetMs) return entries;
  const delta = offsetMs / 1000;
  return entries.map((d) => ({ ...d, time: Math.max(0, d.time + delta) }));
}

/**
 * 5 秒时间窗内合并重复弹幕，文本末尾追加 "xN"。
 * 照 `mergeDuplicateDanmakus` 默认实现：归一化（去标点/空白、全角转半角）后比文本。
 */
export function mergeDuplicates(entries: ArtDanmu[], windowSec = 5): ArtDanmu[] {
  if (entries.length <= 1) return entries;
  // 先按 time 升序排，方便时间窗扫描
  const sorted = [...entries].sort((a, b) => a.time - b.time);
  const norm = (s: string) =>
    s
      .replace(/[\s\u3000]+/g, "")
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[^\w\u4e00-\u9fa5]+/g, "")
      .toLowerCase();
  const out: ArtDanmu[] = [];
  /**
   * 每条保留项的**原始正文**与累计计数。
   *
   * 两者都必须与 `out[i].text` 分开存：计数后缀一旦写回 text，下一轮归一化比对就会
   * 拿「哈哈哈 x2」去和「哈哈哈」比，永远匹配不上（表现为去重完全失效）；
   * 而正文本身就长成「好的 x2」时，也会被误判成已有计数。
   */
  const baseText: string[] = [];
  const counts: number[] = [];
  /** 保留项未经改写的展示文本（与 norm 后的 baseText 不同：这个保留原样） */
  const shownText: string[] = [];
  for (const cur of sorted) {
    const key = norm(cur.text);
    const i = out.length - 1;
    // 必须同模式才合并：顶部弹幕与滚动弹幕内容相同时并成一条，会连模式带颜色
    // 一起被前一条覆盖（表现为「顶部弹幕跑到滚动里」）。
    if (
      i >= 0 &&
      baseText[i] === key &&
      out[i].mode === cur.mode &&
      cur.time - out[i].time <= windowSec
    ) {
      counts[i] += 1;
      // 始终基于原始文本重建后缀，避免「x2 x3」这样越叠越长
      out[i].text = `${shownText[i]} x${counts[i]}`;
    } else {
      out.push({ ...cur });
      baseText.push(key);
      counts.push(1);
      shownText.push(cur.text);
    }
  }
  return out;
}

/**
 * 端到端：DanDanPlay 原始条目数组 → artplayer 可直接 load 的数组。
 *
 * 只做「偏移 + 去重」。此前还顺带算了一份「秒 → 弹幕列表」索引，但**没有任何
 * 消费方**（全项目仅 AnimePlayer 解构了 items），等于每轮加载白遍历一次近万条
 * 数组；投放节奏本来也由插件内部的 currentTime 轮询负责，故删掉。
 */
export function adaptDandanToArt(
  raw: DanmakuEntry[],
  options: { offsetMs?: number; dedup?: boolean; dedupWindowSec?: number } = {},
): { items: ArtDanmu[]; total: number } {
  const offsetMs = options.offsetMs ?? 0;
  const dedup = options.dedup ?? true;
  const win = options.dedupWindowSec ?? 5;

  let items = raw.map(toArtDanmu);
  if (dedup) items = mergeDuplicates(items, win);
  items = applyTimeOffset(items, offsetMs);

  void danmakuLog(`适配弹幕 完成 raw=${raw.length} 去重后=${items.length}`);
  return { items, total: items.length };
}
