//! 凭据文件的加密读写（薄封装，方便业务模块统一调用）。
//!
//! 真正的加解密在宿主（Electron 主进程的 `safeStorage`）完成：
//! - Windows：DPAPI，绑定当前用户账户；
//! - macOS：Keychain；
//! - Linux：libsecret / KWallet。
//!
//! 密钥由操作系统托管，应用自身不落任何密钥文件。详见
//! `backend/crates/silvermoon-ipc/src/app.rs` 的 `Host::secure_*`。
//!
//! ## 历史明文自动迁移
//!
//! 宿主读到「没有加密信封」的旧文件时，会返回原文并**就地**加密写回，
//! 所以升级后的第一次读取即完成迁移，用户无需任何操作。
//!
//! ## 宿主不可达时不做明文降级
//!
//! 宿主是解密的唯一入口。不可达时读返回 `None`、写返回 `Err`，让上层按
//! 「未登录」处理 —— 宁可让用户重新登录，也不能在无法加密时悄悄写明文，
//! 那正是这次要修掉的问题。

/// 读取并解密凭据文件；不存在 / 解密失败 / 宿主不可达均返回 `None`。
pub fn read(app: &silvermoon_ipc::Host, file: &str) -> Option<String> {
    app.secure_read(file)
}

/// 加密写入凭据文件。
pub fn write(app: &silvermoon_ipc::Host, file: &str, text: &str) -> Result<(), String> {
    app.secure_write(file, text)
}

/// 删除凭据文件（不存在视为成功）。
pub fn remove(app: &silvermoon_ipc::Host, file: &str) {
    app.secure_remove(file);
}

/// 加密是否可用（Linux 无 keyring 时为 false，宿主会写降级信封并告警）。
pub fn available(app: &silvermoon_ipc::Host) -> bool {
    app.secure_available()
}
