import { errorText, HostUnavailableError } from './errors';
import { createMockBridge } from './mock';
import type { BatchItemResult, BridgeStatus, CommandCall, SilverMoonHostBridge } from './types';

/**
 * 桥的**唯一出入口**。上层只认这里导出的函数，不直接碰原生模块，
 * 于是「原生桥没接好」只会退化成 mock 模式，而不是整页崩掉。
 *
 * 原生模块的接入点见 `resolveHostBridge()`：等 Windows / macOS 的 TurboModule
 * 落地后，在这里 `require` 到 `NativeModules.SilverMoonHost` 即可，
 * 上层一行都不用改。
 */

let bridge: SilverMoonHostBridge | null = null;
let status: BridgeStatus = 'connecting';
const statusListeners = new Set<(s: BridgeStatus) => void>();

/** 探测原生宿主桥；没有就退回 mock（开发 / 预览模式）。 */
function resolveHostBridge(): SilverMoonHostBridge | null {
  // TODO(原生桥): 接入 TurboModule
  //   Windows: windows/SilverMoon/SilverMoonHost  → NativeSilverMoonHost
  //   macOS:   macos/SilverMoon-macOS/SilverMoonHost.mm
  // 形如：
  //   const { SilverMoonHost } = require("react-native").NativeModules;
  //   if (SilverMoonHost) return adaptTurboModule(SilverMoonHost);
  return null;
}

function ensureBridge(): SilverMoonHostBridge {
  if (bridge) return bridge;
  const native = resolveHostBridge();
  if (native) {
    bridge = native;
    setStatus('connected');
    return bridge;
  }
  if (__DEV__) {
    bridge = createMockBridge();
    setStatus('mock');
    return bridge;
  }
  setStatus('unavailable');
  throw new HostUnavailableError('未检测到 SilverMoon 原生宿主，且非开发模式无法退回 mock');
}

function setStatus(next: BridgeStatus): void {
  if (status === next) return;
  status = next;
  statusListeners.forEach(listener => listener(next));
}

/** 当前连接状态。 */
export function bridgeStatus(): BridgeStatus {
  return status;
}

/** 订阅连接状态变化，返回取消订阅函数。 */
export function onBridgeStatus(listener: (s: BridgeStatus) => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

/** 桥是否可用（mock 也算可用：骨架阶段要让界面跑起来）。 */
export function hasBridge(): boolean {
  try {
    ensureBridge();
    return true;
  } catch {
    return false;
  }
}

/** 当前窗口标识。 */
export function currentLabel(): string {
  return bridge?.label ?? 'main';
}

/** 宿主平台标识。 */
export function hostPlatform(): string {
  return bridge?.platform ?? 'unknown';
}

/**
 * 调用 Rust 侧车命令。失败时以**原始错误字符串**拒绝（与 apps/desktop 一致）。
 */
export async function invokeCommand<T = unknown>(cmd: string, args?: unknown): Promise<T> {
  const reply = await ensureBridge().invoke<T>(cmd, args ?? {});
  if (!reply.ok) {
    return Promise.reject(reply.error ?? `命令 ${cmd} 失败`);
  }
  return reply.data as T;
}

/** 一次往返执行多条命令；单条失败体现为该下标的 `{ ok: false }`。 */
export async function invokeBatchCommands<T = unknown>(
  calls: CommandCall[],
): Promise<BatchItemResult<T>[]> {
  if (calls.length === 0) return [];
  const reply = await ensureBridge().invokeBatch(calls);
  if (!reply.ok) {
    return Promise.reject(reply.error ?? '批量命令失败');
  }
  return (reply.data ?? []) as BatchItemResult<T>[];
}

/** 调用宿主能力。失败时以原始错误字符串拒绝。 */
export async function callHost<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const reply = await ensureBridge().call<T>(channel, payload ?? {});
  if (!reply.ok) {
    return Promise.reject(reply.error ?? `${channel} 调用失败`);
  }
  return reply.data as T;
}

/** 跨窗口派发事件。 */
export async function emitToWindow(label: string, event: string, payload: unknown): Promise<void> {
  await ensureBridge().emitTo(label, event, payload);
}

/** 订阅侧车事件。 */
export function subscribeEvent(event: string, listener: (payload: unknown) => void): () => void {
  return ensureBridge().subscribe(event, listener);
}

/** 存活探测，供标题栏指示灯使用。 */
export async function pingHost(): Promise<boolean> {
  try {
    const data = await callHost<{ alive?: boolean }>('host:ping');
    setStatus('connected');
    return data?.alive === true;
  } catch (error) {
    if (__DEV__) {
      // mock 模式下 ping 是通的，失败说明宿主真的没起来
      setStatus('unavailable');
    }
    console.warn('[bridge] ping 失败:', errorText(error));
    return false;
  }
}

/** 仅测试用：重置桥与状态。 */
export function __resetBridgeForTests(): void {
  bridge = null;
  status = 'connecting';
  statusListeners.clear();
}
