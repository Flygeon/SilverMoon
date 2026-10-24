/**
 * Steam 成就解析的单测（不联网）。
 *
 * ## 为什么解析逻辑要单独测
 *
 * 成就走的是**社区公开 XML**（`/profiles/<id>/stats/<appid>/achievements/?xml=1`），
 * 而不是 `ISteamUserStats/GetPlayerAchievements`——后者**只认 WebAPI key**，
 * 传 access_token 会直接 400 `Required parameter 'key' is missing`（实测）。
 *
 * 这条路上有三类「写错就静默坏」的情况：
 * 1. 隐私为私密/仅好友时，XML **没有成就列表**，必须降级成 available:false，
 *    而不是把「0/0」当成「这游戏没成就」；
 * 2. CDATA 与普通文本两种包法都要认（Steam 混用）；
 * 3. `<closed>` 是 1/0 字符串，判成 truthy 会把所有成就显示成已解锁。
 */
import { describe, it, expect } from "vitest";

/**
 * 复刻 protocol.ts 里的 XML 解析（纯函数，不依赖网络）。
 *
 * 之所以在这里重写一遍而不是导出内部实现：解析逻辑嵌在 fetchAchievements 里，
 * 依赖 access_token。把「块切分 + 字段提取」这段抽出来单独测，能锁住正则行为，
 * 避免改动时静默失效。若 protocol.ts 的解析改规则，这里必须同步改。
 */
interface ParsedAchievement {
  apiName: string;
  name: string;
  description: string | null;
  unlocked: boolean;
  unlockTime: number | null;
}

function parseAchievementsXml(xml: string): {
  available: boolean;
  warning?: string;
  achievements: ParsedAchievement[];
} {
  const privacy = /<privacyState>([^<]*)<\/privacyState>/.exec(xml)?.[1] ?? "";
  if (privacy && privacy !== "public") {
    return {
      available: false,
      warning:
        privacy === "private"
          ? "该账号的成就资料设为私密，无法读取"
          : "该账号的成就资料仅好友可见，无法读取",
      achievements: [],
    };
  }
  const blocks = xml.match(/<achievement\b[\s\S]*?<\/achievement>/g) ?? [];
  const achievements: ParsedAchievement[] = [];
  for (const block of blocks) {
    const pick = (tag: string) => {
      const m =
        new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(block) ??
        new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block);
      return m?.[1]?.trim() ?? "";
    };
    const apiName = pick("apiname");
    if (!apiName) continue;
    const closed = pick("closed") === "1";
    const unlockTime = Number(pick("unlockTimestamp") || 0);
    achievements.push({
      apiName,
      name: pick("name") || apiName,
      description: pick("description") || null,
      unlocked: closed,
      unlockTime: unlockTime > 0 ? unlockTime * 1000 : null,
    });
  }
  return {
    available: achievements.length > 0,
    warning: achievements.length === 0 ? "该游戏没有成就，或成就资料未公开" : undefined,
    achievements,
  };
}

describe("成就 XML：隐私降级", () => {
  it("private → 明确说明私密，而不是 0/0", () => {
    const r = parseAchievementsXml(
      "<playerstats><privacyState>private</privacyState></playerstats>",
    );
    expect(r.available).toBe(false);
    expect(r.warning).toContain("私密");
    expect(r.achievements).toHaveLength(0);
  });

  it("friendsonly → 说明仅好友可见", () => {
    const r = parseAchievementsXml(
      "<playerstats><privacyState>friendsonly</privacyState></playerstats>",
    );
    expect(r.available).toBe(false);
    expect(r.warning).toContain("好友");
  });

  it("public 但无成就块 → 说明没有成就", () => {
    const r = parseAchievementsXml(
      "<playerstats><privacyState>public</privacyState></playerstats>",
    );
    expect(r.available).toBe(false);
    expect(r.warning).toContain("没有成就");
  });
});

describe("成就 XML：字段解析", () => {
  const xml = `<playerstats>
    <privacyState>public</privacyState>
    <achievements>
      <achievement>
        <apiname><![CDATA[ACH_WIN]]></apiname>
        <name><![CDATA[初次通关]]></name>
        <description><![CDATA[完成第一关]]></description>
        <closed>1</closed>
        <unlockTimestamp>1700000000</unlockTimestamp>
      </achievement>
      <achievement>
        <apiname>ACH_LOCKED</apiname>
        <name>尚未解锁</name>
        <description>继续努力</description>
        <closed>0</closed>
        <unlockTimestamp>0</unlockTimestamp>
      </achievement>
    </achievements>
  </playerstats>`;

  it("CDATA 与普通文本两种包法都能解", () => {
    const r = parseAchievementsXml(xml);
    expect(r.achievements).toHaveLength(2);
    expect(r.achievements[0].apiName).toBe("ACH_WIN");
    expect(r.achievements[1].apiName).toBe("ACH_LOCKED");
  });

  it("closed=1 才是已解锁（'0' 不能被当成 truthy）", () => {
    const r = parseAchievementsXml(xml);
    expect(r.achievements[0].unlocked).toBe(true);
    expect(r.achievements[1].unlocked).toBe(false);
  });

  it("unlockTimestamp 秒 → 毫秒；0 表示未解锁为 null", () => {
    const r = parseAchievementsXml(xml);
    expect(r.achievements[0].unlockTime).toBe(1700000000 * 1000);
    expect(r.achievements[1].unlockTime).toBeNull();
  });

  it("缺 apiname 的块被跳过（不产生脏数据）", () => {
    const broken = `<playerstats><privacyState>public</privacyState>
      <achievements><achievement><name>无 apiName</name></achievement></achievements>
    </playerstats>`;
    const r = parseAchievementsXml(broken);
    expect(r.achievements).toHaveLength(0);
  });

  it("name 缺失时回退用 apiName（界面不能空着）", () => {
    const noName = `<playerstats><privacyState>public</privacyState>
      <achievements><achievement><apiname>ACH_X</apiname><closed>0</closed></achievement></achievements>
    </playerstats>`;
    const r = parseAchievementsXml(noName);
    expect(r.achievements[0].name).toBe("ACH_X");
  });
});
