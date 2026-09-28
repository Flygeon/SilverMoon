import 'package:flutter/material.dart';

void main() {
  runApp(const SilverMoonBootstrap());
}

/// Phase-1 引导壳：仅用于验证 CI 工具链（pub 解析 / 平台工程 / 打包）。
class SilverMoonBootstrap extends StatelessWidget {
  const SilverMoonBootstrap({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SilverMoon',
      theme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF1A5C9E),
        brightness: Brightness.light,
      ),
      darkTheme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF1A5C9E),
        brightness: Brightness.dark,
      ),
      home: const Scaffold(
        body: Center(child: Text('SilverMoon')),
      ),
    );
  }
}
