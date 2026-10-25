import { ref } from "vue";

/** 网格传到详情页的封面 URL；只做首帧占位，不参与任何动画。 */
export const activeCoverUrl = ref<string | null>(null);

/** 当前卡片 appId（保留给视图判断"是不是同一张卡"，动画已移除）。 */
export const activeCoverAppId = ref<number | null>(null);

/** 兼容旧调用点：动画已移除，这里永远是 false。 */
export const heroTransitionActive = ref(false);

/** 记录卡片当前的封面 URL，供详情页首帧直接使用（不等待商店接口）。 */
export function rememberCover(appId: number, coverUrl: string | null): void {
  activeCoverAppId.value = appId;
  activeCoverUrl.value = coverUrl;
}

/** 清空交接状态。 */
export function clearCover(): void {
  activeCoverAppId.value = null;
}

/** 清空当前 cover URL（换游戏时用）。 */
export function clearCoverUrl(): void {
  activeCoverUrl.value = null;
}
