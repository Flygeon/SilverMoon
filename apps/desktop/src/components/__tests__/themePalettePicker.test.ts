// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createApp, type App } from "vue";
import { cssTokensFromSeed } from "@shared/m3-theme";
import ThemePalettePicker from "../ThemePalettePicker.vue";

let app: App | undefined;
let host: HTMLDivElement;
const select = vi.fn();
const system = vi.fn();
function mount(props: Record<string, unknown> = {}) {
  app?.unmount();
  host?.remove();
  host = document.createElement("div");
  document.body.append(host);
  app = createApp(ThemePalettePicker, {
    seed: "#1A5C9E",
    source: "manual",
    dark: false,
    lang: "zh",
    onSelect: select,
    onSystem: system,
    ...props,
  });
  app.mount(host);
}
function option(key: string) {
  return host.querySelector<HTMLElement>('[data-palette="' + key + '"]')!;
}
afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  vi.clearAllMocks();
});

it("使用 M3E 按钮显示实际生成的三色，并标记唯一选中方案", () => {
  mount();
  expect(host.querySelectorAll("m3e-button")).toHaveLength(8);
  expect(host.querySelectorAll(".palette-disc > .primary")).toHaveLength(8);
  const blue = option("blue");
  const colors = cssTokensFromSeed("#1A5C9E", false);
  for (const role of ["primary", "secondary", "tertiary"]) {
    expect(blue.style.getPropertyValue("--sw-" + role)).toBe(
      colors["--md-sys-color-" + role + "-container"],
    );
  }
  expect(host.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  expect(blue.getAttribute("aria-current")).toBe("true");
});

it("点击预设输出种子色", () => {
  mount();
  option("green").click();
  expect(select).toHaveBeenCalledExactlyOnceWith("#4C662B");
  expect(system).not.toHaveBeenCalled();
});

it("系统取色不会同时选中相同色值的手动预设", () => {
  mount({ source: "system", systemSeed: "#1A5C9E" });
  expect(option("system").getAttribute("aria-current")).toBe("true");
  expect(option("blue").hasAttribute("aria-current")).toBe(false);
  expect(host.querySelectorAll('[aria-current="true"]')).toHaveLength(1);
  option("system").click();
  expect(system).toHaveBeenCalledOnce();
});

it("自定义方案保留原生取色器入口并输出新颜色", () => {
  mount({ seed: "#246849" });
  expect(option("custom").getAttribute("aria-current")).toBe("true");
  const input = host.querySelector<HTMLInputElement>('input[type="color"]')!;
  const click = vi.spyOn(input, "click");
  option("custom").click();
  expect(click).toHaveBeenCalledOnce();
  input.value = "#925182";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(select).toHaveBeenCalledExactlyOnceWith("#925182");
});

it("皮肤锁定时，所有入口均禁止修改配色", () => {
  mount({ disabled: true, systemSeed: "#00696E" });
  for (const button of host.querySelectorAll<HTMLElement>("m3e-button")) {
    expect(button.hasAttribute("disabled")).toBe(true);
    button.click();
  }
  const input = host.querySelector<HTMLInputElement>("input")!;
  expect(input.disabled).toBe(true);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(select).not.toHaveBeenCalled();
  expect(system).not.toHaveBeenCalled();
});

it("切换明暗使用对应色板而不是固定预览色", () => {
  mount();
  const light = option("blue").style.getPropertyValue("--sw-primary");
  mount({ dark: true });
  const dark = option("blue").style.getPropertyValue("--sw-primary");
  expect(dark).toBe(cssTokensFromSeed("#1A5C9E", true)["--md-sys-color-primary-container"]);
  expect(dark).not.toBe(light);
});

it("支持英文标签并以不区分大小写的色值识别预设", () => {
  mount({ lang: "en", seed: "#1a5c9e" });
  expect(option("blue").getAttribute("aria-label")).toBe("Ocean");
  expect(option("blue").getAttribute("aria-current")).toBe("true");
  expect(option("custom").hasAttribute("aria-current")).toBe(false);
});
