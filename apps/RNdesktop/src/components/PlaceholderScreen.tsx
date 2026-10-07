import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { RouteDef } from '../navigation/routes';
import { radius, spacing, typography } from '../theme/tokens';
import { useColors } from '../theme';

/**
 * 占位屏。
 *
 * 骨架阶段的每个路由都渲染它：**显式**写明「功能待填充」，
 * 而不是画一个看起来能用、点下去没反应的假界面。
 */
export interface PlaceholderScreenProps {
  route: RouteDef;
}

export function PlaceholderScreen({ route }: PlaceholderScreenProps): React.JSX.Element {
  const colors = useColors();
  return (
    <View style={styles.root}>
      <View
        style={[
          styles.card,
          {
            backgroundColor: colors.surfaceContainerLow,
            borderColor: colors.outlineVariant,
          },
        ]}>
        <Text style={styles.glyph}>{route.glyph}</Text>
        <Text style={[styles.title, { color: colors.onSurface }]}>{route.title}</Text>
        <Text style={[styles.summary, { color: colors.onSurfaceVariant }]}>{route.summary}</Text>
        <View style={[styles.tag, { backgroundColor: colors.primaryContainer }]}>
          <Text style={[styles.tagText, { color: colors.onPrimaryContainer }]}>
            框架占位 · 功能待填充
          </Text>
        </View>
        {/* 必须用**单个表达式**拼成一整段文本：写成 `route: {route.id}` 时 RN 会拆成
            两个相邻文本节点，断言整串永远匹配不上（踩过一次）。 */}
        <Text style={[styles.meta, { color: colors.onSurfaceVariant }]}>
          {'route: ' + route.id}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    maxWidth: 520,
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  glyph: {
    fontSize: 40,
  },
  title: {
    ...typography.headline,
  },
  summary: {
    ...typography.body,
    textAlign: 'center',
  },
  tag: {
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
  },
  tagText: {
    ...typography.label,
  },
  meta: {
    ...typography.caption,
  },
});
