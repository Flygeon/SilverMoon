/**
 * 应用入口。
 *
 * 组件名必须与 app.json 的 `name` 以及**原生工程注册的组件名**一致：
 *   Windows: windows/SilverMoon/App.cpp        → L"SilverMoon"
 *   macOS:   macos/SilverMoon-macOS/AppDelegate.mm → moduleName @"SilverMoon"
 * 三处不一致时表现是白屏（RN 找不到注册过的根组件），不会报错。
 *
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './src/App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
