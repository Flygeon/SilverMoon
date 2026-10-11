#!/usr/bin/env python3
"""磁盘透镜 · 扩展引擎（纯标准库）。

契约见 doc/扩展开发指南.md 第七章：启动往 stdout 打一行 `READY <port>`，
之后所有调用都是 `POST http://127.0.0.1:<port>/<方法名>`，请求体是前端给的 payload。

## 这个引擎刻意演示的几件事

1. **握手用端口 0**：让操作系统分配，再把真实端口打出来。写死端口迟早撞车。
2. **扫描放后台线程**：`scan` 立刻返回，前端轮询 `status` 看进度。
   宿主对单次调用有 30 秒超时，同步扫大目录必然踩线。
3. **不伪造百分比**：事前不知道一共有多少文件，所以只报「已看到多少」，
   而不是编一个 0~100% 出来。
4. **只读**：本示例不删、不改、不移动任何文件。
5. **持久化只写 supportEnv 指向的目录**（宿主注入 `DISK_LENS_DATA_DIR`）。
6. **stdout 只出现 READY 那一行**，日志一律走 stderr。

## 路由

| 方法 | payload | 返回 |
|---|---|---|
| `ping`   | 任意 | `{ok, version, dataDir}` |
| `scan`   | `{roots?, topN?, minMB?, followSymlinks?}`，可为 null | `{started, options}` |
| `status` | 任意 | `{running, files, dirs, bytes, current, elapsedMs, report?}` |
| `cancel` | 任意 | `{cancelled}` |
| `options`| 任意 | `{options}`（上次用的参数，托盘触发时会复用它） |
"""

import json
import os
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

VERSION = "1.0.0"

# 兜底上限：目录树可以无限大，跑飞了会一直占着 CPU。
MAX_ENTRIES = 200_000
MAX_DEPTH = 32
MAX_ERRORS = 20

# 宿主通过 supportEnv 注入的私有数据目录；手动调试时退回到包内 data/。
DATA_DIR = os.environ.get("DISK_LENS_DATA_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "data"
)
OPTIONS_FILE = os.path.join(DATA_DIR, "options.json")

DEFAULT_OPTIONS = {
    "roots": [],
    "topN": 30,
    "minMB": 1,
    "followSymlinks": False,
}

_lock = threading.Lock()
_state = {
    "running": False,
    "cancel": False,
    "files": 0,
    "dirs": 0,
    "bytes": 0,
    "current": "",
    "startedAt": 0.0,
    "report": None,
}


# --------------------------------------------------------------------------
# 参数与持久化
# --------------------------------------------------------------------------

def _load_options():
    try:
        with open(OPTIONS_FILE, "r", encoding="utf-8") as fh:
            saved = json.load(fh)
        if isinstance(saved, dict):
            merged = dict(DEFAULT_OPTIONS)
            merged.update({k: v for k, v in saved.items() if k in DEFAULT_OPTIONS})
            return merged
    except (OSError, ValueError):
        pass
    return dict(DEFAULT_OPTIONS)


def _save_options(options):
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(OPTIONS_FILE, "w", encoding="utf-8") as fh:
            json.dump(options, fh, ensure_ascii=False, indent=2)
    except OSError as exc:
        print(f"[disk-lens] 保存参数失败：{exc}", file=sys.stderr)


def _normalize_options(payload):
    """把前端给的 payload 收敛成可用的参数；缺项沿用上次保存的值。"""
    base = _load_options()
    if not isinstance(payload, dict):
        # 托盘 `invoke:scan` 的 payload 就是 None —— 直接复用上次的参数
        return base

    roots = payload.get("roots")
    if isinstance(roots, list):
        base["roots"] = [str(r) for r in roots if str(r).strip()]
    for key in ("topN", "minMB"):
        value = payload.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            base[key] = max(1, int(value))
    if isinstance(payload.get("followSymlinks"), bool):
        base["followSymlinks"] = payload["followSymlinks"]
    return base


# --------------------------------------------------------------------------
# 扫描
# --------------------------------------------------------------------------

def _ext_of(name):
    dot = name.rfind(".")
    if dot <= 0:
        return "(无扩展名)"
    ext = name[dot + 1 :].lower()
    # 双扩展名（.tar.gz）取最后一段就够了，这里不额外展开
    return "." + ext[:16] if ext else "(无扩展名)"


