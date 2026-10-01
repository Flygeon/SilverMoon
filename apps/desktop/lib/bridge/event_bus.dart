/// 后端事件帧。
///
/// 形状由 `crates/silvermoon-ipc/src/app.rs` 的事件构造固定：
/// `{ "event": "...", "target": null|"label", "payload": ... }`。
/// 经 `GET /events`（SSE）送达宿主。
///
/// `target` 语义必须原样保留：null 表示广播；非 null 时只有 label 匹配的窗口
/// 才该收到（播放器窗口 label 固定为 "main"，桌面歌词是 "desktop-lyrics"）。
class BackendEvent {
  const BackendEvent({required this.event, this.target, this.payload});

  final String event;
  final String? target;
  final Object? payload;

  /// 从后端帧解析；没有合法事件名时返回 null（该帧丢弃）。
  static BackendEvent? fromFrame(Map<String, Object?> frame) {
    final Object? name = frame['event'];
    if (name is! String || name.isEmpty) return null;
    final Object? target = frame['target'];
    return BackendEvent(
      event: name,
      target: target is String ? target : null,
      payload: frame['payload'],
    );
  }

  /// 该事件是否应投递给 label 为 [label] 的窗口。
  bool matches(String label) => target == null || target == label;

  @override
  String toString() => 'BackendEvent(' + event + ', target=' + (target ?? '*') + ')';
}
