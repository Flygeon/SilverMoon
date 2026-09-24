/**
 * 主进程内部共享引用。
 *
 * 存在的唯一理由是**打断循环依赖**：`ipc.ts` 需要调用侧车，而侧车又由 `main.ts`
 * 创建；把这份引用单独放一个模块，两边都只依赖它。
 */
import type { CommandReply, Sidecar } from "./sidecar";

let ref: Sidecar | null = null;

/** 由 `main.ts` 注入侧车实例。 */
export function setSidecar(instance: Sidecar | null): void {
  ref = instance;
}

/** 取侧车实例（可能为 null，表示尚未启动）。 */
export function getSidecar(): Sidecar | null {
  return ref;
}

/** 调用 Rust 命令；侧车不可用时返回明确的错误。 */
export async function callSidecar(cmd: string, args: unknown): Promise<CommandReply> {
  if (!ref) {
    return { ok: false, error: "后端未启动：Rust 侧车不可用" };
  }
  return ref.callCommand(cmd, args);
}
