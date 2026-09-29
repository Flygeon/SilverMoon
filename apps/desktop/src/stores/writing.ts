/**
 * 创作页草稿仓。
 *
 * 持久化走 JsonStore（应用数据目录下的 writing.json 整文件 JSON），与 settings.json
 * 同一套机制——纯渲染进程 + Electron 主进程就能落盘，**不需要动 Rust 侧**。
 *
 * 自动保存：输入后 900ms 防抖落盘（沿用参考项目的口径）；Ctrl+S 走 flush() 立即落盘。
 * 写盘串行化（promise 队列），避免并发 save 互相覆盖。
 * 保存状态机 idle/dirty/saving/saved/error 直接暴露给状态栏。
 */
import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { JsonStore } from "@/ipc/store";
import { writeTextFile } from "@/ipc/fs";
import { capabilities } from "@/capabilities";
import { renderMarkdown } from "@/features/writing/markdown";
import type { Draft, SaveState } from "@/features/writing/types";

const STORE_FILE = "writing.json";
const KEY = "drafts";
const AUTOSAVE_MS = 900;

const store = new JsonStore(STORE_FILE);

/** 草稿 id：时间戳 + 随机后缀，本地唯一即可 */
function newId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** 导出用的独立 HTML（自带一份精简样式，方便直接分享/打印） */
function toStandaloneHtml(title: string, body: string): string {
  return (
    '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    "<title>" +
    title.replace(/[<>&]/g, "") +
    "</title>\n<style>\n" +
    "body{max-width:46rem;margin:3rem auto;padding:0 1.25rem;line-height:1.75;" +
    "font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#1b1b1f}\n" +
    "pre{background:#f4f4f7;padding:1rem;border-radius:12px;overflow:auto}\n" +
    "code{font-family:ui-monospace,Consolas,monospace}\n" +
    "blockquote{margin:1rem 0;padding:.25rem 1rem;border-left:4px solid #c7c7cf;color:#44464f}\n" +
    "table{border-collapse:collapse}th,td{border:1px solid #c7c7cf;padding:.4rem .75rem}\n" +
    "img{max-width:100%}\n" +
    ".md-alert{border-left-width:4px;border-radius:8px;padding:.6rem 1rem}\n" +
    ".md-alert-title{font-weight:600;margin:.2rem 0}\n" +
    "</style>\n</head>\n<body>\n" +
    body +
    "\n</body>\n</html>\n"
  );
}

export const useWritingStore = defineStore("writing", () => {
  const drafts = ref<Draft[]>([]);
  const activeId = ref<string | null>(null);
  const saveState = ref<SaveState>("idle");
  const loaded = ref(false);

  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 串行化写盘 */
  let queue: Promise<void> = Promise.resolve();

  const active = computed(() => drafts.value.find((d) => d.id === activeId.value) ?? null);
  /** 最近编辑的排最前 */
  const ordered = computed(() => [...drafts.value].sort((a, b) => b.updatedAt - a.updatedAt));

  function persist(): Promise<void> {
    queue = queue.then(async () => {
      saveState.value = "saving";
      try {
        await store.set(KEY, drafts.value);
        await store.save();
        saveState.value = "saved";
      } catch {
        saveState.value = "error";
      }
    });
    return queue;
  }

  function scheduleSave() {
    saveState.value = "dirty";
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void persist();
    }, AUTOSAVE_MS);
  }

  /** 立即落盘（Ctrl+S / 切换草稿 / 组件卸载前） */
  async function flush() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await persist();
  }

  async function load() {
    if (loaded.value) return;
    try {
      const saved = await store.get<Draft[]>(KEY);
      drafts.value = Array.isArray(saved) ? saved : [];
    } catch {
      drafts.value = [];
    }
    loaded.value = true;
    if (drafts.value.length) activeId.value = ordered.value[0].id;
    else create();
  }

  function create(title = "未命名"): string {
    const now = Date.now();
    const draft: Draft = { id: newId(), title, content: "", createdAt: now, updatedAt: now };
    drafts.value.push(draft);
    activeId.value = draft.id;
    saveState.value = "dirty";
    void persist();
    return draft.id;
  }

  /** 切换草稿：先把当前这篇落盘，避免切换丢字 */
  async function select(id: string) {
    if (id === activeId.value) return;
    await flush();
    activeId.value = id;
    saveState.value = "saved";
  }

  async function remove(id: string) {
    const i = drafts.value.findIndex((d) => d.id === id);
    if (i < 0) return;
    drafts.value.splice(i, 1);
    if (activeId.value === id) {
      if (drafts.value.length) activeId.value = ordered.value[0].id;
      else create();
    }
    await persist();
  }

  function rename(id: string, title: string) {
    const d = drafts.value.find((x) => x.id === id);
    if (!d) return;
    d.title = title;
    d.updatedAt = Date.now();
    scheduleSave();
  }

  /** 正文变更：更新内容 + 时间戳并排一次自动保存 */
  function setContent(id: string, content: string) {
    const d = drafts.value.find((x) => x.id === id);
    if (!d || d.content === content) return;
    d.content = content;
    d.updatedAt = Date.now();
    scheduleSave();
  }

  /**
   * 导出当前草稿。
   * format: md = 原文；html = 渲染后的独立网页。
   * 返回落盘路径；用户取消返回 null。
   */
  async function exportActive(format: "md" | "html"): Promise<string | null> {
    const d = active.value;
    if (!d) return null;
    const safe = (d.title || "未命名").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    const dest = await capabilities.pickSavePath(safe + "." + format);
    if (!dest) return null;
    const text =
      format === "md"
        ? d.content
        : toStandaloneHtml(d.title || "未命名", renderMarkdown(d.content));
    await writeTextFile(dest, text);
    return dest;
  }

  /** 复制原文到剪贴板 */
  async function copyActive(): Promise<boolean> {
    const d = active.value;
    if (!d) return false;
    try {
      await navigator.clipboard.writeText(d.content);
      return true;
    } catch {
      return false;
    }
  }

  return {
    drafts,
    ordered,
    active,
    activeId,
    saveState,
    loaded,
    load,
    create,
    select,
    remove,
    rename,
    setContent,
    flush,
    exportActive,
    copyActive,
  };
});
