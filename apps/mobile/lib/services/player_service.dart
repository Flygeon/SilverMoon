import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart';

import '../models/audio_effect_config.dart';
import '../models/lyric.dart';
import '../models/play_mode.dart';
import '../models/track.dart';
import 'artwork_service.dart';
import 'audio_effects_service.dart';
import 'json_store.dart';
import 'lyric_parser.dart';
import 'music_repository.dart';

/// 播放器内核。
///
/// 语义严格对齐桌面端（apps/desktop/src/stores/player.ts）：
/// - 随机：整队列 Fisher-Yates，结果存进 shuffledIndices；队列任何变动都重算
/// - 单曲循环：next() 回到 0s，不消耗随机顺序
/// - setQueue / addToQueue 不自动开始播放（由调用方决定）
/// - playNext 插到 currentIndex + 1
/// - removeFromQueue 拒绝移除当前曲目
/// - clearQueue 只保留当前曲目
/// - 倍速循环 [1, 1.5, 2, 0.5, 0.75]
class PlayerService extends ChangeNotifier {
  PlayerService({MusicRepository? repository})
      : repository = repository ?? MusicRepository(),
        _store = JsonStore('playback-state.json') {
    _equalizer = AndroidEqualizer();
    _loudness = AndroidLoudnessEnhancer();
    _player = AudioPlayer(
      audioPipeline: AudioPipeline(
        androidAudioEffects: <AndroidAudioEffect>[_equalizer, _loudness],
      ),
    );
    effects = AudioEffectsService(equalizer: _equalizer, loudness: _loudness);
    _wire();
  }

  final MusicRepository repository;

  late final AudioPlayer _player;
  late final AndroidEqualizer _equalizer;
  late final AndroidLoudnessEnhancer _loudness;
  late final AudioEffectsService effects;

  final JsonStore _store;
  final Random _random = Random();

  StreamSubscription<PlayerState>? _stateSub;
  Timer? _tick;

  // ---- 队列状态 ----
  List<Track> _queue = <Track>[];
  int _currentIndex = -1;
  List<int> _shuffledIndices = <int>[];
  bool _shuffle = false;
  RepeatMode _repeatMode = RepeatMode.off;

  // ---- 播放状态 ----
  bool _playing = false;
  ProcessingState _processing = ProcessingState.idle;
  Duration _position = Duration.zero;
  Duration? _duration;
  double _volume = 1.0;
  double _speed = 1.0;
  String? _error;

  // ---- 歌词 ----
  Lyrics _lyrics = Lyrics.empty;
  String? _lyricTrackId;
  bool detectInstrumental = true;

  // ---- 位置平滑（just_audio 的 position 约 200ms 才刷新一次）----
  DateTime? _anchorAt;
  Duration _anchorPos = Duration.zero;

  bool _handlingCompletion = false;

  // ============================================================ 只读访问

  List<Track> get queue => List<Track>.unmodifiable(_queue);

  int get currentIndex => _currentIndex;

  Track? get currentTrack =>
      _currentIndex >= 0 && _currentIndex < _queue.length ? _queue[_currentIndex] : null;

  RepeatMode get repeatMode => _repeatMode;

  bool get shuffleEnabled => _shuffle;

  bool get playing => _playing;

  ProcessingState get processingState => _processing;

  Duration get position => _position;

  Duration? get duration => _duration;

  Duration? get effectiveDuration => _duration ?? currentTrack?.duration;

  double get volume => _volume;

  double get speed => _speed;

  String? get error => _error;

  Lyrics get lyrics => _lyrics;

  bool get hasQueue => _queue.isNotEmpty;

  bool get hasNext => _queue.length > 1 || _repeatMode != RepeatMode.off;

  bool get hasPrevious => _queue.length > 1;

  /// 当前应高亮的歌词行下标（-1 表示前奏）
  int get currentLyricIndex => _lyrics.indexAt(_position.inMilliseconds / 1000.0);

  double get progress {
    final Duration? d = effectiveDuration;
    if (d == null || d.inMilliseconds <= 0) return 0;
    final double v = _position.inMilliseconds / d.inMilliseconds;
    return v.clamp(0.0, 1.0);
  }

  // ============================================================== 初始化

  Future<void> init({
    double volume = 1.0,
    double speed = 1.0,
    AudioEffectConfig? effectsConfig,
    bool detectInstrumental = true,
    bool restoreLastSession = true,
  }) async {
    this.detectInstrumental = detectInstrumental;
    _volume = volume;
    _speed = speed;
    try {
      await _player.setVolume(volume);
      await _player.setSpeed(speed);
    } catch (_) {}
    if (effectsConfig != null) {
      await effects.init(effectsConfig);
    }
    if (restoreLastSession) {
      await restoreState();
    }
    notifyListeners();
  }

