// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { findSettingTarget } from "../settingsTarget";

describe("设置搜索定位", () => {
  it("显式锚点优先于同名存量标签", () => {
    const section = document.createElement("div");
    section.innerHTML =
      '<div class="row-label">主题</div><div data-setting="settings.theme">主题</div>';
    expect(findSettingTarget(section, "settings.theme", "主题")).toBe(section.lastElementChild);
  });
  it("缺少锚点的存量标签定位到整行，支持当前英文文案", () => {
    const section = document.createElement("div");
    section.innerHTML =
      '<m3e-list-item class="settings-option"><div class="row"><span class="row-label">Theme</span></div></m3e-list-item>';
    expect(findSettingTarget(section, "settings.theme", "Theme")).toBe(section.firstElementChild);
  });
  it("不会定位到其他分区的同名字段，隐藏项不伪造目标", () => {
    const section = document.createElement("div");
    const other = document.createElement("div");
    other.innerHTML = '<span class="row-label">主题</span>';
    document.body.append(other);
    try {
      expect(findSettingTarget(section, "settings.theme", "主题")).toBeNull();
    } finally {
      other.remove();
    }
  });
});
