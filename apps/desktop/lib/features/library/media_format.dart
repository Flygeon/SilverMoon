/// 媒体条目的展示格式化（体积 / 时长 / 日期）。
///
/// 曲目列表、目录浏览、书籍列表都要显示这几样，各写一份必然出现
/// 「MB 保留一位、GB 保留两位」这类不一致，所以抽到这里。
library;

/// 人性化体积：B / KB / MB / GB。
String formatMediaSize(int bytes) {
  if (bytes <= 0) return '';
  if (bytes < 1024) return bytes.toString() + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toStringAsFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) {
    return (bytes / (1024 * 1024)).toStringAsFixed(1) + ' MB';
  }
  return (bytes / (1024 * 1024 * 1024)).toStringAsFixed(2) + ' GB';
}

/// 毫秒 → mm:ss（超过一小时按 h:mm:ss）。
String formatMediaDuration(int? ms) {
  if (ms == null || ms <= 0) return '';
  final int totalSeconds = ms ~/ 1000;
  final int seconds = totalSeconds % 60;
  final String ss = seconds < 10 ? '0' + seconds.toString() : seconds.toString();
  final int minutes = (totalSeconds ~/ 60) % 60;
  final int hours = totalSeconds ~/ 3600;
  if (hours > 0) {
    final String mm = minutes < 10 ? '0' + minutes.toString() : minutes.toString();
    return hours.toString() + ':' + mm + ':' + ss;
  }
  return minutes.toString() + ':' + ss;
}

/// 毫秒时间戳 → yyyy-MM-dd。
String formatMediaDate(int ms) {
  if (ms <= 0) return '';
  final DateTime time = DateTime.fromMillisecondsSinceEpoch(ms);
  final String month = time.month < 10 ? '0' + time.month.toString() : time.month.toString();
  final String day = time.day < 10 ? '0' + time.day.toString() : time.day.toString();
  return time.year.toString() + '-' + month + '-' + day;
}
