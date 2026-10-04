#!/usr/bin/env node
/**
 * `npm run verify:tag-sources` —— 五个本地音乐源的**真实联网**冒烟。
 *
 * 为什么单独写这个脚本：
 * - 渲染层走 \`@/ipc/http\`（主进程网络栈），Node 里跑不了；这里直接用 Node 内置 fetch，
 *   目的只是确认「这些逆向接口今天还通、字段形状没变」——接口随时可能失效，
 *   所以单源失败**不算**整体失败，只有可用的源少于 3 个才 exit 1。
 *
 * 与 \`verify-music-tags.mjs\` 的关系：那个验证 taglib 写盘，这个只验证网络数据源。
 */
const KEYWORD = "夜曲";
const TIMEOUT_MS = 12000;

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1";

/** 至少几个源返回非空才算通过 */
const MIN_OK_SOURCES = 3;

async function getText(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function sanitize(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

/** 每个源返回 { title, artist } 列表（只取前几条用于展示） */
const SOURCES = {
  // ---- QQ 音乐：DoSearchForQQMusicLite ----
  // 需要先 GetSession 拿 uid/sid/userip 并拼 comm，逻辑较长；这里只做最小可用的探测：
  // 直接打搜索接口，若被风控则视为该源失败（不算整体失败）。
  async qq() {
    const searchId = (
      (BigInt(1 + Math.floor(Math.random() * 20)) << 54n) +
      (BigInt(Math.floor(Math.random() * 4194305)) << 32n) +
      BigInt(Math.round(Date.now()) % 86400000)
    ).toString();
    const param = {
      search_id: searchId,
      remoteplace: "search.android.keyboard",
      query: KEYWORD,
      search_type: 0,
      num_per_page: 20,
      page_num: 1,
      highlight: 0,
      nqc_flag: 0,
      page_id: 1,
      grp: 1,
    };
    const url =
      "https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=" +
      encodeURIComponent(
        JSON.stringify({
          req_1: {
            module: "music.search.SearchCgiService",
            method: "DoSearchForQQMusicLite",
            param,
          },
        }),
      );
    const data = JSON.parse(await getText(url, { "User-Agent": DESKTOP_UA }));
    const items = data?.req_1?.data?.body?.item_song ?? [];
    return items.map((info) => ({
      title: sanitize(info?.title),
      artist: (info?.singer ?? [])
        .map((s) => s?.name)
        .filter(Boolean)
        .join("/"),
    }));
  },

  // ---- 网易云：公开 cloudsearch ----
  async netease() {
    const url =
      "https://music.163.com/api/cloudsearch/pc?s=" +
      encodeURIComponent(KEYWORD) +
      "&type=1&offset=0&limit=10";
    const data = JSON.parse(
      await getText(url, { "User-Agent": DESKTOP_UA, Referer: "https://music.163.com/" }),
    );
    const songs = data?.result?.songs ?? [];
    return songs.map((s) => ({
      title: sanitize(s?.name),
      artist: (s?.ar ?? [])
        .map((a) => a?.name)
        .filter(Boolean)
        .join("/"),
    }));
  },

  // ---- 酷狗：有签名的搜索接口需要 Rust 侧；这里用公开的移动端搜索做探测 ----
  async kugou() {
    const url =
      "http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=" +
      encodeURIComponent(KEYWORD) +
      "&page=1&pagesize=10&showtype=1";
    const data = JSON.parse(await getText(url, { "User-Agent": DESKTOP_UA }));
    const list = data?.data?.info ?? [];
    return list.map((s) => ({ title: sanitize(s?.songname), artist: sanitize(s?.singername) }));
  },

  // ---- 咪咕：App 接口（需手机 UA） ----
  async migu() {
    const switchParam = encodeURIComponent(JSON.stringify({ song: 1 }));
    const url =
      "https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?text=" +
      encodeURIComponent(KEYWORD) +
      `&pageNo=1&pageSize=10&isCopyright=1&sort=1&searchSwitch=${switchParam}`;
    const data = JSON.parse(await getText(url, { "User-Agent": MOBILE_UA }));
    const list = data?.songResultData?.result ?? [];
    return list.map((s) => ({
      title: sanitize(s?.name),
      artist: (s?.singers ?? [])
        .map((x) => x?.name)
        .filter(Boolean)
        .join("/"),
    }));
  },

  // ---- 酷我：单引号 JSON；必须带 uid/ver/vipver 才是带 ALBUM 的新格式 ----
  async kuwo() {
    const url =
      "https://search.kuwo.cn/r.s?client=kt&all=" +
      encodeURIComponent(KEYWORD) +
      "&pn=0&rn=10&uid=794762570&ver=kwplayer_ar_9.2.2.1&vipver=1" +
      "&ft=music&encoding=utf8&rformat=json";
    const raw = await getText(url, { "User-Agent": DESKTOP_UA });
    const out = [];
    for (const chunk of raw.split(/\},\{/)) {
      const rec = {};
      for (const m of chunk.matchAll(/'([A-Za-z_]+)':'([^']*)'/g)) rec[m[1]] = m[2];
      if (rec.NAME) out.push({ title: sanitize(rec.NAME), artist: sanitize(rec.ARTIST) });
      if (out.length >= 10) break;
    }
    return out;
  },
};

const NAMES = {
  qq: "QQ 音乐",
  netease: "网易云",
  kugou: "酷狗",
  migu: "咪咕",
  kuwo: "酷我",
};

(async () => {
  console.log(
    `verify:tag-sources —— 关键词「${KEYWORD}」，${Object.keys(SOURCES).length} 个源，${MIN_OK_SOURCES} 个非空即通过\n`,
  );

  const rows = [];
  for (const [key, fn] of Object.entries(SOURCES)) {
    const started = Date.now();
    let count = 0;
    let first = "";
    let error = "";
    try {
      const list = await fn();
      count = list.length;
      if (list[0]) first = `${list[0].title}${list[0].artist ? ` / ${list[0].artist}` : ""}`;
    } catch (e) {
      error = e?.name === "AbortError" ? `超时(${TIMEOUT_MS}ms)` : String(e?.message ?? e);
    }
    rows.push({ key, count, first, ms: Date.now() - started, error });
  }

  const pad = (s, n) => String(s).padEnd(n, " ");
  const padS = (s, n) => String(s).padStart(n, " ");
  console.log(pad("源", 22) + padS("结果数", 6) + padS("耗时", 10) + "  首条 / 错误");
  console.log("-".repeat(86));
  for (const r of rows) {
    const detail = r.error ? `✗ ${r.error}` : `✓ ${r.first}`;
    console.log(
      pad(`${r.key}(${NAMES[r.key]})`, 22) +
        padS(r.count, 6) +
        padS(`${r.ms}ms`, 10) +
        `  ${detail}`,
    );
  }

  const ok = rows.filter((r) => r.count > 0);
  console.log("\n" + "-".repeat(86));
  console.log(`通过源：${ok.length}/${rows.length}（${ok.map((r) => r.key).join(", ") || "无"}）`);

  if (ok.length >= MIN_OK_SOURCES) {
    console.log(`\nverify:tag-sources OK（${ok.length} 个源返回非空，阈值 ${MIN_OK_SOURCES}）`);
    return;
  }
  console.error(
    `\nverify:tag-sources 失败：只有 ${ok.length} 个源返回非空，低于阈值 ${MIN_OK_SOURCES}`,
  );
  process.exit(1);
})().catch((error) => {
  console.error("verify:tag-sources 异常退出：", error);
  process.exit(1);
});
