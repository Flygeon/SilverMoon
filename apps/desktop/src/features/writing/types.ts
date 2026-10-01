/** 创作页的一篇草稿。整篇存进 JsonStore，不做分片。 */
export interface Draft {
  id: string;
  /** 标题（用户可改；为空时界面回退显示「未命名」） */
  title: string;
  /** Markdown 原文 */
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** 编辑区视图模式：纯源码 / 源码+预览 / 纯预览 */
export type WriteMode = "edit" | "split" | "preview";

/** 保存状态机：与参考项目一致（idle / dirty / saving / saved / error） */
export type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";
