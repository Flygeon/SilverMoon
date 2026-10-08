/**
 * 几何类型：逻辑坐标与物理像素。
 *
 * 直接复用 Tauri 自己的 `@tauri-apps/api/dpi` 类 —— `setPosition` / `setSize`
 * 只接受这些类（它们带 `type` 判别字段与 `SERIALIZE_TO_IPC_FN`），自己造一个
 * 同名 class 传进去会被静默拒绝。因此这里只做**再导出 + 规整**。
 *
 * `PhysicalPosition`（物理像素）用于与宿主交换窗口几何——它与渲染进程的
 * `PointerEvent.screenX`（CSS 像素）**不是同一口径**，混算前须按缩放比换算；
 * `LogicalPosition` / `LogicalSize` 供需要逻辑坐标的场景。
 */
import { LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";

export { LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize };

/** 供宿主区分的坐标类型标记 */
export type PositionLike =
  { kind: "physical"; x: number; y: number } | { kind: "logical"; x: number; y: number };

/** 供宿主区分的尺寸类型标记 */
export type SizeLike =
  | { kind: "physical"; width: number; height: number }
  | { kind: "logical"; width: number; height: number };

/** 把任意位置对象规整成宿主可消费的形式。 */
export function toPositionLike(value: unknown): PositionLike | null {
  if (value instanceof PhysicalPosition) {
    return { kind: "physical", x: value.x, y: value.y };
  }
  if (value instanceof LogicalPosition) {
    return { kind: "logical", x: value.x, y: value.y };
  }
  if (value && typeof value === "object" && "x" in value && "y" in value) {
    const v = value as { x: number; y: number };
    return { kind: "logical", x: v.x, y: v.y };
  }
  return null;
}

/** 把任意尺寸对象规整成宿主可消费的形式。 */
export function toSizeLike(value: unknown): SizeLike | null {
  if (value instanceof PhysicalSize) {
    return { kind: "physical", width: value.width, height: value.height };
  }
  if (value instanceof LogicalSize) {
    return { kind: "logical", width: value.width, height: value.height };
  }
  if (value && typeof value === "object" && "width" in value && "height" in value) {
    const v = value as { width: number; height: number };
    return { kind: "logical", width: v.width, height: v.height };
  }
  return null;
}
