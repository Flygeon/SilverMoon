import type { BatchItemResult, BridgeReply, CommandCall, SilverMoonHostBridge } from './types';
import { HostChannel } from './types';

/**
 * **内存 mock 宿主**：不依赖任何原生模块，让 `src/` 全链路
 * （桥 → 状态 → 界面）在 Windows / macOS 原生工程就绪之前就能跑起来。
 *
 * 它只实现骨架阶段需要的少数几条命令；其余命令统一返回
 * `ok: false, error: "[MOCK_NOT_IMPLEMENTED] <cmd>"`，
 * 而不是静默成功 —— 免得把「还没接」伪装成「已经通了」。
 */
export interface MockBridgeOptions {
  /** 延迟多少毫秒后置为 connected，用来演示标题栏的连接中状态。 */
  latencyMs?: number;
  /** 预置的 KV 存储，模拟「上次退出时的布局」。 */
  store?: Record<string, unknown>;
}

export function createMockBridge(options: MockBridgeOptions = {}): SilverMoonHostBridge {
  const { latencyMs = 120 } = options;
  const store: Record<string, unknown> = { ...(options.store ?? {}) };
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const startedAt = Date.now();

  const notImplemented = (name: string): BridgeReply => ({
    ok: false,
    error: `[MOCK_NOT_IMPLEMENTED] ${name}`,
  });

  const handleCall = (channel: string, payload: unknown): BridgeReply => {
    switch (channel) {
      case HostChannel.Ping:
        return { ok: true, data: { alive: true, uptimeMs: Date.now() - startedAt } };
      case HostChannel.AppInfo:
        return {
          ok: true,
          data: {
            name: 'SilverMoon',
            version: '0.1.0',
            platform: 'mock',
            mock: true,
          },
        };
      case HostChannel.Store: {
        const { op, key, value } = (payload ?? {}) as {
          op?: 'get' | 'set' | 'remove';
          key?: string;
          value?: unknown;
        };
        if (!key) return { ok: false, error: '[MOCK_BAD_REQUEST] store:kv 缺少 key' };
        if (op === 'set') {
          store[key] = value;
          return { ok: true, data: value };
        }
        if (op === 'remove') {
          delete store[key];
          return { ok: true, data: null };
        }
        return { ok: true, data: store[key] ?? null };
      }
      case HostChannel.Window:
      case HostChannel.Dialog:
      case HostChannel.Opener:
        return notImplemented(channel);
      default:
        return notImplemented(channel);
    }
  };

  return {
    label: 'main',
    platform: 'mock',
    hostVersion: 'mock-0.1.0',
    async invoke<T>(cmd: string, _args: unknown) {
      await delay(latencyMs);
      return notImplemented(`cmd:${cmd}`) as BridgeReply<T>;
    },
    async invokeBatch(calls: CommandCall[]) {
      await delay(latencyMs);
      const items: BatchItemResult[] = calls.map(call => ({
        ok: false,
        error: `[MOCK_NOT_IMPLEMENTED] cmd:${call.cmd}`,
      }));
      return { ok: true, data: items };
    },
    async call<T>(channel: string, payload: unknown) {
      await delay(latencyMs);
      return handleCall(channel, payload) as BridgeReply<T>;
    },
    async emitTo() {
      /* mock 下没有第二个窗口，静默忽略 */
    },
    subscribe(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => {
        set.delete(listener);
      };
    },
    assetBase: undefined,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
