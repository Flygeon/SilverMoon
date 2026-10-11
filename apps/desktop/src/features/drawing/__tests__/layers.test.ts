/**
 * 图层 sidecar 的纯逻辑测试。
 *
 * parseLayersFile 是 sidecar 可信度的唯一门卫：坏一半的数据必须整份丢弃，
 * 让打开画作回退到「整图当底图」的兼容模式，而不是赌半份数据。
 */
import { describe, expect, it } from "vitest";
import { parseLayersFile } from "../layers";
import { layerText } from "../layerText";

describe("parseLayersFile", () => {
  const good = {
    version: 1,
    layers: [
      { name: "图层 1", visible: true, data: { tag: "Group", children: [] } },
      { name: "图层 2", visible: false, data: { tag: "Group", children: [] } },
    ],
  };

  it("合法 sidecar 原样通过", () => {
    const r = parseLayersFile(good);
    expect(r).not.toBeNull();
    expect(r!.layers).toHaveLength(2);
    expect(r!.layers[1].visible).toBe(false);
  });

  it("版本号不对 / 层数组为空 → null", () => {
    expect(parseLayersFile({ version: 2, layers: good.layers })).toBeNull();
    expect(parseLayersFile({ version: 1, layers: [] })).toBeNull();
    expect(parseLayersFile({ version: 1 })).toBeNull();
  });

  it("单层形态不对 → 整份 null（不抢救半份数据）", () => {
    expect(
      parseLayersFile({
        version: 1,
        layers: [
          { name: "图层 1", visible: true, data: {} },
          { name: 42, visible: true },
        ],
      }),
    ).toBeNull();
    expect(parseLayersFile({ version: 1, layers: [{ name: "x", visible: "yes" }] })).toBeNull();
  });

  it("非对象输入 → null", () => {
    expect(parseLayersFile(null)).toBeNull();
    expect(parseLayersFile("not json")).toBeNull();
    expect(parseLayersFile(42)).toBeNull();
  });
});

describe("layerText", () => {
  it("中英文都有值，缺 key 原样返回", () => {
    expect(layerText("zh", "draw.layers")).toBe("图层");
    expect(layerText("en", "draw.layers")).toBe("Layers");
    expect(layerText("zh", "draw.cannotDeleteLastLayer")).toContain("至少保留");
    expect(layerText("fr", "draw.layers")).toBe("图层"); // 非 en 回退中文
    expect(layerText("zh", "draw.noSuchKey")).toBe("draw.noSuchKey");
  });
});
