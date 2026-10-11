#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Hello World 扩展引擎 —— SilverMoon 扩展框架最小可运行引擎。

它同时是一份「引擎协议」的活文档，只做三件事：

1. 在 127.0.0.1 上起一个 HTTP 服务（端口交给操作系统分配，不写死）；
2. 往 stdout 打一行 `READY <port>` 完成握手（**必须 flush**）；
3. 把 `POST /<方法名>` 分发到下面的处理函数，返回 JSON。

宿主侧的对应事实（见 doc/扩展开发指南.md 第七章）：
- 工作目录 = 扩展根目录；
- stdout 只被读第一行 `READY`，此后再写没人消费 —— 所以日志一律走 stderr；
- `READY` 握手超时 20 秒，单次方法调用超时 30 秒；
- manifest 的 `supportEnv` 指定了一个环境变量名，值就是本扩展的 data/ 目录。

这个引擎不需要任何第三方依赖，只用标准库。
"""

import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---- 运行期状态 ----

STARTED_AT = time.time()

# 宿主把 <扩展目录>/data 创建好，并通过 manifest.engines.supportEnv 指定的名字注入。
# 没拿到就退化为「当前目录」（只影响持久化，不影响服务能跑起来）。
DATA_DIR = os.environ.get("HELLO_WORLD_DATA_DIR") or os.getcwd()
NOTES_FILE = os.path.join(DATA_DIR, "notes.json")


def log(*args):
    """日志走 stderr —— 绝不污染 stdout 的 READY 握手通道。"""
    print("[hello-world]", *args, file=sys.stderr, flush=True)


def load_notes():
    try:
        with open(NOTES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def save_notes(notes):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(NOTES_FILE, "w", encoding="utf-8") as f:
        json.dump(notes, f, ensure_ascii=False, indent=2)


# ---- 方法表 ----
# 键 = 前端 invoke("方法名") 里的方法名，也是 URL 路径 /<方法名>。
# 每个处理函数收 payload（dict 或 None），返回可 JSON 序列化的对象。


def method_greet(payload):
    """打招呼。演示「前端把 payload 原样传进来」。"""
    name = (payload or {}).get("name") or "世界"
    log("greet 被调用，name=", name)
    return {"message": f"你好，{name}！", "engine": "hello-world", "at": time.time()}


def method_status(payload):
    """报告引擎自身状态。演示「返回结构化数据」。"""
    return {
        "ok": True,
        "uptimeSec": round(time.time() - STARTED_AT, 1),
        "dataDir": DATA_DIR,
        "python": sys.version.split()[0],
        "noteCount": len(load_notes()),
    }


def method_remember(payload):
    """记一条笔记（写进 data/），演示 supportEnv 注入的私有数据目录。"""
    text = ((payload or {}).get("text") or "").strip()
    if not text:
        # 返回体必须是 JSON；用 error 字段表达业务错误，前端 reject 后能读到
        return {"error": "text 不能为空"}
    notes = load_notes()
    notes.append({"text": text, "at": time.time()})
    save_notes(notes)
    return {"ok": True, "count": len(notes)}


def method_recall(payload):
    """列出全部笔记。"""
    return {"notes": load_notes()}


METHODS = {
    "greet": method_greet,
    "status": method_status,
    "remember": method_remember,
    "recall": method_recall,
}


# ---- HTTP 服务 ----


class Handler(BaseHTTPRequestHandler):
    # 想收更大的 payload 时改这里
    protocol_version = "HTTP/1.1"

    def _reply(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        method = self.path.strip("/").split("/")[0]

        # 读请求体：托盘 invoke:<method> 触发时宿主发的是 JSON null，
        # 长度可能是 0，所以两个都要兜住。
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw) if raw else {}
        except ValueError:
            self._reply(400, {"error": "请求体不是合法 JSON"})
            return

        func = METHODS.get(method)
        if func is None:
            self._reply(404, {"error": f"未知方法：{method}", "known": sorted(METHODS)})
            return

        try:
            self._reply(200, func(payload))
        except Exception as exc:  # noqa: BLE001 —— 演示代码，兜住就好
            log("方法", method, "抛异常：", repr(exc))
            self._reply(500, {"error": f"引擎内部错误：{exc}"})

    def do_GET(self):
        # 宿主只用 POST；GET 留给浏览器里手工探活。
        self._reply(200, {"service": "hello-world", "methods": sorted(METHODS)})

    def log_message(self, fmt, *args):
        # 默认实现会往 stderr 打访问日志 —— 走我们自己的 log，顺便避免噪音
        log("http:", fmt % args)


def main():
    # 端口传 0 = 让操作系统挑一个空闲端口，再把它报给宿主。
    # **不要写死端口**：写死会和别的扩展/别的程序撞车。
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]

    # 这一行就是握手。格式固定：以 READY 开头，第二个空白分隔的词是端口。
    # flush=True 不是可选项 —— 不 flush 宿主会一直等到 20 秒超时。
    print(f"READY {port}", flush=True)
    log(f"引擎已就绪，监听 127.0.0.1:{port}，数据目录 {DATA_DIR}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
