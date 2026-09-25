/**
 * 创作页的 Markdown 渲染管线。
 *
 * 链路：marked（GFM）-> 自定义 renderer（标题锚点 / GitHub 提示块）
 *      -> DOMPurify 净化 -> 交给 v-html。
 *
 * 为什么用 marked 而不是 unified/remark：
 *   参考项目（花笺）用 react-markdown + remark/rehype 全家桶，那是 React 生态的默认选择；
 *   本项目是 Vue + Vite，只需要「字符串进、安全 HTML 出」。marked 体积小得多，
 *   且零插件即可覆盖 GFM（表格 / 任务列表 / 删除线 / 自动链接），不必为移植引入十几个包。
 *
 * 安全（刻意比参考项目收紧）：
 *   参考项目的 rehype-sanitize schema 额外放行了 style 属性，同时又开着 rehypeRaw，
 *   注入面偏大。这里不放行 style、不放行任何事件属性，且最终产物一律过 DOMPurify。
 *   渲染结果虽然是用户自己的笔记，但它跑在 Electron 渲染进程里，
 *   一旦能注入 HTML 就等于拿到了 IPC 通道。
 */
import { Marked } from "marked";
import DOMPurify from "dompurify";

/** GitHub 风格提示块：类型 -> 图标名 + 中文标题 */
const ALERTS: Record<string, { icon: string; label: string }> = {
  note: { icon: "info", label: "备注" },
  tip: { icon: "lightbulb", label: "提示" },
  important: { icon: "priority_high", label: "重要" },
  warning: { icon: "warning", label: "警告" },
  caution: { icon: "dangerous", label: "注意" },
};

/** 匹配引用块首段的 [!TYPE] 标记（含其后可能存在的软换行 <br>） */
const ALERT_RE = /^\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>)?\s*/i;

/** 标题锚点 id：先剥掉内联标签，再保留中日韩字符与单词字符 */
function slugify(html: string): string {
  const text = html
    .replace(/<[^>]*>/g, "")
    .trim()
    .toLowerCase();
  return text.replace(/[^\w\u4e00-\u9fff-]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

/** 同一次渲染内的标题去重（marked 的 renderer 是模块级的，只能用外部状态） */
let slugSeen = new Map<string, number>();

function uniqueSlug(html: string): string {
  const base = slugify(html);
  const seen = slugSeen.get(base) ?? 0;
  slugSeen.set(base, seen + 1);
  return seen === 0 ? base : base + "-" + seen;
}

const md = new Marked({ gfm: true, breaks: false });

md.use({
  renderer: {
    /** 标题：补 id，供页内锚点跳转 */
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      return "<h" + depth + ' id="' + uniqueSlug(inner) + '">' + inner + "</h" + depth + ">\n";
    },
    /** 引用块：首段是 [!TYPE] 时改渲染成提示块 */
    blockquote({ tokens }) {
      const body = this.parser.parse(tokens);
      const hit = ALERT_RE.exec(body);
      if (!hit) return "<blockquote>\n" + body + "</blockquote>\n";
      const type = hit[1].toLowerCase();
      const meta = ALERTS[type] ?? { icon: "info", label: type };
      const rest = body.slice(hit[0].length);
      // 标记与正文同段 -> 补回被吃掉的 <p>；标记独占一段 -> 丢掉悬空的 </p>
      const inner = rest.startsWith("</p>") ? rest.slice(4).replace(/^\s+/, "") : "<p>" + rest;
      return (
        '<blockquote class="md-alert md-alert-' +
        type +
        '" data-alert="' +
        type +
        '">\n' +
        '<p class="md-alert-title"><span class="material-symbols-outlined" aria-hidden="true">' +
        meta.icon +
        "</span>" +
        meta.label +
        "</p>\n" +
        inner +
        "</blockquote>\n"
      );
    },
  },
});

// 外链统一补 rel，避免 target=_blank 下的 window.opener 泄漏
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (typeof Element !== "undefined" && node instanceof Element && node.tagName === "A") {
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** 只禁 style：其余沿用 DOMPurify 默认白名单（已排除 script/iframe/事件属性/javascript: 协议） */
const PURIFY_CONFIG = { FORBID_ATTR: ["style"] };

/** Markdown 原文 -> 可安全 v-html 的 HTML */
export function renderMarkdown(source: string): string {
  slugSeen = new Map();
  const raw = md.parse(source, { async: false });
  if (typeof raw !== "string") return "";
  return DOMPurify.sanitize(raw, PURIFY_CONFIG);
}

/** 中日韩字符按字计，拉丁按词计（与参考项目的字数口径一致：空白不计） */
export function countWords(source: string): number {
  const cjk = source.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g);
  const latin = source.match(/[A-Za-z0-9_'\u2019-]+/g);
  return (cjk?.length ?? 0) + (latin?.length ?? 0);
}

/** 去空白字符数（参考项目 countNoteChars 的口径） */
export function countChars(source: string): number {
  return source.replace(/\s/g, "").length;
}

/** 行数（空文为 0） */
export function countLines(source: string): number {
  return source.length ? source.split(/\r\n|\r|\n/).length : 0;
}

/** 粗略阅读时长（分钟）：中文 300 字/分、拉丁 200 词/分，取整数且至少 1 分钟 */
export function readingMinutes(source: string): number {
  const cjk = source.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latin = source.match(/[A-Za-z0-9_'\u2019-]+/g)?.length ?? 0;
  return Math.max(1, Math.round(cjk / 300 + latin / 200));
}
