/// 循环模式。顺序播放 = off、列表循环 = all、单曲循环 = one。
enum RepeatMode {
  off('off', '顺序播放'),
  all('all', '列表循环'),
  one('one', '单曲循环');

  const RepeatMode(this.id, this.label);

  final String id;
  final String label;

  RepeatMode get next => RepeatMode.values[(index + 1) % RepeatMode.values.length];

  static RepeatMode fromId(String? v) {
    for (final m in RepeatMode.values) {
      if (m.id == v) return m;
    }
    return RepeatMode.off;
  }
}

/// 背景模式（对应 settings.playerBg）
enum PlayerBackground {
  animated('animated', '流体'),
  amll('amll', 'AMLL 网格'),
  image('image', '封面'),
  off('off', '关闭');

  const PlayerBackground(this.id, this.label);

  final String id;
  final String label;

  static PlayerBackground fromId(String? v) {
    for (final b in PlayerBackground.values) {
      if (b.id == v) return b;
    }
    return PlayerBackground.animated;
  }
}
