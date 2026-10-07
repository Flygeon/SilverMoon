import { HOST_UNAVAILABLE } from './types';

/**
 * 桥层错误。**注意**：业务错误的 reject 值是原始字符串而不是 Error 实例，
 * 这个类只用于「宿主本身不可用」这类框架级故障，便于调用方 `instanceof` 区分。
 */
export class HostUnavailableError extends Error {
  readonly code = HOST_UNAVAILABLE;

  constructor(detail: string) {
    super(`${HOST_UNAVAILABLE} ${detail}`);
    this.name = 'HostUnavailableError';
  }
}

/** 判断一个 reject 值是否表示「宿主不可用」。 */
export function isHostUnavailable(error: unknown): boolean {
  if (error instanceof HostUnavailableError) return true;
  return typeof error === 'string' && error.startsWith(HOST_UNAVAILABLE);
}

/** 把任意 reject 值转成可展示的字符串（业务错误本身就是字符串）。 */
export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
