/**
 * 云端歌词候选的「标题 / 艺人」匹配打分。
 *
 * 背景：四个歌词源（AMLL TTML DB / QQ / 酷狗 / Meting）此前统一用
 * `normalizeTitle(a) === normalizeTitle(b)` 做判等——只要两边写法差一个标点、
 * 一个译名、一个没加括号的 feat.，就整首判死返回 no-match。而 AMLL 的索引里
 * 同名条目有 453 组、其中 38% 其实是**不同艺人的不同歌**（《怪物》= YOASOBI
 * 与 MC HotDog 两首），所以既不能放太宽也不能一刀切死。
 *
 * 这里的做法是**打分 + 阈值**：
 * - 标题分：归一化相等 / 折叠相等 → 1；包含关系 → 按长度比例衰减；
 *   否则退到字符 bigram 的 Dice 系数（对中文短标题友好）与英文词集合的 Jaccard。
 * - 艺人分：本地 tag 的艺人（可能是 `A/B`、`A & B`、`A feat. B`）与候选艺人列表
 *   做「折叠包含」匹配。用来把同名的不同歌区分开。
 *
 * 阈值分两档，宁可漏也不要错拿别人的歌词：
 * - `TITLE_STRONG`（≈ 同一首歌）：标题分足够高，艺人可有可无；
 * - `TITLE_WEAK`（≈ 可能同一首）：必须同时有艺人佐证才接受。
 */

/** 括号内容（半角/全角圆括号）。方括号 / 书名号里的内容通常是版本说明，但不剥：
 *  索引里真有 `world.execute (me) ;`、`All Too Well [Taylor's Version]` 这类把
 *  方括号当标题一部分的写法，剥了反而搜不到。 */
const BRACKET_RE = /[（(][^（）()]*[）)]/g;