def _scan_worker(options):
    roots = options["roots"]
    min_bytes = options["minMB"] * 1024 * 1024
    top_n = options["topN"]
    follow = options["followSymlinks"]

    by_ext = {}
    by_subdir = {}
    top_files = []
    errors = []
    entries = 0
    truncated = False

    def note(path, size, mtime):
        nonlocal entries
        entries += 1
        ext = _ext_of(os.path.basename(path))
        slot = by_ext.setdefault(ext, {"ext": ext, "bytes": 0, "count": 0})
        slot["bytes"] += size
        slot["count"] += 1
        if size >= min_bytes:
            top_files.append((size, path, mtime))

    for root in roots:
        root = os.path.abspath(root)
        if not os.path.isdir(root):
            if len(errors) < MAX_ERRORS:
                errors.append({"path": root, "error": "不是目录或不存在"})
            continue
        for dirpath, dirnames, filenames in os.walk(root, followlinks=follow):
            if _state["cancel"]:
                break
            depth = dirpath[len(root) :].count(os.sep)
            if depth >= MAX_DEPTH:
                dirnames[:] = []
                continue

            with _lock:
                _state["dirs"] += 1
                _state["current"] = dirpath

            rel = os.path.relpath(dirpath, root)
            bucket = rel.split(os.sep)[0] if rel != "." else "."
            for name in filenames:
                if entries >= MAX_ENTRIES:
                    truncated = True
                    break
                full = os.path.join(dirpath, name)
                try:
                    st = os.stat(full)
                except OSError as exc:
                    if len(errors) < MAX_ERRORS:
                        errors.append({"path": full, "error": str(exc)})
                    continue
                size = st.st_size
                mtime = int(st.st_mtime * 1000)
                note(full, size, mtime)

                slot = by_subdir.setdefault(bucket, {"path": bucket, "bytes": 0, "count": 0})
                slot["bytes"] += size
                slot["count"] += 1

                with _lock:
                    _state["files"] += 1
                    _state["bytes"] += size
            if truncated:
                break
        if _state["cancel"]:
            break

    top_files.sort(key=lambda item: item[0], reverse=True)
    report = {
        "roots": roots,
        "files": _state["files"],
        "dirs": _state["dirs"],
        "bytes": _state["bytes"],
        "elapsedMs": int((time.time() - _state["startedAt"]) * 1000),
        "truncated": truncated,
        "cancelled": _state["cancel"],
        "minMB": options["minMB"],
        "byExt": sorted(by_ext.values(), key=lambda x: x["bytes"], reverse=True)[:20],
        "bySubdir": sorted(by_subdir.values(), key=lambda x: x["bytes"], reverse=True)[:15],
        "topFiles": [
            {"path": p, "bytes": b, "mtimeMs": m}
            for (b, p, m) in top_files[:top_n]
        ],
        "errors": errors,
    }
    with _lock:
        _state["running"] = False
        _state["report"] = report


# --------------------------------------------------------------------------
# 路由
# --------------------------------------------------------------------------

def route_ping(_payload):
    return {"ok": True, "version": VERSION, "dataDir": DATA_DIR}


def route_options(_payload):
    return {"options": _load_options()}


def route_scan(payload):
    with _lock:
        if _state["running"]:
            return {"started": False, "reason": "已经在扫描中", "options": _load_options()}
        options = _normalize_options(payload)
        if not options["roots"]:
            return {
                "started": False,
                "reason": "还没有配置扫描目录（设置里填一个绝对路径）",
                "options": options,
            }
        _save_options(options)
        _state.update(
            running=True,
            cancel=False,
            files=0,
            dirs=0,
            bytes=0,
            current="",
            startedAt=time.time(),
            report=None,
        )
    threading.Thread(target=_scan_worker, args=(options,), daemon=True).start()
    return {"started": True, "options": options}


def route_status(_payload):
    with _lock:
        snap = {
            "running": _state["running"],
            "files": _state["files"],
            "dirs": _state["dirs"],
            "bytes": _state["bytes"],
            "current": _state["current"],
            "elapsedMs": int((time.time() - _state["startedAt"]) * 1000)
            if _state["startedAt"]
            else 0,
            "report": _state["report"],
        }
    return snap


def route_cancel(_payload):
    with _lock:
        was = _state["running"]
        _state["cancel"] = True
    return {"cancelled": was}


ROUTES = {
    "ping": route_ping,
    "scan": route_scan,
    "status": route_status,
    "cancel": route_cancel,
    "options": route_options,
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):  # noqa: N802 —— BaseHTTPRequestHandler 的命名
        method = self.path.strip("/").split("?")[0]
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw) if raw else None
        except ValueError:
            payload = None

        handler = ROUTES.get(method)
        if handler is None:
            self._send(404, {"error": f"未知方法：{method}"})
            return
        try:
            self._send(200, handler(payload))
        except Exception as exc:  # 引擎自己出错也要回 JSON，否则宿主报「返回非 JSON」
            print(f"[disk-lens] {method} 失败：{exc!r}", file=sys.stderr)
            self._send(500, {"error": f"{type(exc).__name__}: {exc}"})

    def _send(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        # 铁律：stdout 只用来打 READY 那一行，访问日志走 stderr
        print(*args, file=sys.stderr)


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    # 端口交给操作系统分配：写死端口迟早和别的程序撞车
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    print(f"READY {server.server_address[1]}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
