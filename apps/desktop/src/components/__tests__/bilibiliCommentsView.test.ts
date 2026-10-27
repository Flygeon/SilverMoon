// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick, reactive, type App } from "vue";
import BilibiliComments from "../BilibiliComments.vue";

const actions = vi.hoisted(() => ({
  loadReplies: vi.fn(),
  loadMoreReplies: vi.fn(),
  loadSubReplies: vi.fn(),
  toggleReplyLike: vi.fn(),
  replyToComment: vi.fn(),
}));
const reply = {
  rpid: "root",
  author: { name: "Reader", avatar: "", level: 0, vip: false },
  message: "Existing comment",
  liked: true,
  like: 12,
  replyCount: 1,
  replies: [
    {
      rpid: "child",
      author: { name: "Guest" },
      message: "Nested comment",
      liked: false,
      like: 2,
    },
  ],
};
const bili = reactive({
  ...actions,
  replies: [reply],
  replyTotal: 1,
  replySort: 3,
  replyStatus: "ready",
  replyError: "",
  replyEnd: false,
  replyLoadingMore: false,
  replyBlockedCount: 0,
  subReplies: {} as Record<string, typeof reply.replies>,
  subEnds: {} as Record<string, boolean>,
  subBusy: {} as Record<string, boolean>,
  acting: {} as Record<string, boolean>,
  antifraudChecking: false,
  antifraudResult: null,
});
vi.mock("@/stores/bilibili", () => ({ useBiliStore: () => bili }));
vi.mock("@/stores/settings", () => ({ useSettingsStore: () => ({ lang: "en" }) }));
vi.mock("@/components/BilibiliReplyComposer.vue", () => ({
  default: {
    setup(_: unknown, { expose }: { expose: (value: unknown) => void }) {
      expose({ replyToComment: actions.replyToComment });
      return () => h("div");
    },
  },
}));

let app: App;
let host: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  bili.replies = [reply];
  bili.replyStatus = "ready";
  bili.replyError = "";
  bili.replyLoadingMore = false;
  bili.subReplies = {};
  bili.subEnds = {};
  bili.acting = {};
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(BilibiliComments) });
  app.mount(host);
});
afterEach(() => {
  app.unmount();
  host.remove();
});

it("点赞状态和忙碌态传给官方按钮，动作仍指向原评论", async () => {
  const like = host.querySelector<HTMLElement>(".acts m3e-button")!;
  expect(like.getAttribute("aria-pressed")).toBe("true");
  expect(like.getAttribute("variant")).toBe("tonal");
  like.click();
  expect(actions.toggleReplyLike).toHaveBeenCalledWith(bili.replies[0]);
  bili.acting["reply-like-root"] = true;
  await nextTick();
  expect(like.hasAttribute("disabled")).toBe(true);
  expect(host.querySelector("button")).toBeNull();
});

it("分页失败保留已有评论并提供原分页重试", async () => {
  bili.replyStatus = "error";
  bili.replyError = "Temporary failure";
  await nextTick();
  expect(host.querySelector(".text")?.textContent).toBe("Existing comment");
  expect(host.querySelector(".more-error")?.textContent).toContain("Temporary failure");
  const more = host.querySelector<HTMLElement>(".more m3e-button")!;
  more.click();
  expect(actions.loadMoreReplies).toHaveBeenCalledTimes(1);
  expect(actions.loadReplies).not.toHaveBeenCalled();
  bili.replyLoadingMore = true;
  await nextTick();
  expect(more.hasAttribute("disabled")).toBe(true);
});

it("楼中楼回复保持 root 和 parent，展开分页继续请求原楼层", async () => {
  host.querySelector<HTMLElement>(".sub-reply")!.click();
  expect(actions.replyToComment).toHaveBeenCalledWith("child", "root", "Guest");
  bili.subReplies.root = reply.replies;
  bili.subEnds.root = false;
  await nextTick();
  host.querySelector<HTMLElement>(".subs .link")!.click();
  expect(actions.loadSubReplies).toHaveBeenCalledWith("root", true);
});
