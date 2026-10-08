/**
 * 启动器握手协议的测试。
 *
 * 覆盖**最容易出错的纯逻辑**：命令行解析与失败降级。
 * 真正连 Windows 命名管道的端到端验证在 CI 的 Windows runner 上做；
 * 单测保证「不给启动器传错参数、失败不卡住应用」。
 */
import { describe, expect, it } from "vitest";

import { splashPipeName } from "../splash";

/// 运行时值 = \\.\pipe\sm-1（写成四个反斜杠是为了在源码里得到两个）
const PIPE = "\\\\\\\\.\\\\pipe\\\\sm-1";

describe("splashPipeName", () => {
  it("取出 --splash-pipe= 的值", () => {
    expect(splashPipeName(["electron", `--splash-pipe=${PIPE}`, "x"])).toBe(PIPE);
  });

  it("没有该参数时返回 null（开发态直接启动）", () => {
    expect(splashPipeName(["electron", "."])).toBeNull();
  });

  it("参数为空值时返回 null，而不是空字符串", () => {
    expect(splashPipeName(["electron", "--splash-pipe="])).toBeNull();
    expect(splashPipeName(["electron", "--splash-pipe=   "])).toBeNull();
  });

  it("相似前缀不应误命中", () => {
    expect(splashPipeName(["electron", "--splash-pipe-x=1"])).toBeNull();
  });

  it("裸管道名也接受（不强制带 \\\\.\\pipe\\ 前缀）", () => {
    expect(splashPipeName(["electron", "--splash-pipe=silvermoon-1-2"])).toBe("silvermoon-1-2");
  });
});
