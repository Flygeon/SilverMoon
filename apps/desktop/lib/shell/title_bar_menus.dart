import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../i18n/sm_strings.dart';
import '../state/app_state.dart';
import '../theme/app_theme.dart';

/// 标题栏上的外观菜单（跟随系统 / 浅色 / 深色）。
class ThemeMenuButton extends StatelessWidget {
  const ThemeMenuButton({super.key});

  @override
  Widget build(BuildContext context) {
    final AppState state = context.watch<AppState>();
    final SmStrings sm = state.strings;

    return PopupMenuButton<ThemeMode>(
      tooltip: sm.t('titlebar.appearance'),
      position: PopupMenuPosition.under,
      icon: Icon(Icons.palette_outlined, size: 20, color: context.scheme.onSurfaceVariant),
      onSelected: (ThemeMode mode) => context.read<AppState>().setThemeMode(mode),
      itemBuilder: (BuildContext context) => <PopupMenuEntry<ThemeMode>>[
        _item(context, state, sm, ThemeMode.system, Icons.brightness_auto, 'titlebar.themeSystem'),
        _item(context, state, sm, ThemeMode.light, Icons.light_mode, 'titlebar.themeLight'),
        _item(context, state, sm, ThemeMode.dark, Icons.dark_mode, 'titlebar.themeDark'),
      ],
    );
  }

  PopupMenuItem<ThemeMode> _item(
    BuildContext context,
    AppState state,
    SmStrings sm,
    ThemeMode mode,
    IconData icon,
    String labelKey,
  ) {
    final bool active = state.themeMode == mode;
    return PopupMenuItem<ThemeMode>(
      value: mode,
      child: Row(
        children: <Widget>[
          Icon(icon, size: 18),
          const SizedBox(width: 10),
          SizedBox(
            width: 104,
            child: Text(sm.t(labelKey), maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
          if (active) Icon(Icons.check, size: 16, color: context.scheme.primary),
        ],
      ),
    );
  }
}

/// 标题栏上的语言菜单。
///
/// P0 阶段的临时入口：Electron 版把语言开关放在设置页里，这里先提到标题栏，
/// 方便逐页核对 zh / en 文案；接入设置页后本控件移除。
class LanguageMenuButton extends StatelessWidget {
  const LanguageMenuButton({super.key});

  @override
  Widget build(BuildContext context) {
    final AppState state = context.watch<AppState>();
    final SmStrings sm = state.strings;

    return PopupMenuButton<String>(
      tooltip: sm.t('titlebar.language'),
      position: PopupMenuPosition.under,
      icon: Icon(Icons.translate, size: 20, color: context.scheme.onSurfaceVariant),
      onSelected: (String code) => context.read<AppState>().setLocale(Locale(code)),
      itemBuilder: (BuildContext context) => <PopupMenuEntry<String>>[
        _item(context, state, 'zh', '简体中文'),
        _item(context, state, 'en', 'English'),
      ],
    );
  }

  PopupMenuItem<String> _item(BuildContext context, AppState state, String code, String label) {
    final bool active = state.locale.languageCode == code;
    return PopupMenuItem<String>(
      value: code,
      child: Row(
        children: <Widget>[
          SizedBox(
            width: 104,
            child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
          if (active) Icon(Icons.check, size: 16, color: context.scheme.primary),
        ],
      ),
    );
  }
}
