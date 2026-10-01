/**
 * 统一的 TTL 缓存抽象。
 *
 * 背景：此前 `preciseLyrics` / `qqMusic` / `kgMusic` / `animeFetcher` 各自手写了一份
 * `Map + 时间戳 + 容量上限` 的样板，四处重复、行为还不一致（有的记失败、有的不记，
 * 有的有在途去重、有的没有）。这里收敛成一个实现，新缓存一律复用它。
 *
 * 提供三件事：
 * 1. **TTL**：命中且未过期直接返回；过期自动失效。
 * 2. **容量上限 + FIFO 淘汰**：`Map` 迭代序即插入序，满时删最老的一条。
 *    （不是严格 LRU——命中不重排，和改造前各处的既有行为一致，省掉一次 delete/set。）
 * 3. **在途去重**：同一 key 的并发请求只真正执行一次，其余复用同一个 Promise。
 *
 * 另外支持 `okTtl` / `failTtl` 双 TTL：失败结果通常希望更快过期（瞬时故障可重试），
 * 成功结果可以留久一点。传 `isOk` 判定函数即可启用；不传则统一用 `ttlMs`。
 */
export interface TtlCacheOptions<T> {
  /** 有效时长（毫秒）。启用双 TTL 时作为失败条目的时长。 */
  ttlMs: number;
  /** 条目上限，超出后按插入序删最老的。 */
  maxEntries: number;
  /**
   * 判定成功 / 失败；提供时成功条目用 `okTtlMs`，失败条目用 `ttlMs`。
   * 不提供则所有条目统一用 `ttlMs`。
   */
  isOk?: (value: T) => boolean;
  /** 成功条目有效时长（毫秒）；仅在提供 `isOk` 时生效，缺省退回 `ttlMs`。 */
  okTtlMs?: number;
}

interface Entry<T> {
  at: number;
  value: T;
}

export class TtlCache<T> {
  private readonly cache = new Map<string, Entry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly opts: TtlCacheOptions<T>;
  /** 缓存名，仅用于诊断日志区分实例。 */
  readonly name: string;

  constructor(name: string, opts: TtlCacheOptions<T>) {
    this.name = name;
    this.opts = opts;
  }

  /** 当前条目数（诊断用）。 */
  get size(): number {
    return this.cache.size;
  }

  private ttlFor(value: T): number {
    const { isOk, okTtlMs, ttlMs } = this.opts;
    if (isOk && isOk(value)) return okTtlMs ?? ttlMs;
    return ttlMs;
  }

  private put(key: string, value: T): void {
    // Map 迭代序即插入序：超限时删最老的一条
    if (this.cache.size >= this.opts.maxEntries) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { at: Date.now(), value });
  }

  /** 取缓存；不存在或已过期返回 undefined（过期会顺手删除）。 */
  get(key: string): T | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= this.ttlFor(hit.value)) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /** 直接写入（不经过网络路径）。 */
  set(key: string, value: T): void {
    this.put(key, value);
  }

  /** 删除单条。 */
  delete(key: string): void {
    this.cache.delete(key);
  }

  /** 清空全部条目（登录态变化 / 强制刷新 / 规则变更用）。 */
  clear(): void {
    this.cache.clear();
  }

  /**
   * 取缓存，未命中则执行 `produce` 并写入缓存。
   *
   * - 同一 key 并发调用只真正执行一次 `produce`（在途去重）；
   * - `produce` **抛错时不写缓存**，错误照常向上传播（失败要能重试；
   *   确实要缓存失败结果请在 `T` 里显式表达，如 `{ ok: false }`，配合 `isOk`）；
   * - `skipCache` 为 true 时绕过读缓存，但仍会写回结果。
   */
  async wrap(key: string, produce: () => Promise<T>, opts?: { skipCache?: boolean }): Promise<T> {
    if (!opts?.skipCache) {
      const hit = this.get(key);
      if (hit !== undefined) return hit;
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = produce()
      .then((res) => {
        this.put(key, res);
        return res;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}