  void _wire() {
    _stateSub = _player.playerStateStream.listen((PlayerState s) {
      _playing = s.playing;
      _processing = s.processingState;
      if (s.processingState == ProcessingState.completed) {
        _onCompleted();
      }
      notifyListeners();
    });

    // 33ms 心跳：驱动歌词卡拉 OK 填充与进度条平滑推进
    _tick = Timer.periodic(const Duration(milliseconds: 33), (Timer t) {
      if (!_playing) return;
      _position = _smoothPosition();
      notifyListeners();
    });
  }

  /// 在 just_audio 最近一次上报的位置上做线性外推（上限 250ms），
  /// 让 33ms 心跳拿到足够平滑的位置，同时不会累积漂移。
  Duration _smoothPosition() {
    final Duration base = _player.position;
    final DateTime now = DateTime.now();
    if (_anchorAt == null || _anchorPos != base) {
      _anchorAt = now;
      _anchorPos = base;
      return base;
    }
    final int elapsed = now.difference(_anchorAt!).inMilliseconds;
    final int extra = elapsed < 0 ? 0 : (elapsed > 250 ? 250 : elapsed);
    return base + Duration(milliseconds: extra);
  }

  // ============================================================== 队列

  /// 载入新队列。autoPlay=false 时只预载不播放（对应桌面端 setQueue）。
  Future<void> setQueue(
    List<Track> tracks, {
    int startIndex = 0,
    bool autoPlay = true,
  }) async {
    _queue = List<Track>.from(tracks);
    _currentIndex = _queue.isEmpty ? -1 : startIndex.clamp(0, _queue.length - 1);
    if (_shuffle) _rebuildShuffle();
    _error = null;
    notifyListeners();
    if (_queue.isEmpty) {
      await _player.stop();
      _lyrics = Lyrics.empty;
      notifyListeners();
      return;
    }
    await _load(currentTrack!, autoPlay: autoPlay);
    await saveState();
  }

  Future<void> playAt(int index) async {
    if (index < 0 || index >= _queue.length) return;
    await _playAt(index);
  }

  /// 下一首播放：插到当前曲目之后
  Future<void> playNext(Track track) async {
    if (_queue.isEmpty) {
      await setQueue(<Track>[track]);
      return;
    }
    final int at = _currentIndex + 1;
    _queue.insert(at, track);
    if (_shuffle) {
      _insertIntoShuffle(at);
    } else if (_currentIndex >= at) {
      _currentIndex++;
    }
    notifyListeners();
    await saveState();
  }

  /// 加入队列末尾（不开始播放）
  Future<void> addToQueue(Track track) async {
    if (_queue.isEmpty) {
      _queue.add(track);
      _currentIndex = 0;
      _shuffledIndices = <int>[0];
      notifyListeners();
      await saveState();
      return;
    }
    final int at = _queue.length;
    _queue.add(track);
    if (_shuffle) {
      _shuffledIndices = <int>[..._shuffledIndices, at];
    }
    notifyListeners();
    await saveState();
  }

  /// 批量加入队列末尾
  Future<void> addAllToQueue(List<Track> tracks) async {
    if (tracks.isEmpty) return;
    if (_queue.isEmpty) {
      await setQueue(tracks, autoPlay: false);
      return;
    }
    for (final Track t in tracks) {
      final int at = _queue.length;
      _queue.add(t);
      if (_shuffle) _shuffledIndices = <int>[..._shuffledIndices, at];
    }
    notifyListeners();
    await saveState();
  }

  /// 从队列移除；拒绝移除当前曲目（与桌面端一致）
  Future<bool> removeFromQueue(int index) async {
    if (index < 0 || index >= _queue.length) return false;
    if (index == _currentIndex) return false;
    _queue.removeAt(index);
    if (index < _currentIndex) _currentIndex--;
    if (_shuffle) _syncShuffleAfterRemoval(index);
    notifyListeners();
    await saveState();
    return true;
  }

  /// 清空队列但保留当前曲目
  Future<void> clearQueue() async {
    if (_queue.isEmpty) return;
    final Track? cur = currentTrack;
    if (cur == null) {
      _queue = <Track>[];
      _currentIndex = -1;
      _shuffledIndices = <int>[];
      await _player.stop();
    } else {
      _queue = <Track>[cur];
      _currentIndex = 0;
      _shuffledIndices = <int>[0];
    }
    notifyListeners();
    await saveState();
  }

