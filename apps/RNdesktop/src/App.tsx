import React from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { NavigationProvider } from './navigation';
import { DesktopShell } from './shell';
import { ThemeProvider, useTheme } from './theme';

/**
 * 应用根组件。
 *
 * 骨架阶段只做三件事：装主题、装路由、渲染桌面外壳。
 * 任何业务状态（媒体库、播放器、在线源登录态）都还没有引入 —— 这是刻意的，
 * 免得框架和功能互相污染。
 */
function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <NavigationProvider>
        <ThemedApp />
      </NavigationProvider>
    </ThemeProvider>
  );
}

function ThemedApp(): React.JSX.Element {
  const { theme } = useTheme();
  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <StatusBar barStyle={theme.scheme === 'dark' ? 'light-content' : 'dark-content'} />
      <DesktopShell />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

export default App;
