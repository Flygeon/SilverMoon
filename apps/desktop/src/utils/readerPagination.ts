/**
 * 在线小说正文的段落归一化与分页。
 *
 * 三个小说来源（文库8 / 笔趣阁 / 番茄）的后端产出格式并不统一：
 * - 文库8 的 parse_content 会给每段开头补 3 个半角空格；
 * - 笔趣阁的 normalize_text 把单换行改写成空行分隔；
 * - 番茄直接拿 sidecar 解析好的 paragraphs 用 \n\n 拼接。
 * 所以在分页前必须先归一化，否则同一套排版参数在不同来源下的分段密度、
 * 段首缩进宽度都不一样，表现为「同一套参数不同来源的书看着就是不一样」。
 */

/** 把正文纯文本切成段落：任意数量的连续换行都算分段，并去掉每段的段首缩进。 */
export function splitReaderParagraphs(text: string): string[] {
  return (text || "")
    .split(/\r?\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * 把段落装入页。`fits` 由调用方提供（真实实现用离屏探针测量 scrollWidth），
 * 返回给定段落组是否还装得进一页。
 *
 * 当单个段落本身就超过一整页时，二分出当前页能容纳的最长前缀，剩余部分顺延到后页。
 * 早期实现遇到这种情况会把整段从当前页弹出再原样塞回，导致整章只剩 1 页，
 * 后面的正文被 overflow:hidden 直接裁掉。
 */
export function paginateParagraphs(
  paragraphs: string[],
  fits: (paras: string[], withTitle: boolean) => boolean,
): string[][] {
  const pages: string[][] = [];
  let cur: string[] = [];
  let firstPage = true;

  const flush = () => {
    if (!cur.length) return;
    pages.push(cur);
    cur = [];
    firstPage = false;
  };

  for (const para of paragraphs) {
    let rest = para;
    while (rest.length > 0) {
      if (fits([...cur, rest], firstPage)) {
        cur.push(rest);
        rest = "";
        break;
      }
      if (cur.length > 0) {
        flush();
        continue;
      }
      let lo = 1;
      let hi = rest.length;
      let best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits([rest.slice(0, mid)], firstPage)) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best === 0) {
        // 连一个字符都放不下：测量异常，整段落地，避免死循环
        cur.push(rest);
        rest = "";
        break;
      }
      pages.push([rest.slice(0, best)]);
      rest = rest.slice(best);
      firstPage = false;
    }
  }
  if (cur.length) pages.push(cur);
  return pages;
}