  /// 队列内拖拽排序
  Future<void> moveInQueue(int from, int to) async {
    if (from < 0 || from >= _queue.length) return;
    if (to < 0 || to >= _queue.length) return;
    if (from == to) return;
    final Track t = _queue.removeAt(from);
    _queue.insert(to, t);
    if (_currentIndex == from) {
      _currentIndex = to;
    } else if (from < _currentIndex && to >= _currentIndex) {
      _currentIndex--;
    } else if (from > _currentIndex && to <= _currentIndex) {
      _currentIndex++;
    }
    if (_shuffle) _rebuildShuffle();
    notifyListeners();
    await saveState();
  }

  // ============================================================== 随机

  void _rebuildShuffle() {
    final List<int> idx = List<int>.generate(_queue.length, (int i) => i);
    idx.shuffle(_random);
    if (_currentIndex >= 0 && _currentIndex < _queue.length) {
      idx.remove(_currentIndex);
      idx.insert(0, _currentIndex);
    }
    _shuffledIndices = idx;
  }

  void _insertIntoShuffle(int at) {
    final int pos = _shuffledIndices.indexOf(_currentIndex);
    final List<int> next =
        _shuffledIndices.map((int i) => i >= at ? i + 1 : i).toList();
    next.insert(pos < 0 ? 0 : pos + 1, at);
    _shuffledIndices = next;
  }

  void _syncShuffleAfterRemoval(int removed) {
    final List<int> next = <int>[];
    for (final int i in _shuffledIndices) {
      if (i == removed) continue;
      next.add(i > removed ? i - 1 : i);
    }
    _shuffledIndices = next;
  }

  Future<void> toggleShuffle() async {
    _shuffle = !_shuffle;
    if (_shuffle) _rebuildShuffle();
    notifyListeners();
  }

  Future<void> setShuffle(bool on) async {
    if (_shuffle == on) return;
    _shuffle = on;
    if (on) _rebuildShuffle();
    notifyListeners();
  }

  // ============================================================== 循环

  Future<void> cycleRepeat() async {
    _repeatMode = _repeatMode.next;
    notifyListeners();
  }

  Future<void> setRepeatMode(RepeatMode mode) async {
    _repeatMode = mode;
    notifyListeners();
  }

  // ============================================================ 切歌

  int? _computeNextIndex() {
    if (_queue.isEmpty || _currentIndex < 0) return null;
    if (_queue.length == 1) return _repeatMode == RepeatMode.all ? 0 : null;
    if (_shuffle) {
      final int pos = _shuffledIndices.indexOf(_currentIndex);
      if (pos >= 0 && pos + 1 < _shuffledIndices.length) {
        return _shuffledIndices[pos + 1];
      }
      if (_repeatMode == RepeatMode.all && _shuffledIndices.isNotEmpty) {
        return _shuffledIndices.first;
      }
      return null;
    }
    if (_currentIndex + 1 < _queue.length) return _currentIndex + 1;
    if (_repeatMode == RepeatMode.all) return 0;
    return null;
  }

  int? _computePrevIndex() {
    if (_queue.isEmpty || _currentIndex < 0) return null;
    if (_queue.length == 1) return null;
    if (_shuffle) {
      final int pos = _shuffledIndices.indexOf(_currentIndex);
      if (pos > 0) return _shuffledIndices[pos - 1];
      if (_repeatMode == RepeatMode.all && _shuffledIndices.isNotEmpty) {
        return _shuffledIndices.last;
      }
      return null;
    }
    if (_currentIndex > 0) return _currentIndex - 1;
    if (_repeatMode == RepeatMode.all) return _queue.length - 1;
    return null;
  }

  Future<void> next() async {
    if (_queue.isEmpty) return;
    // 单曲循环：回到 0s，不消耗随机顺序
    if (_repeatMode == RepeatMode.one) {
      await _player.seek(Duration.zero);
      _position = Duration.zero;
      await _player.play();
      notifyListeners();
      return;
    }
    final int? n = _computeNextIndex();
    if (n == null) {
      await _player.pause();
      await _player.seek(Duration.zero);
      _position = Duration.zero;
      notifyListeners();
      return;
    }
    await _playAt(n);
  }

  Future<void> previous() async {
    if (_queue.isEmpty) return;
    // 播放超过 3 秒：先回到本曲开头（与桌面端一致）
    if (_player.position.inSeconds >= 3) {
      await _player.seek(Duration.zero);
      _position = Duration.zero;
      notifyListeners();
      return;
    }
    final int? p = _computePrevIndex();
    if (p == null) {
      await _player.seek(Duration.zero);
      _position = Duration.zero;
      notifyListeners();
      return;
    }
    await _playAt(p);
  }

