/**
 * 在线小说列表缓存（M9）。
 *
 * 此前目录 / 排行榜 / 推荐**每次**都直连网络：进一次详情页拉一次目录，
 * 切走再回来又拉一次（`NovelDetailPanel` / `NovelBqgView` / `BookReader` /
 * `NovelReader` 四处各自调 `novelCatalogue` / `bqgCatalogue`）。
 * 目录与榜单变化不频繁，这里统一加 TTL，把四处收敛到同一份缓存。
 *
 * TTL 取舍：
 * - **目录**：30 分钟。连载会有新章，但分钟级更新的场景极少；
 *   读者在目录里看不到最新一章时，重进一次即可（或后续加强制刷新入口）。
 * - **排行榜 / 推荐**：30 分钟，榜单通常是日更。
 *
 * 只缓存成功结果：失败多为瞬时故障（网络/被限流），缓存住会让用户刷不出来。
 */
import { capabilities } from "@/capabilities";
import { TtlCache } from "./ttlCache";
import type { NovelCover, NovelRecommendBlock, NovelVolume } from "@shared/types";

const LIST_TTL_MS = 30 * 60 * 1000;

/** 目录缓存：单本目录可能上千章，条目上限压小一点 */
const catalogueCache = new TtlCache<NovelVolume[]>("novel-catalogue", {
  ttlMs: LIST_TTL_MS,
  maxEntries: 32,
});

const rankCache = new TtlCache<NovelCover[]>("novel-rank", {
  ttlMs: LIST_TTL_MS,
  maxEntries: 16,
});

const recommendCache = new TtlCache<NovelRecommendBlock[]>("novel-recommend", {
  ttlMs: LIST_TTL_MS,
  maxEntries: 8,
});

/** 取 Wenku8 目录（带缓存）；`force` 为 true 时绕过缓存。 */
export function novelCatalogueCached(
  node: string,
  charset: string,
  aid: string,
  force = false,
): Promise<NovelVolume[]> {
  return catalogueCache.wrap(
    `wenku8:${node}:${charset}:${aid}`,
    () => capabilities.novelCatalogue(node, charset, aid),
    force ? { skipCache: true } : undefined,
  );
}

/** 取笔趣阁目录（带缓存）；`force` 为 true 时绕过缓存。 */
export function bqgCatalogueCached(aid: string, force = false): Promise<NovelVolume[]> {
  return catalogueCache.wrap(
    `bqg:${aid}`,
    () => capabilities.bqgCatalogue(aid),
    force ? { skipCache: true } : undefined,
  );
}

/** 取排行榜（带缓存）；`force` 为 true 时绕过缓存。 */
export function novelRankCached(
  node: string,
  charset: string,
  sort: string,
  page = 1,
  force = false,
): Promise<NovelCover[]> {
  return rankCache.wrap(
    `rank:${node}:${charset}:${sort}:${page}`,
    () => capabilities.novelRank(node, charset, sort, page),
    force ? { skipCache: true } : undefined,
  );
}

/** 取推荐（带缓存）；`force` 为 true 时绕过缓存。 */
export function novelRecommendCached(
  node: string,
  charset: string,
  force = false,
): Promise<NovelRecommendBlock[]> {
  return recommendCache.wrap(
    `recommend:${node}:${charset}`,
    () => capabilities.novelRecommend(node, charset),
    force ? { skipCache: true } : undefined,
  );
}

/** 清空全部在线小说列表缓存（切换节点 / 重新登录后强制刷新用）。 */
export function clearNovelListCache(): void {
  catalogueCache.clear();
  rankCache.clear();
  recommendCache.clear();
}
