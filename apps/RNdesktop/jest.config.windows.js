/**
 * Windows 平台的 Jest 配置。
 *
 * RNW 模板默认是 `require('@rnx-kit/jest-preset')('windows', config)`，
 * 但那会给骨架阶段平白多引入一个依赖；RN 自带的 `react-native` preset 已经能正确
 * 解析 `.windows.js` 后缀的平台文件，所以这里直接复用根配置。
 * 等真的需要 rnx-kit 的平台解析能力时再换回去。
 */
module.exports = {
  ...require('./jest.config'),
  // Windows 平台优先解析 *.windows.js
  haste: { defaultPlatform: 'windows', platforms: ['windows', 'native'] },
  moduleFileExtensions: [
    'windows.ts',
    'windows.tsx',
    'windows.js',
    'ts',
    'tsx',
    'js',
    'jsx',
    'json',
    'node',
  ],
};