  void _onCompleted() {
    if (_handlingCompletion) return;
    _handlingCompletion = true;
    Future<void>(() async {
      try {
        if (_repeatMode == RepeatMode.one) {
          await _player.seek(Duration.zero);
          await _player.play();
        } else {
          final int? n = _computeNextIndex();
          if (n == null) {
            await _player.pause();
            await _player.seek(Duration.zero);
            _position = Duration.zero;
          } else {
            await _playAt(n);
          }
        }
      } catch (e) {
        debugPrint('[Player] 自动切歌失败: ' + e.toString());
      } finally {
        _handlingCompletion = false;
      }
    });
  }

  Future<void> _playAt(int index) async {
    if (index < 0 || index >= _queue.length) return;
    _currentIndex = index;
    _error = null;
    notifyListeners();
    await _load(_queue[index], autoPlay: true);
    await saveState();
  }

  // ============================================================ 加载

  Future<void> _load(Track t, {bool autoPlay = false, Duration? startAt}) async {
    try {
      final String? url = await repository.resolvePlayUrl(t);
      if (url == null || url.isEmpty) {
        _error = '无法获取播放地址';
        _lyrics = Lyrics.empty;
        notifyListeners();
        return;
      }
      Uri uri;
      if (t.isLocal) {
        final File f = File(t.filePath!);
        if (!await f.exists()) {
          _error = '文件不存在';
          notifyListeners();
          return;
        }
        uri = Uri.file(t.filePath!);
      } else {
        uri = Uri.parse(url);
      }

      final Uri? art = await ArtworkService.artUri(t);
      final MediaItem item = MediaItem(
        id: t.id,
        title: t.displayTitle,
        artist: t.displayArtist,
        album: t.album.isEmpty ? null : t.album,
        duration: t.duration,
        artUri: art,
      );

      await _player.setAudioSource(AudioSource.uri(uri, tag: item));
      _duration = _player.duration ?? t.duration;
      _position = Duration.zero;
      _anchorAt = null;
      _error = null;
      if (startAt != null && startAt > Duration.zero) {
        await _player.seek(startAt);
        _position = startAt;
      }
      if (autoPlay) {
        unawaited(_player.play());
      }
      notifyListeners();
      await _loadLyrics(t);
    } catch (e) {
      _error = _humanError(e);
      notifyListeners();
    }
  }

  String _humanError(Object e) {
    final String s = e.toString();
    if (s.contains('SocketException') || s.contains('Failed host lookup')) {
      return '网络不可用';
    }
    if (s.contains('404')) return '音源无版权或已下架';
    if (s.contains('403')) return '音源拒绝访问（可能需要登录）';
    return '播放失败';
  }

  // ============================================================ 歌词

  Future<void> _loadLyrics(Track t) async {
    _lyricTrackId = t.id;
    _lyrics = Lyrics.empty;
    notifyListeners();
    try {
      RawLyric? raw;
      if (t.isLocal && t.filePath != null) {
        raw = await _localLyric(t.filePath!);
      }
      raw ??= await repository.fetchLyric(t);
      if (raw == null || raw.isEmpty) return;
      if (_lyricTrackId != t.id) return; // 切歌竞态保护
      Lyrics parsed = _parseRaw(raw);
      if (raw.translation != null && raw.translation!.trim().isNotEmpty) {
        parsed = LyricParser.mergeTranslation(parsed, raw.translation!);
      }
      if (_lyricTrackId != t.id) return;
      _lyrics = parsed;
      notifyListeners();
    } catch (e) {
      debugPrint('[Player] 歌词加载失败: ' + e.toString());
    }
  }

  Lyrics _parseRaw(RawLyric raw) {
    final String f = raw.format.toLowerCase();
    if (f == 'yrc') {
      return LyricParser.parseYrc(raw.text, detectInstrumental: detectInstrumental);
    }
    if (f == 'krc') {
      return LyricParser.parseKrc(raw.text, detectInstrumental: detectInstrumental);
    }
    if (f == 'ttml') return LyricParser.parseTtml(raw.text);
    if (f == 'qrc') {
      return LyricParser.parseQrcPlain(raw.text, detectInstrumental: detectInstrumental);
    }
    return LyricParser.parseLrc(raw.text, detectInstrumental: detectInstrumental);
  }

