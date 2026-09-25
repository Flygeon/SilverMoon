/**
 * 画作仓。
 *
 * 状态很薄：磁盘是唯一事实来源，任何写操作（保存/删除/重命名）之后重新列一次目录。
 * 画作数量级在几十张，重列一次就是 readDir + N 次 stat，比在内存里维护一份
 * 可能与磁盘不同步的副本更省心。
 */
import { defineStore } from "pinia";
import { ref } from "vue";
import {
  deleteDrawing,
  drawingPath,
  listDrawings,
  readDrawingSize,
  renameDrawing,
  writeDrawing,
} from "@/features/drawing/files";
import type { Drawing } from "@/features/drawing/types";

/** 新画作默认文件名：时间戳，天然不重名且可排序；用户可随时重命名 */
function newDrawingName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    "画作-" +
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    "-" +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

export const useDrawingStore = defineStore("drawing", () => {
  const items = ref<Drawing[]>([]);
  const loading = ref(false);
  const loaded = ref(false);

  async function refresh() {
    loading.value = true;
    try {
      items.value = await listDrawings();
      loaded.value = true;
    } catch {
      items.value = [];
    } finally {
      loading.value = false;
    }
  }

  /** 首次进入时加载一次；已加载过就不重复列目录 */
  async function ensure() {
    if (!loaded.value && !loading.value) await refresh();
  }

  /** 保存（新建或覆盖），成功后重列并返回落盘条目 */
  async function save(id: string, png: Uint8Array): Promise<Drawing> {
    const d = await writeDrawing(id, png);
    await refresh();
    return d;
  }

  async function remove(id: string) {
    await deleteDrawing(id);
    await refresh();
  }

  async function rename(from: string, to: string) {
    await renameDrawing(from, to);
    await refresh();
  }

  /** 打开编辑器前拿画布尺寸（解析 PNG 头） */
  function drawingSize(id: string) {
    return readDrawingSize(id);
  }

  return {
    items,
    loading,
    loaded,
    drawingSize,
    refresh,
    ensure,
    save,
    remove,
    rename,
    drawingPath,
    newDrawingName,
  };
});
