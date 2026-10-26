// @vitest-environment jsdom
/* eslint-disable vue/one-component-per-file -- 每个测试独立挂载真实组件与响应式宿主。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, h, KeepAlive, nextTick, reactive, ref, type App } from "vue";
import SearchField from "../SearchField.vue";
import LibraryToolbar from "../LibraryToolbar.vue";

const library = reactive({
  search: "",
  sortBy: "name",
  sortDesc: false,
  scanning: false,
});
vi.mock("@/stores/library", () => ({ useLibraryStore: () => library }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "zh" }) }));

let app: App | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  library.search = "";
  host = document.createElement("div");
  document.body.append(host);
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  vi.useRealTimers();
});

function input() {
  return host.querySelector("input") as HTMLInputElement;
}
async function type(text: string) {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

describe("桌面搜索输入", () => {
  it("中文组合输入确认前不更新模型，确认候选词的 Enter 不提交搜索", async () => {
    const value = ref("");
    const submit = vi.fn();
    app = createApp({
      render: () =>
        h(SearchField, {
          modelValue: value.value,
          "onUpdate:modelValue": (text: string) => (value.value = text),
          placeholder: "搜索",
          clearLabel: "清除搜索",
          onSubmit: submit,
        }),
    });
    app.mount(host);
    input().dispatchEvent(new CompositionEvent("compositionstart"));
    await type("银月");
    expect(value.value).toBe("");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
    expect(submit).not.toHaveBeenCalled();
    input().dispatchEvent(new CompositionEvent("compositionend"));
    await nextTick();
    expect(value.value).toBe("银月");
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("连续输入只触发一次防抖查询", async () => {
    const changed = vi.fn();
    app = createApp({ render: () => h(LibraryToolbar, { count: 3, onChanged: changed }) });
    app.mount(host);
    await type("银");
    await vi.advanceTimersByTimeAsync(200);
    await type("银月");
    await vi.advanceTimersByTimeAsync(259);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(library.search).toBe("银月");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("外部清除同步输入框并取消旧查询，不重复发起搜索", async () => {
    library.search = "原查询";
    const changed = vi.fn();
    app = createApp({ render: () => h(LibraryToolbar, { count: 3, onChanged: changed }) });
    app.mount(host);
    await type("尚未提交");
    library.search = "";
    await nextTick();
    await vi.advanceTimersByTimeAsync(300);
    expect(input().value).toBe("");
    expect(library.search).toBe("");
    expect(changed).not.toHaveBeenCalled();
  });

  it("KeepAlive 离开页面取消防抖，返回时恢复已生效查询", async () => {
    const visible = ref(true);
    const changed = vi.fn();
    app = createApp({
      render: () =>
        h(KeepAlive, null, {
          default: () =>
            visible.value ? h(LibraryToolbar, { count: 3, onChanged: changed }) : null,
        }),
    });
    app.mount(host);
    await type("未提交");
    visible.value = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(300);
    expect(library.search).toBe("");
    expect(changed).not.toHaveBeenCalled();
    visible.value = true;
    await nextTick();
    expect(input().value).toBe("");
  });
});
