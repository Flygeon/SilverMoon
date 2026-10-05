// Copyright 2016 Amanieu d'Antras
//
// Licensed under the Apache License, Version 2.0, <LICENSE-APACHE or
// http://apache.org/licenses/LICENSE-2.0> or the MIT license <LICENSE-MIT or
// http://opensource.org/licenses/MIT>, at your option. This file may not be
// copied, modified, or distributed except according to those terms.

use core::{
    mem,
    sync::atomic::{AtomicUsize, Ordering},
};
use std::{ffi, time::Instant};

use super::bindings::*;

#[allow(non_snake_case)]
pub struct WaitAddress {
    WaitOnAddress: WaitOnAddress,
    WakeByAddressSingle: WakeByAddressSingle,
}

impl WaitAddress {
    #[allow(non_snake_case)]
    pub fn create() -> Option<WaitAddress> {
        // ---------------------------------------------------------------------
        // SilverMoon 补丁（Win7 兼容）—— 唯一改动点
        // ---------------------------------------------------------------------
        //
        // 上游实现在探测 Win8+ 的 WaitOnAddress 之前，先按**名字**取模块句柄：
        //
        //     let synch_dll = GetModuleHandleA(b"api-ms-win-core-synch-l1-2-0.dll\0");
        //     if synch_dll == 0 { return None; }        // 看起来有 NULL 检查……
        //
        // 问题出在 `api-ms-win-core-synch-l1-2-0.dll` 是一个 **API Set 桩名**。
        // API Set 重定向（apiset schema）是 **Windows 8 才引入**的机制：
        //
        //   * Win8+ ：`GetModuleHandleA` 拿到这个名字后，经 apex 表重定向到
        //             `kernel32.dll`，成功返回句柄。探测照常进行。
        //   * Win7  ：`kernelbase!GetModuleHandleA` -> `BasepGetModuleHandleExW`
        //             在尝试解析 apiset 名时会读一张**未初始化的表**，
        //             结果不是返回 NULL，而是直接 **STATUS_ACCESS_VIOLATION
        //             (0xC0000005)**。
        //
        // 于是第 26 行的 `if synch_dll == 0 { return None; }` **永远不会执行** ——
        // 进程在硬访问违例中直接死亡，回退到 KeyedEvent 的 `else if` 分支
        // 根本没有机会运行。
        //
        // 症状（与 SilverMoon 在真实 Win7 上观测到的完全一致）：
        //
        //   * 退出码 0xC0000005 / 3221225477 —— 是 AV，不是「找不到模块」
        //     的 0xC0000135（因为 GetModuleHandle 不查磁盘）；
        //   * **连 main 的第一行都跑不到** —— 这条路径由 CRT 静态构造期
        //     触发（某个 static 的 Lazy 初始化），早于 main；
        //   * 稳定复现，每次耗时相同（加载 12.9MB + CRT 初始化 + 走到这里）；
        //   * `objdump -p` 查导入表**看不出任何异常** —— 因为
        //     `WaitOnAddress` / `WakeByAddressSingle` 是 `GetProcAddress`
        //     动态解析的，根本不在导入表里；名字只以字符串常量存在。
        //
        // 修法：Win7 构建下**跳过这次探测**，直接返回 None，
        // 让调用方（`mod.rs::Backend::create`）走第二条分支 ——
        // `keyed_event::KeyedEvent`，它用 ntdll 的 `NtCreateKeyedEvent`，
        // 是 **Windows XP 就有**的接口，Win7 完全支持。
        //
        // 判据用 `cfg(windows)` + 运行时版本判断，而不是直接砍掉整个探测：
        //   * 非 win7 构建（普通 Windows 目标）保持原样，探测照跑；
        //   * Win7 上主动短路，避免踩 apiset 解析。
        //
        // 这里读 kernel32 的版本而不是用 `cfg`：同一个 `target_os = "windows"`
        // 覆盖 Win7 ~ Win11，编译期分不出来（这也是为什么项目里 Win7 兼容
        // 要靠一个显式的 `win7` feature 来标记）。
        #[cfg(windows)]
        {
            use super::bindings::os_version;

            // Win7 及更早（major.minor <= 6.1）走 KeyedEvent。
            // 读不到版本时**保守地按 Win7 处理** —— 宁可退到 XP+ 就支持的
            // KeyedEvent，也不要在未知系统上冒 AV 的风险。
            let is_win7_or_lower = match os_version() {
                Some((major, minor)) => {
                    major < 6 || (major == 6 && minor <= 1)
                }
                None => true,
            };
            if is_win7_or_lower {
                return None;
            }
        }

        let synch_dll = unsafe { GetModuleHandleA(b"api-ms-win-core-synch-l1-2-0.dll\0".as_ptr()) };
        if synch_dll == 0 {
            return None;
        }

        let WaitOnAddress = unsafe { GetProcAddress(synch_dll, b"WaitOnAddress\0".as_ptr())? };
        let WakeByAddressSingle =
            unsafe { GetProcAddress(synch_dll, b"WakeByAddressSingle\0".as_ptr())? };

        Some(WaitAddress {
            WaitOnAddress: unsafe { mem::transmute(WaitOnAddress) },
            WakeByAddressSingle: unsafe { mem::transmute(WakeByAddressSingle) },
        })
    }