  /// 同名外挂歌词：xxx.lrc / xxx.krc
  Future<RawLyric?> _localLyric(String filePath) async {
    final int dot = filePath.lastIndexOf('.');
    if (dot <= 0) return null;
    final String base = filePath.substring(0, dot);
    for (final String ext in <String>['.lrc', '.LRC', '.krc', '.KRC', '.txt']) {
      try {
        final File f = File(base + ext);
        if (!await f.exists()) continue;
        final String text = await f.readAsString();
        if (text.trim().isEmpty) continue;
        final bool isKrc = ext.toLowerCase() == '.krc';
        return RawLyric(text: text, format: isKrc ? 'krc' : 'lrc');
      } catch (_) {
        continue;
      }
    }
    return null;
  }

  // ============================================================ 传输控制

  Future<void> play() async {
    if (_queue.isEmpty) return;
    await _player.play();
  }

  Future<void> pause() async {
    await _player.pause();
  }

  Future<void> togglePlay() async {
    if (_playing) {
      await pause();
    } else {
      await play();
    }
  }

  Future<void> stop() async {
    await _player.stop();
    _position = Duration.zero;
    notifyListeners();
  }

  Future<void> seek(Duration d) async {
    final Duration? total = effectiveDuration;
    Duration target = d < Duration.zero ? Duration.zero : d;
    if (total != null && target > total) target = total;
    await _player.seek(target);
    _position = target;
    _anchorAt = null;
    notifyListeners();
  }

  Future<void> seekToFraction(double f) async {
    final Duration? total = effectiveDuration;
    if (total == null || total.inMilliseconds <= 0) return;
    final double c = f.clamp(0.0, 1.0);
    await seek(Duration(milliseconds: (total.inMilliseconds * c).round()));
  }

  /// 桌面端倍速循环：[1, 1.5, 2, 0.5, 0.75]
  static const List<double> kSpeedCycle = <double>[1, 1.5, 2, 0.5, 0.75];

  Future<void> setSpeed(double v) async {
    _speed = v;
    try {
      await _player.setSpeed(v);
    } catch (_) {}
    notifyListeners();
  }

  Future<double> cycleSpeed() async {
    final int i = kSpeedCycle.indexOf(_speed);
    final double nextV = kSpeedCycle[(i + 1) % kSpeedCycle.length];
    await setSpeed(nextV);
    return nextV;
  }

  Future<void> setVolume(double v) async {
    _volume = v.clamp(0.0, 1.0);
    try {
      await _player.setVolume(_volume);
    } catch (_) {}
    notifyListeners();
  }

  Future<void> setEffects(AudioEffectConfig cfg) async {
    await effects.apply(cfg);
  }

  // ============================================================ 状态持久化

  Future<void> saveState() async {
    try {
      await _store.write(<String, dynamic>{
        'queue': _queue.map((Track t) => t.toJson()).toList(),
        'index': _currentIndex,
        'positionMs': _position.inMilliseconds,
        'shuffle': _shuffle,
        'repeat': _repeatMode.name,
        'savedAt': DateTime.now().millisecondsSinceEpoch,
      });
    } catch (_) {}
  }

  /// 恢复上次会话（不自动播放，只预载并定位）
  Future<void> restoreState() async {
    try {
      final Map<String, dynamic>? j = await _store.read();
      if (j == null) return;
      final List<dynamic> raw = (j['queue'] as List<dynamic>?) ?? const <dynamic>[];
      final List<Track> q = raw
          .whereType<Map>()
          .map((Map e) => Track.fromJson(Map<String, dynamic>.from(e)))
          .toList();
      if (q.isEmpty) return;
      _queue = q;
      _currentIndex = ((j['index'] as num?)?.toInt() ?? 0).clamp(0, q.length - 1);
      _shuffle = j['shuffle'] == true;
      final String rn = (j['repeat'] ?? 'off').toString();
      _repeatMode = RepeatMode.values.firstWhere(
        (RepeatMode m) => m.name == rn,
        orElse: () => RepeatMode.off,
      );
      if (_shuffle) _rebuildShuffle();
      notifyListeners();
      final int ms = (j['positionMs'] as num?)?.toInt() ?? 0;
      await _load(
        _queue[_currentIndex],
        autoPlay: false,
        startAt: Duration(milliseconds: ms),
      );
    } catch (e) {
      debugPrint('[Player] 恢复上次会话失败: ' + e.toString());
    }
  }

  Future<void> clearSavedState() => _store.clear();

  @override
  void dispose() {
    _tick?.cancel();
    _stateSub?.cancel();
    unawaited(saveState());
    _player.dispose();
    super.dispose();
  }
}
