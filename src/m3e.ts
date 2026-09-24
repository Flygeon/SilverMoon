// @m3e/web 原生组件按需副作用注册（导入即 customElements.define）。
// 仅引入本项目实际用到的组件，避免打包整个 @m3e/all：
// - m3e-button / m3e-icon-button：按钮 / 图标按钮（全库 .lm-btn / .lm-icon-btn 的替代）
// - m3e-breadcrumb / m3e-breadcrumb-item：面包屑（WebDAV 路径）
// - m3e-filter-chip / m3e-assist-chip：筛选 chip / 动作 chip
// - m3e-linear-progress-indicator：线性进度条（媒体库扫描）
// - m3e-button-group：连通按钮组（子选项卡）
// - m3e-list / m3e-list-item：连通分组列表（百宝箱）
// - m3e-loading-indicator：M3 Expressive 加载指示器（旋转 + 多边形形变）
// - m3e-switch：开关（设置页 / 音效面板）
// - m3e-slider / m3e-slider-thumb：滑块（设置页 / 音效面板 / 阅读器）
// - m3e-dialog / m3e-dialog-action：对话框（文本输入）
// - m3e-bottom-sheet：底部面板（聚合搜索播放源）
// - m3e-menu / m3e-menu-item：菜单（全局右键菜单）
// - m3e-card：内容卡（设置页区块 / 阅读统计 / 源结果卡）
import "@m3e/web/bottom-sheet";
import "@m3e/web/button";
import "@m3e/web/button-group";
import "@m3e/web/breadcrumb";
import "@m3e/web/card";
import "@m3e/web/chips";
import "@m3e/web/dialog";
import "@m3e/web/icon-button";
import "@m3e/web/list";
import "@m3e/web/loading-indicator";
import "@m3e/web/menu";
import "@m3e/web/progress-indicator";
import "@m3e/web/slider";
import "@m3e/web/switch";

// ---- 上游 bug 兜底（@m3e/web 2.8.x 仍未修复）----
// m3e-bottom-sheet 的 updated() 在「打开过程中元素被暂离 DOM」时会无条件调用原生
// showPopover()；而原生要求宿主元素已连接文档，否则抛 InvalidStateError，导致在线动漫
// 点「开始观看」整页无反馈（上游 Web Awesome 有完全同类的 issue）。
// 修复策略：
//   ① 全局把原生 showPopover 在断连时改为静默 no-op，消除抛错；
//   ② 元素重连（reconnectedCallback）后若仍处于 open 态，用原始 showPopover 补开，恢复功能。
// updated() 里 showPopover 之前的副作用（inert / scrollLock / __openSheet）仍会正常执行。
if (typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.showPopover === "function") {
  const origShowPopover = HTMLElement.prototype.showPopover;
  HTMLElement.prototype.showPopover = function (this: HTMLElement, ...args: unknown[]) {
    if (!this.isConnected) return;
    return origShowPopover.apply(this, args as []) as unknown;
  } as typeof HTMLElement.prototype.showPopover;

  const BottomSheet = customElements.get("m3e-bottom-sheet") as
    (typeof HTMLElement & { prototype: Record<string, unknown> }) | undefined;
  if (BottomSheet && !BottomSheet.prototype.__smSheetPatched) {
    const origReconnect = BottomSheet.prototype.reconnectedCallback as
      ((...a: unknown[]) => unknown) | undefined;
    BottomSheet.prototype.reconnectedCallback = function (this: HTMLElement, ...args: unknown[]) {
      origReconnect?.apply(this, args);
      if (this.isConnected && (this as { open?: boolean }).open) {
        try {
          origShowPopover.call(this);
        } catch {
          /* 重连后补开失败则忽略，避免二次抛错 */
        }
      }
    };
    BottomSheet.prototype.__smSheetPatched = true;
  }
}
