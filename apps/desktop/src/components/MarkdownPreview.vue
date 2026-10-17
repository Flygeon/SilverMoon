<script setup lang="ts">
/**
 * Markdown 预览。
 *
 * 渲染 renderMarkdown 的产物，并在渲染后做两件 DOM 增强：
 *   1. 代码块补语言角标 + 复制按钮（marked 只输出 <pre><code class="language-x">）；
 *   2. 链接拦截：http(s) 交给系统浏览器打开，页内 #锚点平滑滚动。
 * 两件事都放在 DOM 层做，避免往 marked 的 renderer 里塞带内联脚本的 HTML
 * （那会把净化白名单逼着放宽）。
 */
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { capabilities } from "@/capabilities";

const props = defineProps<{ html: string; emptyHint: string }>();

const root = ref<HTMLElement | null>(null);
/** 复制按钮的文案回退定时器 */
let copyTimer: ReturnType<typeof setTimeout> | null = null;

function enhance() {
  const el = root.value;
  if (!el) return;
  el.querySelectorAll("pre > code").forEach((code) => {
    const pre = code.parentElement;
    if (!pre || pre.dataset.enhanced === "1") return;
    pre.dataset.enhanced = "1";
    const lang =
      [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length) ?? "";
    if (lang) {
      const badge = document.createElement("span");
      badge.className = "md-lang";
      badge.textContent = lang;
      pre.appendChild(badge);
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-copy";
    btn.textContent = "复制";
    btn.addEventListener("click", () => {
      void navigator.clipboard.writeText(code.textContent ?? "").then(() => {
        btn.textContent = "已复制";
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => {
          btn.textContent = "复制";
        }, 1500);
      });
    });
    pre.appendChild(btn);
  });
}

watch(
  () => props.html,
  () => {
    void nextTick(enhance);
  },
);

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer);
});

function onClick(e: MouseEvent) {
  const anchor = (e.target as HTMLElement).closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href") ?? "";
  e.preventDefault();
  if (href.startsWith("#")) {
    document
      .getElementById(decodeURIComponent(href.slice(1)))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (/^https?:/i.test(href)) void capabilities.openUrl(href);
}
</script>

<template>
  <div ref="root" class="md-body" @click="onClick">
    <p v-if="!html" class="md-empty">{{ emptyHint }}</p>
    <div v-else v-html="html"></div>
  </div>
</template>

<style scoped>
.md-body {
  padding: 2px 16px 24px;
  font-size: 15px;
  line-height: 1.8;
  color: var(--md-sys-color-on-surface);
  word-break: break-word;
}

.md-empty {
  margin: 32px 0;
  text-align: center;
  color: var(--md-sys-color-on-surface-variant);
  opacity: 0.7;
}

/* ---- v-html 内容 ---- */
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  margin: 1.6em 0 0.6em;
  line-height: 1.35;
  font-weight: 600;
}

