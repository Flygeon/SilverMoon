/**
 * 几何类型：逻辑坐标与物理像素。
 *
 * 自绘标题栏的拖拽用 `PhysicalPosition`（物理像素，与 `PointerEvent.screenX`
 * 经主进程换算后一致）；`LogicalPosition` / `LogicalSize` 供需要逻辑坐标的场景。
 */
/** 逻辑坐标（CSS 像素）位置 */
export class LogicalPosition {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

/** 逻辑尺寸 */
export class LogicalSize {
  constructor(
    public width: number,
    public height: number,
  ) {}
}

/** 物理像素位置 */
export class PhysicalPosition {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

/** 物理像素尺寸 */
export class PhysicalSize {
  constructor(
    public width: number,
    public height: number,
  ) {}
}

/** 供主进程区分的坐标类型标记 */
export type PositionLike =
  { kind: "physical"; x: number; y: number } | { kind: "logical"; x: number; y: number };

/** 供主进程区分的尺寸类型标记 */
export type SizeLike =
  | { kind: "physical"; width: number; height: number }
  | { kind: "logical"; width: number; height: number };

/** 把任意位置对象规整成主进程可消费的形式。 */
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

/** 把任意尺寸对象规整成主进程可消费的形式。 */
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
