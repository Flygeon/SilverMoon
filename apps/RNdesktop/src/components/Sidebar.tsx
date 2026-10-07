import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '../navigation';
import { ROUTE_GROUPS, routesInGroup, type RouteDef } from '../navigation/routes';
import { metrics, radius, spacing, typography } from '../theme/tokens';
import { useColors } from '../theme';

/**
 * 左侧导航栏。按分组渲染 `ROUTES`，选中项用 `secondaryContainer` 高亮
 * （MD3 的 navigation drawer 选中态用色）。
 *
 * 折叠态、拖拽调宽、记忆宽度都留到后面接 `store:kv` 时再做 —— 骨架阶段
 * 先把信息架构立住。
 */
export function Sidebar(): React.JSX.Element {
  const colors = useColors();
  const { current, navigate } = useNavigation();

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: colors.surfaceContainerLow, borderRightColor: colors.outlineVariant },
      ]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {ROUTE_GROUPS.map(group => {
          const items = routesInGroup(group);
          if (items.length === 0) return null;
          return (
            <View key={group} style={styles.group}>
              <Text style={[styles.groupTitle, { color: colors.onSurfaceVariant }]}>{group}</Text>
              {items.map(item => (
                <SidebarItem
                  key={item.id}
                  route={item}
                  active={item.id === current.id}
                  onPress={() => navigate(item.id)}
                />
              ))}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

interface SidebarItemProps {
  route: RouteDef;
  active: boolean;
  onPress: () => void;
}

function SidebarItem({ route, active, onPress }: SidebarItemProps): React.JSX.Element {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={route.title}
      style={({ pressed }) => [
        styles.item,
        {
          backgroundColor: active
            ? colors.secondaryContainer
            : pressed
            ? colors.surfaceContainerHigh
            : 'transparent',
        },
      ]}>
      <Text style={styles.glyph}>{route.glyph}</Text>
      <Text
        numberOfLines={1}
        style={[
          styles.itemLabel,
          { color: active ? colors.onSecondaryContainer : colors.onSurface },
        ]}>
        {route.title}
      </Text>
      {route.online ? (
        <Text style={[styles.badge, { color: colors.onSurfaceVariant }]}>可选</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    width: metrics.sidebarWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  scroll: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    gap: spacing.md,
  },
  group: {
    gap: 2,
  },
  groupTitle: {
    ...typography.caption,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    height: 32,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.full,
  },
  glyph: {
    fontSize: 15,
  },
  itemLabel: {
    ...typography.label,
    flex: 1,
  },
  badge: {
    ...typography.caption,
  },
});