.md-body :deep(h1) {
  font-size: 1.6em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.md-body :deep(h2) {
  font-size: 1.35em;
}

.md-body :deep(h3) {
  font-size: 1.15em;
}

.md-body :deep(h1:first-child),
.md-body :deep(h2:first-child) {
  margin-top: 0;
}

.md-body :deep(p) {
  margin: 0.85em 0;
}

.md-body :deep(a) {
  color: var(--md-sys-color-primary);
  text-decoration: none;
  border-bottom: 1px solid currentColor;
  cursor: pointer;
}

.md-body :deep(ul),
.md-body :deep(ol) {
  padding-left: 1.5em;
  margin: 0.85em 0;
}

.md-body :deep(li) {
  margin: 0.3em 0;
}

.md-body :deep(li input[type="checkbox"]) {
  margin-right: 0.45em;
  accent-color: var(--md-sys-color-primary);
}

.md-body :deep(blockquote) {
  margin: 1em 0;
  padding: 0.2em 1em;
  border-left: 3px solid var(--md-sys-color-outline-variant);
  color: var(--md-sys-color-on-surface-variant);
}

.md-body :deep(hr) {
  margin: 2em 0;
  border: none;
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.md-body :deep(code) {
  font-family: ui-monospace, Consolas, "Cascadia Mono", monospace;
  font-size: 0.9em;
  background: var(--md-sys-color-surface-container-high);
  padding: 0.15em 0.4em;
  border-radius: 6px;
}

.md-body :deep(pre) {
  position: relative;
  margin: 1em 0;
  padding: 14px 16px;
  background: var(--md-sys-color-surface-container-high);
  border-radius: 12px;
  overflow: auto;
}

.md-body :deep(pre code) {
  background: none;
  padding: 0;
  font-size: 0.875em;
  line-height: 1.6;
}

/* 代码块角标：仅 hover 时与复制按钮一起显形，避免干扰阅读 */
.md-body :deep(.md-lang) {
  position: absolute;
  top: 8px;
  left: 12px;
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--md-sys-color-on-surface-variant);
  opacity: 0.55;
  text-transform: uppercase;
}

.md-body :deep(.md-copy) {
  position: absolute;
  top: 6px;
  right: 8px;
  padding: 3px 10px;
  font-size: 11px;
  font-family: inherit;
  color: var(--md-sys-color-on-surface-variant);
  background: var(--md-sys-color-surface-container-highest);
  border: none;
  border-radius: 999px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
}

.md-body :deep(pre:hover .md-copy) {
  opacity: 1;
}

.md-body :deep(.md-copy:hover) {
  color: var(--md-sys-color-on-surface);
}

.md-body :deep(table) {
  border-collapse: collapse;
  margin: 1em 0;
  width: 100%;
  font-size: 0.94em;
}

.md-body :deep(th),
.md-body :deep(td) {
  border: 1px solid var(--md-sys-color-outline-variant);
  padding: 7px 12px;
  text-align: left;
}

.md-body :deep(th) {
  background: var(--md-sys-color-surface-container-high);
  font-weight: 600;
}

/* 图片固定半宽居中：防大图撑破版式（沿用参考项目的做法） */
.md-body :deep(img) {
  display: block;
  max-width: 50%;
  margin: 1.2em auto;
  border-radius: 12px;
}

/* ---- GitHub 风格提示块：五类各一色 ---- */
.md-body :deep(.md-alert) {
  margin: 1em 0;
  padding: 0.6em 1em;
  border-left-width: 4px;
  border-radius: 8px;
}

.md-body :deep(.md-alert-title) {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0.1em 0 0.4em;
  font-weight: 600;
  color: inherit;
}

.md-body :deep(.md-alert-title .material-symbols-outlined) {
  font-size: 18px;
}

.md-body :deep(.md-alert > p:last-child) {
  margin-bottom: 0.2em;
}

/* GitHub 风格的 5 种提示块 → 全部落到 M3 语义色角色上。
   原来写死 GitHub 调色板（#4493f8 / #3fb950 / …）再为暗色手写一套提亮值：
   既跟种子色无关（换配色后提示块永远是那五个色），又要维护两份。
   现在引一个 --alert-hue 变量，深浅两套自动由令牌适配。
   注意：文字直接用角色色本身（M3 的 40/80 tone 已满足 AA 对比度），
   不再叠加 color-mix 提亮层。 */
.md-body :deep(.md-alert) {
  border-left-color: var(--alert-hue);
  background: color-mix(in srgb, var(--alert-hue) 10%, transparent);
  color: var(--alert-hue);
}

.md-body :deep(.md-alert-note) {
  --alert-hue: var(--md-sys-color-link);
}

.md-body :deep(.md-alert-tip) {
  --alert-hue: var(--md-sys-color-success);
}

.md-body :deep(.md-alert-important) {
  --alert-hue: var(--md-sys-color-tertiary);
}

.md-body :deep(.md-alert-warning) {
  --alert-hue: var(--md-sys-color-warning);
}

.md-body :deep(.md-alert-caution) {
  --alert-hue: var(--md-sys-color-error);
}
</style>
