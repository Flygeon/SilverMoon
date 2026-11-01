import { expect, it, vi } from "vitest";
import { kugouRankCards } from "../kugou";

vi.mock("@/capabilities", () => ({ capabilities: {} }));

it("保留 rankid，不能把榜单 ID 当成期数 rank_cid", () => {
  const [rank] = kugouRankCards({ data: { info: [{ rankid: 8888, rankname: "热歌榜" }] } });
  expect(rank).toMatchObject({ id: "8888", rankId: "8888", rankCid: "" });
});

it("榜单同时返回 ID 和期数时独立保留，不能互相覆盖", () => {
  const [rank] = kugouRankCards({
    data: { info: [{ rankid: 8888, rank_cid: 123456, rankname: "热歌榜" }] },
  });
  expect(rank).toMatchObject({ id: "8888", rankId: "8888", rankCid: "123456" });
});

it("仅有期数的响应保持期数入口，不伪造榜单 ID", () => {
  const [rank] = kugouRankCards({ data: { info: [{ rank_cid: 123456, rankname: "热歌榜" }] } });
  expect(rank).toMatchObject({ id: "123456", rankId: "", rankCid: "123456" });
});
