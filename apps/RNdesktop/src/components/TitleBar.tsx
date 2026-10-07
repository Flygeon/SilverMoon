import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { bridgeStatus, onBridgeStatus, pingHost } from '../bridge';
import type { BridgeStatus } from '../bridge/types';
import { metrics, spacing, typography } from '../theme/tokens';
import { useColors } from '../theme';

/**
 * 自绘标题栏。
 *
 * 现有 Electron 端用的是「无边框窗口 + 自绘标题栏」，RN 桌面端沿用同一形态：
 * 原生侧只负责把窗口设成无边框并暴露拖拽区域，标题栏本身由 JS 画。
 * 骨架阶段只做**展示**，窗口按钮（最小化 / 最大化 / 关闭）留空 —— 它们要走
 * `window:control` 宿主通道，等原生桥落地后再接。
 */

const STATUS_TEXT: Record<BridgeStatus, string> = {
  connecting: '连接中',
  connected: '已连接',
  mock: '预览模式',
  unavailable: '未连接',
};

const STATUS_DOT: Record<BridgeStatus, 'success' | 'warning' | 'error' | 'disabled'> = {
  connecting: 'warning',
  connected: 'success',
  mock: 'warning',
  unavailable: 'error',
};

export function TitleBar(): React.JSX.Element {
  const colors = useColors();
  const [status, setStatus] = useState<BridgeStatus>(bridgeStatus());

  useEffect(() => {
    const off = onBridgeStatus(setStatus);
    // 启动时探一次存活：失败也不抛（pingHost 内部已吞掉异常），只把状态打到指示灯上
    pingHost().catch(() => undefined);
    return off;
  }, []);

  const dotColor =
    STATUS_DOT[status] === 'success'
      ? colors.success
      : STATUS_DOT[status] === 'warning'
      ? colors.warning
      : STATUS_DOT[status] === 'error'
      ? colors.error
      : colors.disabled;

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: colors.surfaceContainer, borderBottomColor: colors.outlineVariant },
      ]}
      accessibilityRole="header">
      <Text style={[styles.brand, { color: colors.onSurface }]}>银月 SilverMoon</Text>
      <View style={styles.spacer} />
      <View style={styles.status}>
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
        <Text style={[styles.statusText, { color: colors.onSurfaceVariant }]}>
          {STATUS_TEXT[status]}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    height: metrics.titleBarHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  brand: {
    ...typography.label,
    letterSpacing: 0.4,
  },
  spacer: { flex: 1 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    ...typography.caption,
  },
});
