//! 等价 `silvermoon_ipc::rt`。
//!
//! 业务代码里 `spawn_blocking` 有 42 处、`spawn` 有 2 处；另外还有 26 处直接调用
//! `tokio::task::spawn_blocking`，所以这里必须提供一个**真实的 tokio 运行时**
//! （由 `Builder::run` 建立），否则那些调用会因「no reactor running」而 panic。

use std::fmt;
use std::future::Future;

/// `JoinHandle` 的错误。
#[derive(Debug)]
pub struct JoinError(String);

impl fmt::Display for JoinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for JoinError {}

/// 等价 `silvermoon_ipc::rt::JoinHandle`。
pub struct JoinHandle<T> {
    inner: tokio::task::JoinHandle<T>,
}

// 内部没有自引用结构，永远可以安全移动。
impl<T> Unpin for JoinHandle<T> {}

impl<T> Future for JoinHandle<T> {
    type Output = std::result::Result<T, JoinError>;

    fn poll(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        let this = self.get_mut();
        match std::pin::Pin::new(&mut this.inner).poll(cx) {
            std::task::Poll::Ready(Ok(v)) => std::task::Poll::Ready(Ok(v)),
            std::task::Poll::Ready(Err(e)) => std::task::Poll::Ready(Err(JoinError(e.to_string()))),
            std::task::Poll::Pending => std::task::Poll::Pending,
        }
    }
}

/// 在当前运行时上派生一个异步任务。
pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    JoinHandle {
        inner: tokio::spawn(future),
    }
}

/// 在阻塞线程池上执行闭包。用于命令里的同步 IO（网络请求、SQLite 等）。
pub fn spawn_blocking<F, R>(f: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    JoinHandle {
        inner: tokio::task::spawn_blocking(f),
    }
}

/// 取当前运行时句柄（供内部使用）。
pub fn handle() -> Option<tokio::runtime::Handle> {
    tokio::runtime::Handle::try_current().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_blocking_returns_inner_result() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let value = rt.block_on(async {
            let r: std::result::Result<std::result::Result<i32, String>, JoinError> =
                spawn_blocking(|| Ok::<i32, String>(41 + 1)).await;
            r
        });
        assert_eq!(value.unwrap().unwrap(), 42);
    }

    #[test]
    fn spawn_returns_output() {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let value = rt.block_on(async { spawn(async { 7 }).await.unwrap() });
        assert_eq!(value, 7);
    }
}
