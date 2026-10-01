/**
 * SilverMoon 宿主垫片（WebView 版）。
 *
 * Electron 版渲染进程的唯一通道是 preload 注入的 `window.__SILVERMOON__`；
 * Flutter 宿主没有 preload，改由本文件把 Dart 侧的 loopback 中间层包装成**同形**对象，
 * 因此播放层的 src/ipc/* 与 capabilities 无需任何改动。
 *
 * 由中间层在 <port>/shim.js 提供，player.html 必须在本页应用脚本之前引入它。
 */
(function () {
  'use strict';

  // 已由原生注入则让位（例如将来走 WebView2 AddScriptToExecuteOnDocumentCreated）
  if (window.__SILVERMOON__) return;

  var base = window.location.origin;

  function post(path, body) {
    return fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    }).then(
      function (res) {
        return res.json().catch(function () {
          return { ok: false, error: '桥返回了非 JSON 响应（HTTP ' + res.status + '）' };
        });
      },
      function (err) {
        return { ok: false, error: '桥不可达：' + String((err && err.message) || err) };
      }
    );
  }

  window.__SILVERMOON__ = {
    label: 'main',
    platform: 'win32',
    // 关键：toAssetUrl() 见到 assetBase 就改用它，播放层的本地文件 URL 零改动
    assetBase: base + '/a/',
    invoke: function (cmd, args) {
      return post('/bridge/invoke', { cmd: cmd, args: args || {} });
    },
    invokeBatch: function (calls) {
      return post('/bridge/invokeBatch', { calls: calls || [] });
    },
    call: function (channel, payload) {
      return post('/bridge/call', { channel: channel, payload: payload });
    },
    emitTo: function (target, event, payload) {
      return post('/bridge/emit', { label: target, event: event, payload: payload }).then(function () {});
    }
  };

  // 后端 SSE → DOM 事件。事件名与 detail 形状与 Electron preload 完全一致
  // （src/ipc/events.ts 只监听 'silvermoon:event'，detail 就是 { event, target, payload } 帧）。
  var retry = 0;
  function connect() {
    var source;
    try {
      source = new EventSource(base + '/bridge/events');
    } catch (e) {
      return;
    }
    source.onopen = function () { retry = 0; };
    source.onmessage = function (ev) {
      var frame;
      try { frame = JSON.parse(ev.data); } catch (e) { return; }
      window.dispatchEvent(new CustomEvent('silvermoon:event', { detail: frame }));
    };
    source.onerror = function () {
      // EventSource 自己会重连；这里只做退避兜底，避免中间层还没起来时疯狂重试
      source.close();
      retry = Math.min(retry + 1, 6);
      window.setTimeout(connect, 500 * retry);
    };
  }
  connect();
})();
