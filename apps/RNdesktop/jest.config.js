module.exports = {
  preset: 'react-native',
  // 只跑本应用自己的测试：windows/ macos/ 是原生工程，node_modules 里是第三方用例
  roots: ['<rootDir>/__tests__', '<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.{ts,tsx}'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transformIgnorePatterns: [
    'node_modules/(?!(?:@react-native|react-native|react-native-windows)/)',
  ],
};