/** 去掉括号内的附加信息（如「夜曲 (Live)」→「夜曲」），用于搜索词与匹配比较 */
export function stripBrackets(t: string): string {
  return t.replace(BRACKET_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * 标题归一化：去括号 + trim + 小写 + 全角→半角 + 空白折叠。
 *
 * 这是「宽松判等」的那一档，也是各平台搜索接口的通用形态。
 */
export function normalizeTitle(t: string): string {
  return stripBrackets(t)
    .toLowerCase()
    .replace(/\u3000/g, " ")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 「折叠」比较键：全角→半角 + 小写 + 去掉所有空白、标点与符号。
 *
 * 处理的是标点写法差异：`world.execute (me) ;`↔`world.execute(me);`、
 * `ME!`↔`ME`、`夜曲 -Instrumental-`↔`夜曲 Instrumental`。中文标点（`、`「」`）
 * 也在此列。保留汉字 / 假名 / 拉丁字母 / 数字，其余一律删除。
 *
 * **刻意不剥括号**：与 normalizeTitle 不同，括号在这里只是「标点」，
 * `world.execute (me) ;` 里的 `(me)` 是标题正文，剥掉就变成另一个词了。
 */
export function foldTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\u3000/g, " ")
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .replace(/[\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/g, "");
}

/** 是否含 CJK（汉字 / 假名）：决定用字符 bigram 还是词集合做相似度 */
function hasCjk(s: string): boolean {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(s);
}

/**
 * 字符 bigram 集合（长度 1 的串退化为单字符集合）。
 *
 * 只在**全是 CJK** 时使用：对中文短标题，bigram 能识别「错别字 / 少一个字」这类差异。
 * 含拉丁字母的标题不用它——`Idol` 与 `Model` 共享 bigram `od`/`de`，Dice 会给到
 * 0.5 以上，属于明显的高估；英文标题改走词集合的 Jaccard。
 */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length <= 1) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** Dice 系数：2|A∩B| / (|A|+|B|)，对中文短标题的错别字 / 漏字很敏感 */
function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/** 词集合（按空白切分），用于英文标题 */
function words(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

/** Jaccard 相似度，用于英文标题（词序 / 标点差异） */
function jaccard(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 标题相似度（0..1）。1 = 同一标题。
 *
 * 分档（取最高）：
 * 1. 归一化后完全相等（`夜曲 (Live)` vs `夜曲`）→ 1；
 * 2. 折叠后完全相等（`ME!` vs `ME`）→ 0.97；
 * 3. 一方包含另一方 → 0.62 + 0.3 × 短长比（`晴天` ⊂ `晴天 (Live)` 归 1 档，
 *    这里主要覆盖 `Only My Railgun` vs `only my railgun -Instrumental-`）；
 * 4. 否则取 max(Dice bigram, Jaccard 词) —— 中文看字符、英文看词。
 */
export function titleSimilarity(local: string, candidate: string): number {
  const a = normalizeTitle(local);
  const b = normalizeTitle(candidate);
  // 歌名**整体**被括号包住时 normalizeTitle 会把它剥成空串（索引里真有
  // 「（……醉鬼阿Q）（feat. 孙燕姿）」这种写法）。这时退回不剥括号的折叠形态，
  // 否则两个本来一模一样的标题都会因为空串而拿到 0 分、判成「不是同一首」。
  const fa = a ? foldTitle(a) : foldTitle(local);
  const fb = b ? foldTitle(b) : foldTitle(candidate);
  if (!fa || !fb) return 0;
  if (a && b && a === b) return 1;
  if (fa === fb) return a && b ? 0.97 : 0.95;
  // 只有**前缀**扩展才算「同一个标题多带了后缀」（偶像【MV】 / Idol -Remastered /
  // Only My Railgun ⊂ only my railgun -Instrumental-）。中间或结尾的偶发子串不算：
  //   「当时的我们还很好」包含「我们」、「Out Of The Woods」包含「Wood」——
  //   这类只是字符巧合，放进来会错拿别人的歌词（比拿不到更糟）。
  const aIsPrefix = fa.startsWith(fb);
  const bIsPrefix = fb.startsWith(fa);
  if (aIsPrefix || bIsPrefix) {
    const short = Math.min(fa.length, fb.length);
    const long = Math.max(fa.length, fb.length);
    // 短串太短（1 个字符）不算，否则 `A` 会命中一切
    if (short >= 2) return 0.62 + 0.3 * (short / long);
  }
  // CJK 标题：字符 bigram；纯拉丁标题：词集合 Jaccard。混排（如「千本桜 feat. 初音ミク」）
  // 两者都算，取更高的一个。
  const mixed = hasCjk(fa) || hasCjk(fb);
  return Math.max(
    mixed ? dice(fa, fb) : 0,
    jaccard(a || local, b || candidate),
    // 纯拉丁且只有一两个词时 jaccard 只能给 0/1，补一档 bigram 兜底但压权重
    mixed ? 0 : dice(fa, fb) * 0.9,
  );
}

/**
 * 两个「艺人碎片」是否算同一位。
 *
 * 1. 折叠后完全相等 → 是；
 * 2. 一方包含另一方（`G.E.M.邓紫棋` ⊇ `邓紫棋`）→ 是，单字符不算；
 * 3. 都含 CJK 且字符重合度高（`周杰倫` vs `周杰伦`，简繁字形不同但 3 字重合 2 个）
 *    → 是。这里刻意不引简繁转换表：社区歌词库里艺人名的简繁混用非常零散，
 *    按字符重合判断够用，也不会引入一份要长期维护的对照表。
 */
function artistTokenMatches(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true;
  if (!hasCjk(a) || !hasCjk(b)) return false;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const ch of A) if (B.has(ch)) inter++;
  // 短名字要求高重合（2 字名必须 2 个全中），长名字允许 1 个字不同
  const ratio = (2 * inter) / (A.size + B.size);
  const need = Math.min(A.size, B.size) <= 2 ? 1 : 0.6;
  return ratio >= need;
}

/** 把艺名字符串切成可比对的碎片：`A/B`、`A & B`、`A feat. B`、`A、B` 都拆开 */
function artistTokens(artist: string): string[] {
  return artist
    .split(/[/&,，、;；]+|\bfeat\.?\b|\bft\.?\b|\bwith\b|\bvs\.?\b/i)
    .map((s) => foldTitle(s))
    .filter((s) => s.length >= 1);
}

/**
 * 艺人相似度（0..1）。
 *
 * - 任一侧为空 → 0（"不知道"不等于"匹配"，调用方据此退回只按标题判断）；
 * - 两侧存在一对折叠后相等或互相包含的艺人 → 1；
 * - 存在部分相等的艺人（`周杰倫` vs `周杰伦` 折叠后不等，但一方是另一方的子串）→ 1；
 * - 多艺人合作曲：按交集比例给分（0.5 起步，避免只对上一个人就满分）。
 */
export function artistSimilarity(localArtist: string | undefined, candidates: string[]): number {
  const mine = artistTokens(localArtist ?? "");
  if (!mine.length) return 0; // 本地无艺人信息 → 0（调用方用 artistUnknown 决定怎么处理）
  const theirs = candidates.flatMap((a) => artistTokens(a));
  if (!theirs.length) return 0;
  let matched = 0;
  for (const m of mine) {
    if (theirs.some((t) => artistTokenMatches(m, t))) matched++;
  }
  if (!matched) return 0;
  // 全对上 → 1；联合曲只对上一部分 → 按比例，但不低于 0.5（能确认一位艺人就够强了）
  return Math.max(0.5, matched / Math.min(mine.length, theirs.length));
}

/** 标题分的「同一首歌」阈值 */
export const TITLE_STRONG = 0.86;
/** 标题分的「可能同一首」阈值：达到且艺人能对上才接受 */
export const TITLE_WEAK = 0.6;

/** 归一化后是否完全相等（比 foldTitle 严格：保留空白与标点的差异） */
export function isExactTitle(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  // 歌名整体被括号包住时 normalizeTitle 会得到空串，此时不认为「精确相等」
  return !!na && na === nb;
}

/** 一组候选标题里的最高标题分，以及是否与本地标题「归一化完全相等」 */
export function bestTitleMatch(
  local: string,
  candidates: string[],
): { score: number; exact: boolean } {
  let score = 0;
  let exact = false;
  for (const c of candidates) {
    if (isExactTitle(local, c)) exact = true;
    const s = titleSimilarity(local, c);
    if (s > score) score = s;
  }
  return { score, exact };
}

export interface SameSongOptions {
  /** 归一化后完全相等（isExactTitle）。这是最强的「同一首」信号，无需艺人佐证 */
  exactTitle?: boolean;
  /** 本地或候选缺少艺人信息。缺信息 ≠ 不匹配，此时不能拿艺人分否定标题 */
  artistUnknown?: boolean;
}

/**
 * 判断候选是否算「同一首歌」。
 *
 * `strong` 表示「基本可以确定是这一首」（调用方在时长对不上时可以更宽容地兜底）。
 *
 * 三档：
 * 1. 标题**归一化完全相等** → 接受（与旧行为一致：同名就是最强信号）；
 * 2. 标题高度相似（折叠相等 / 高比例包含）→ 需要艺人能对上；若双方都给了艺人却完全对不上，
 *    判定为「同名的另一首歌」而拒绝。这条专门拦 foldTitle 带来的新误报：
 *    `Heartbeat`(Cloudier) 与 `HEART BEAT`(YOASOBI) 折叠后完全相同；
 *    `ME!`(Taylor Swift) 与 `≠ME` 同理；
 * 3. 标题仅「可能同一首」→ 必须有艺人佐证。
 *
 * AMLL 索引里 453 组同名条目中 38% 是不同艺人的不同歌（《怪物》= YOASOBI / MC HotDog），
 * 所以第 2、3 档都必须让艺人参与决策；而本地 tag「没有艺人」又不能当作否定证据。
 */
export function isSameSong(
  titleScore: number,
  artistScore: number,
  opts: SameSongOptions = {},
): { accept: boolean; strong: boolean } {
  if (opts.exactTitle) return { accept: true, strong: true };
  if (titleScore >= TITLE_STRONG) {
    if (artistScore >= 0.5 || opts.artistUnknown) return { accept: true, strong: true };
    return { accept: false, strong: false };
  }
  if (titleScore >= TITLE_WEAK && artistScore >= 0.5) return { accept: true, strong: false };
  return { accept: false, strong: false };
}
