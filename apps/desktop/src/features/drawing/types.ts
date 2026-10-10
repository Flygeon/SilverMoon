/**
 * 绘画功能的领域类型。
 */

/** 一张画作。元信息全部从磁盘派生（文件名 / mtime / 文件大小），不额外维护清单。 */
export interface Drawing {
  /** 文件名去掉 .png，同时用作列表 key 与磁盘标识 */
  id: string;
  /** PNG 绝对路径 */
  path: string;
  /** 显示名，默认等于 id */
  name: string;
  /** 文件字节数 */
  size: number;
  /** 最后修改时间（毫秒时间戳） */
  mtime: number;
}

/** 编辑器工具 */
export type DrawTool =
  "select" | "brush" | "eraser" | "fill" | "rect" | "ellipse" | "line" | "text";

/**
 * 形状的填充方式。
 *
 * 原来形状**只有描边**，连一个实心矩形都画不出来——这是最刺眼的功能洞。
 * 三种模式对齐主流绘画软件的习惯（Photoshop 的填充/描边两行开关）。
 */
export type ShapeFillMode = "stroke" | "fill" | "both";

/** 形状填充模式的展示顺序（工具栏按此顺序排列） */
export const SHAPE_FILL_MODES: { value: ShapeFillMode; icon: string; key: string }[] = [
  { value: "stroke", icon: "check_box_outline_blank", key: "draw.fillModeStroke" },
  { value: "fill", icon: "check_box", key: "draw.fillModeFill" },
  { value: "both", icon: "indeterminate_check_box", key: "draw.fillModeBoth" },
];

/** 新建画布尺寸预设 */
export const CANVAS_PRESETS = [
  { id: "square", label: "正方形 1024", width: 1024, height: 1024 },
  { id: "landscape", label: "横版 1600×900", width: 1600, height: 900 },
  { id: "portrait", label: "竖版 900×1600", width: 900, height: 1600 },
] as const;
