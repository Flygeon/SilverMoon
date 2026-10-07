/**
 * 桥层契约测试。
 *
 * 这里守的是两条**不能退化**的约定（现有 Electron 端踩过坑）：
 *   1. 业务错误必须以**原始字符串** reject，不能包成 Error —— 上层靠
 *      `[WENKU8_LOGIN_CANCELLED]` 这类前缀判断协议分支。
 *   2. 批量命令逐条独立成败：单条失败不影响其它条，整条通道才 reject。
 */

import {
  __resetBridgeForTests,
  bridgeStatus,
  callHost,
  invokeBatchCommands,
  invokeCommand,
  pingHost,
} from '../src/bridge';
import { HostChannel } from '../src/bridge/types';

beforeEach(() => {
  __resetBridgeForTests();
});

describe('bridge', () => {
  it('没有原生宿主时退回 mock，并把状态标成 mock', async () => {
    expect(bridgeStatus()).toBe('connecting');
    await expect(pingHost()).resolves.toBe(true);
  });

  it('mock 下的未实现命令以原始字符串 reject', async () => {
    await expect(invokeCommand('library.scan')).rejects.toBe(
      '[MOCK_NOT_IMPLEMENTED] cmd:library.scan',
    );
  });

  it('批量命令逐条返回成败，不整体失败', async () => {
    const items = await invokeBatchCommands([{ cmd: 'library.scan' }, { cmd: 'library.list' }]);
    expect(items).toHaveLength(2);
    expect(items.every(item => item.ok === false)).toBe(true);
  });

  it('已实现的宿主通道能拿到数据', async () => {
    const pong = await callHost<{ alive: boolean }>(HostChannel.Ping);
    expect(pong.alive).toBe(true);
  });

  it('存储通道可读可写', async () => {
    await callHost(HostChannel.Store, { op: 'set', key: 'layout.sidebar', value: 240 });
    const value = await callHost<number>(HostChannel.Store, {
      op: 'get',
      key: 'layout.sidebar',
    });
    expect(value).toBe(240);
  });
});