    #[inline]
    pub fn prepare_park(&'static self, key: &AtomicUsize) {
        key.store(1, Ordering::Relaxed);
    }

    #[inline]
    pub fn timed_out(&'static self, key: &AtomicUsize) -> bool {
        key.load(Ordering::Relaxed) != 0
    }

    #[inline]
    pub fn park(&'static self, key: &AtomicUsize) {
        while key.load(Ordering::Acquire) != 0 {
            let r = self.wait_on_address(key, INFINITE);
            debug_assert!(r == true.into());
        }
    }

    #[inline]
    pub fn park_until(&'static self, key: &AtomicUsize, timeout: Instant) -> bool {
        while key.load(Ordering::Acquire) != 0 {
            let now = Instant::now();
            if timeout <= now {
                return false;
            }
            let diff = timeout - now;
            let timeout = diff
                .as_secs()
                .checked_mul(1000)
                .and_then(|x| x.checked_add((diff.subsec_nanos() as u64 + 999999) / 1000000))
                .map(|ms| {
                    // `std::u32::MAX` 已被 `u32::MAX` 取代（nightly 上会报
                    // deprecated 警告）。上游还没改，本仓库 fork 之后顺手修掉 ——
                    // 这个 crate 的告警会出现在我们自己的 CI 日志里，不好看。
                    if ms > u32::MAX as u64 {
                        INFINITE
                    } else {
                        ms as u32
                    }
                })
                .unwrap_or(INFINITE);
            if self.wait_on_address(key, timeout) == false.into() {
                debug_assert_eq!(unsafe { GetLastError() }, ERROR_TIMEOUT);
            }
        }
        true
    }

    #[inline]
    pub fn unpark_lock(&'static self, key: &AtomicUsize) -> UnparkHandle {
        // We don't need to lock anything, just clear the state
        key.store(0, Ordering::Release);

        UnparkHandle {
            key: key,
            waitaddress: self,
        }
    }

    #[inline]
    fn wait_on_address(&'static self, key: &AtomicUsize, timeout: u32) -> BOOL {
        let cmp = 1usize;
        unsafe {
            (self.WaitOnAddress)(
                key as *const _ as *mut ffi::c_void,
                &cmp as *const _ as *mut ffi::c_void,
                mem::size_of::<usize>(),
                timeout,
            )
        }
    }
}

// Handle for a thread that is about to be unparked. We need to mark the thread
// as unparked while holding the queue lock, but we delay the actual unparking
// until after the queue lock is released.
pub struct UnparkHandle {
    key: *const AtomicUsize,
    waitaddress: &'static WaitAddress,
}

impl UnparkHandle {
    // Wakes up the parked thread. This should be called after the queue lock is
    // released to avoid blocking the queue for too long.
    #[inline]
    pub fn unpark(self) {
        unsafe { (self.waitaddress.WakeByAddressSingle)(self.key as *mut ffi::c_void) };
    }
}
