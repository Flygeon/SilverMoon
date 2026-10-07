/**
 * 路由表（**只定义骨架，不接业务**）。
 *
 * 与现有 Electron 桌面端的功能分区对齐（图片 / 视频 / 音乐 / 电子书 / 在线源 / 设置），
 * 但这里刻意只登记「有哪些页面」，不登记任何数据依赖 —— 具体实现在
 * `src/screens/` 下逐个替换掉占位屏即可。
 */

export type RouteId =
  | 'gallery'
  | 'video'
  | 'music'
  | 'library'
  | 'writer'
  | 'online'
  | 'extensions'
  | 'settings';

export interface RouteDef {
  id: RouteId;
  /** 侧栏显示名（中文为默认语言，i18n 接入后改为 key）。 */
  title: string;
  /** 一句话说明，占位屏与侧栏悬浮提示共用。 */
  summary: string;
  /** 侧栏图标占位（暂用 emoji，避免骨架期引入图标字体依赖）。 */
  glyph: string;
  /** 侧栏分组标题。 */
  group: string;
  /** 是否属于「在线源」类（默认关闭，需在设置里开启）。 */
  online?: boolean;
}

/** 侧栏分组顺序。 */
export const ROUTE_GROUPS = ['本地媒体库', '阅读与创作', '在线内容源', '系统'] as const;

export const ROUTES: RouteDef[] = [
  {
    id: 'gallery',
    title: '图片',
    summary: '递归扫描目录、缩略图缓存、EXIF 取向与画板工作台。',
    glyph: '🖼️',
    group: '本地媒体库',
  },
  {
    id: 'video',
    title: '视频',
    summary: '本地视频库、播放进度记忆与投屏入口。',
    glyph: '🎬',
    group: '本地媒体库',
  },
  {
    id: 'music',
    title: '音乐',
    summary: '类 Apple Music 播放器、逐字歌词、10 段 EQ 与桌面歌词窗口。',
    glyph: '🎵',
    group: '本地媒体库',
  },
  {
    id: 'library',
    title: '书架',
    summary: 'EPUB / PDF 阅读器，阅读进度与 CFI 定位。',
    glyph: '📚',
    group: '阅读与创作',
  },
  {
    id: 'writer',
    title: '创作',
    summary: 'Markdown 草稿列表与源码 / 预览双栏。',
    glyph: '✍️',
    group: '阅读与创作',
  },
  {
    id: 'online',
    title: '在线源',
    summary: 'Pixiv / 在线小说 / 番剧 / B 站，均为可选启用。',
    glyph: '🌐',
    group: '在线内容源',
    online: true,
  },
  {
    id: 'extensions',
    title: '扩展',
    summary: '扩展宿主（独立 sidecar）与皮肤包管理。',
    glyph: '🧩',
    group: '系统',
  },
  {
    id: 'settings',
    title: '设置',
    summary: '外观、播放、扫描范围、在线源开关与诊断。',
    glyph: '⚙️',
    group: '系统',
  },
];

const BY_ID = new Map<RouteId, RouteDef>(ROUTES.map(route => [route.id, route]));

export function routeById(id: RouteId): RouteDef {
  const route = BY_ID.get(id);
  if (!route) throw new Error(`未知路由: ${id}`);
  return route;
}

export function routesInGroup(group: string): RouteDef[] {
  return ROUTES.filter(route => route.group === group);
}

/** 默认落地页。 */
export const DEFAULT_ROUTE: RouteId = 'gallery';
