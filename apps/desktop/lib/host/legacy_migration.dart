import 'dart:io';

/// 旧标识（LumiLuna）数据目录的一次性迁移。
///
/// 语义与 Electron `electron/config.ts` 的 `migrateLegacyData()` 一致，三条都不能变：
///   1. **只在目标目录还不存在时**迁移 —— 目标已存在就说明用户已经在用新版本，
///      此时任何写入都可能覆盖既有数据，必须完全不动；
///   2. 旧目录**只读**，迁移失败也不阻断启动（由调用方兜底）；
///   3. 不跟随符号链接，避免自指成环。
///
/// 注意第 1 条的调用时机：判断「目标是否存在」必须在创建数据目录**之前**，
/// 否则 ensureDataDirs() 刚把目录建出来，这里就永远返回 false，迁移成为死代码。
bool shouldMigrate({required String dataDir, required String legacyDir}) {
  if (dataDir.isEmpty || legacyDir.isEmpty) return false;
  if (Directory(dataDir).existsSync()) return false;
  return Directory(legacyDir).existsSync();
}

/// 递归整目录复制，返回复制的文件数。目标目录不存在时自动创建。
int copyTree(Directory from, Directory to) {
  if (!to.existsSync()) to.createSync(recursive: true);
  int copied = 0;
  for (final FileSystemEntity entity in from.listSync(followLinks: false)) {
    final String name = _basename(entity.path);
    if (name.isEmpty) continue;
    final String target = to.path + Platform.pathSeparator + name;
    if (entity is Directory) {
      copied += copyTree(entity, Directory(target));
    } else if (entity is File) {
      entity.copySync(target);
      copied++;
    }
    // Link 既不跟随也不复制：跟随会让自指链接无限递归。
  }
  return copied;
}

String _basename(String path) {
  final int index = path.lastIndexOf(RegExp(r'[\\/]'));
  return index < 0 ? path : path.substring(index + 1);
}
