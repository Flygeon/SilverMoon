import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Sidebar, TitleBar } from '../components';
import { useNavigation } from '../navigation';
import { screenFor } from '../screens';
import { spacing } from '../theme/tokens';
import { useColors } from '../theme';

/**
 * 桌面外壳：标题栏 + 左侧栏 + 内容区。
 *
 * 布局是**固定**的（不是响应式自适应），因为桌面窗口的最小尺寸由原生侧限制；
 * 窄窗下的折叠行为等侧栏折叠态实现后一起做。
 */
export function DesktopShell(): React.JSX.Element {
  const colors = useColors();
  const { current } = useNavigation();
  const Screen = screenFor(current.id);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <TitleBar />
      <View style={styles.body}>
        <Sidebar />
        <View style={styles.content}>
          <Screen route={current} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: {
    flex: 1,
    flexDirection: 'row',
  },
  content: {
    flex: 1,
    padding: spacing.none,
  },
});
