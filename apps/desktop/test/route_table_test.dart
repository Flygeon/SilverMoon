import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:silvermoon/i18n/sm_strings.dart';
import 'package:silvermoon/router/app_router.dart';

/// Electron 版 `src/router.ts` 的全部路由（含 `/` 重定向与三条顶层路由）。
const Set<String> _expectedPaths = <String>{
  '/',
  '/images',
  '/videos',
  '/music',
  '/music/player',
  '/books',
  '/folders',
  '/webdav',
  '/treasure',
  '/treasure/market',
  '/treasure/osu',
  '/favorites',
  '/history',
  '/stats',
  '/novel-stats',
  '/trash',
  '/settings',
  '/extensions',
  '/desktop-lyrics',
  '/extension-host',
};

/// 递归展开路由表，把子路由的相对 path 拼成完整路径。
void _walk(List<RouteBase> routes, String parent, Set<String> out) {
  for (final RouteBase route in routes) {
    String full = parent;
    if (route is GoRoute) {
      full = route.path.startsWith('/')
          ? route.path
          : (parent.endsWith('/') ? parent + route.path : parent + '/' + route.path);
      out.add(full);
    }
    if (route.routes.isNotEmpty) {
      _walk(route.routes, full, out);
    }
  }
}

void main() {
  test('路由表覆盖 Electron 版的全部路由，且没有多余的路径', () {
    final Set<String> actual = <String>{};
    _walk(buildAppRoutes(), '', actual);

    expect(actual, unorderedEquals(_expectedPaths));
  });

  test('i18n：zh / en 两侧 key 完全一致，且没有漏译（取回值不等于 key 本身）', () {
    final Set<String> zhKeys = SmStrings.keysOf('zh');
    final Set<String> enKeys = SmStrings.keysOf('en');

    expect(zhKeys, isNotEmpty);
    expect(enKeys, unorderedEquals(zhKeys));

    for (final String key in zhKeys) {
      expect(const SmStrings('zh').t(key), isNot(key), reason: 'zh 缺词条: ' + key);
      expect(const SmStrings('en').t(key), isNot(key), reason: 'en 缺词条: ' + key);
    }
  });
}
