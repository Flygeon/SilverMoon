/**
 * 骨架冒烟测试：应用能挂载、外壳渲染出侧栏分组、路由切换能生效。
 *
 * 用 react-test-renderer 而不是 @testing-library/react-native —— 后者要额外装依赖，
 * 骨架阶段不引入。等界面真的复杂起来再换。
 *
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../src/App';

// 标题栏挂载时会发一次存活探测（异步）。测试环境里让它**同步返回**，
// 否则回调会落在用例结束之后：Jest 拆掉环境后再触发 setState，
// 报的是「Cannot log after tests are done」这种与真实缺陷无关的噪音。
jest.mock('../src/bridge', () => {
  const actual = jest.requireActual('../src/bridge');
  return {
    ...actual,
    pingHost: jest.fn().mockResolvedValue(true),
  };
});

describe('SilverMoon 桌面外壳', () => {
  it('能挂载并渲染出应用名与侧栏分组', async () => {
    const tree = await renderApp();
    const texts = collectText(tree);
    expect(texts).toContain('银月 SilverMoon');
    expect(texts).toContain('本地媒体库');
    expect(texts).toContain('设置');
    await unmount(tree);
  });

  it('默认落在图片页，且占位屏显式标注功能待填充', async () => {
    const tree = await renderApp();
    const texts = collectText(tree);
    expect(texts).toContain('route: gallery');
    expect(texts).toContain('框架占位 · 功能待填充');
    // 占位屏只登记路由，不该渲染任何真实业务内容
    expect(texts.join('|')).not.toContain('MOCK');
    await unmount(tree);
  });

  it('侧栏切换路由后，内容区渲染的是目标页', async () => {
    const tree = await renderApp();

    // 找到侧栏里的「音乐」按钮并触发它的 onPress
    const music = tree.root.findAll(
      node => node.props.accessibilityLabel === '音乐' && typeof node.props.onPress === 'function',
    );
    const target = music[0];
    if (!target) throw new Error('侧栏里没有找到「音乐」入口');
    await ReactTestRenderer.act(() => {
      target.props.onPress();
    });

    const texts = collectText(tree);
    expect(texts).toContain('route: music');
    await unmount(tree);
  });
});

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree: ReactTestRenderer.ReactTestRenderer | undefined;
  await ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<App />);
  });
  if (!tree) throw new Error('渲染失败');
  return tree;
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(() => {
    tree.unmount();
  });
}

/**
 * 收集渲染树里的所有文本节点。
 *
 * 走 `toJSON()` 得到的宿主节点树递归展开：`root.findAll` 只返回**匹配的节点本身**，
 * 不会把命中节点的子文本带出来，按它拼文本会漏掉深层内容。
 */
function collectText(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const children = (node as { children?: unknown }).children;
    if (children !== undefined && children !== null) visit(children);
  };
  visit(tree.toJSON());
  return out;
}
