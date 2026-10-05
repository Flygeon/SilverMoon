/*
 * SilverMoon Win7 崩溃最小复现程序
 * ---------------------------------------------------------------------------
 * 目的：证伪 / 证实「GetModuleHandleA("api-ms-win-core-synch-l1-2-0.dll")
 *       在 Windows 7 上会抛 STATUS_ACCESS_VIOLATION (0xC0000005)」这一假设。
 *
 * 背景：parking_lot_core 0.9.12 的
 *         src/thread_parker/windows/waitaddress.rs:25
 *       在探测 Win8+ 的 WaitOnAddress 前，先按名字取模块句柄：
 *
 *           let synch_dll = GetModuleHandleA(b"api-ms-win-core-synch-l1-2-0.dll");
 *           if synch_dll == 0 { return None; }        // 代码本身有 NULL 检查
 *
 *       设计意图是「Win7 上取不到 → 返回 None → 回退 KeyedEvent(XP+)」。
 *       但若 GetModuleHandleA 在解析 apiset 名时**不返回 0 而是崩**，
 *       这条回退路径就永远走不到 —— 进程在 CRT 静态构造期直接死掉，
 *       连 main 的第一行都执行不到（与实测「日志一行都没有」吻合）。
 *
 * 本程序按顺序做 4 个探测，**每步之前先 WriteFile 落盘并 flush**，
 * 这样哪一步崩，日志就停在哪一步之前 —— 和 SilverMoon 的 boot_trace 同款思路。
 *
 * 之所以用 C 而不是 Rust：复现要跑在 Win7 上，而恰恰是 Rust 工具链的
 * 目标支持有问题（tier-3 x86_64-win7-windows-gnu）。C 用 mingw-w64
 * 交叉编译到 i686/x86_64 都没有任何版本门槛，能干净地隔离「是不是 OS 的问题」。
 *
 * 编译（Linux 交叉）：
 *   x86_64-w64-mingw32-gcc -O0 -g -o repro.exe repro.c
 * 运行（Win7）：
 *   repro.exe            控制台版，直接看输出
 *   repro.exe --gui      弹窗版（不想开 cmd 时用）
 *
 * 日志同时写：
 *   ① exe 同目录 repro-trace.log
 *   ② %TEMP%\repro-trace.log
 */

#include <windows.h>
#include <stdio.h>
#include <string.h>

static char g_paths[2][MAX_PATH];
static int g_path_count = 0;
static DWORD g_t0 = 0;

/* ---------------------------------------------------------------------------
 * 日志：多路写入。每写一行立即 FlushFileBuffers —— 硬崩溃时缓冲区里的内容
 * 会连着进程一起消失，必须先落盘。
 * ------------------------------------------------------------------------- */
static void open_logs(void) {
  char exe[MAX_PATH];
  DWORD n = GetModuleFileNameA(NULL, exe, MAX_PATH);
  if (n > 0 && n < MAX_PATH) {
    char *slash = strrchr(exe, '\\');
    if (slash) {
      *(slash + 1) = 0;
      _snprintf(g_paths[g_path_count], MAX_PATH, "%srepro-trace.log", exe);
      g_path_count++;
    }
  }
  char tmp[MAX_PATH];
  DWORD tn = GetTempPathA(MAX_PATH, tmp);
  if (tn > 0 && tn < MAX_PATH) {
    _snprintf(g_paths[g_path_count], MAX_PATH, "%srepro-trace.log", tmp);
    g_path_count++;
  }
}

static void logline(const char *fmt, ...) {
  char buf[2048];
  int off = 0;
  if (g_t0 == 0) g_t0 = GetTickCount();
  off += _snprintf(buf + off, sizeof(buf) - off, "[+%5lums] ", GetTickCount() - g_t0);
  va_list ap;
  va_start(ap, fmt);
  off += _vsnprintf(buf + off, sizeof(buf) - off, fmt, ap);
  va_end(ap);
  if (off > (int)sizeof(buf) - 3) off = sizeof(buf) - 3;
  buf[off++] = '\r';
  buf[off++] = '\n';
  buf[off] = 0;

  /* 控制台（若从 cmd 启动） */
  HANDLE con = GetStdHandle(STD_OUTPUT_HANDLE);
  if (con != INVALID_HANDLE_VALUE && con != NULL) {
    DWORD w;
    WriteFile(con, buf, off, &w, NULL);
  }

  /* 文件 */
  int i;
  for (i = 0; i < g_path_count; i++) {
    HANDLE h = CreateFileA(g_paths[i], FILE_APPEND_DATA, FILE_SHARE_READ, NULL,
                           OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
      DWORD w;
      WriteFile(h, buf, off, &w, NULL);
      FlushFileBuffers(h);
      CloseHandle(h);
    }
  }
}

/* ---------------------------------------------------------------------------
 * 单个探测
 * ------------------------------------------------------------------------- */
typedef FARPROC(WINAPI *PFN_GetProcAddress)(HMODULE, LPCSTR);

static void probe(const char *label, const char *dllname) {
  logline("STEP  即将探测：%s  (\"%s\")", label, dllname);

  HMODULE h = GetModuleHandleA(dllname);
  logline("  -> GetModuleHandleA 返回 = 0x%p  (错误码 %lu)", (void *)h, GetLastError());
  if (h == NULL) {
    logline("  -> 模块未加载（这是 Win7 上的**预期**结果，说明探测是安全的）");
    return;
  }

  FARPROC p = GetProcAddress(h, "WaitOnAddress");
  logline("  -> GetProcAddress(\"WaitOnAddress\") = 0x%p  (错误码 %lu)", (void *)p, GetLastError());
}

static void run_all(void) {
  logline("===== SilverMoon Win7 复现程序 =====");
  logline("OS 版本：%lu.%lu (build %lu)",
          (unsigned long)(GetVersion() & 0xFF),
          (unsigned long)((GetVersion() >> 8) & 0xFF),
          (unsigned long)(GetVersion() >> 16));
  logline("是否为 Win7：%s",
#if _WIN32_WINNT
          ""
#else
          ""
#endif
          "见下面各探测结果");

  logline("");
  logline("### 探测 1：apiset 名 —— 这是 SilverMoon 崩溃的嫌疑点");
  probe("api-ms-win-core-synch-l1-2-0.dll（Win8+ 同步原语 apiset）",
        "api-ms-win-core-synch-l1-2-0.dll");

  logline("");
  logline("### 探测 2：另一个已知 apiset，作对照");
  probe("api-ms-win-core-file-l1-2-0.dll", "api-ms-win-core-file-l1-2-0.dll");

  logline("");
  logline("### 探测 3：真实系统 DLL，作对照（必须成功）");
  probe("kernel32.dll", "kernel32.dll");

  logline("");
  logline("### 探测 4：Win8+ 才有的真实 DLL 名，作对照（应返回 0 而非崩）");
  probe("KernelBase.dll", "KernelBase.dll");

  logline("");
  logline("### 探测 5：LoadLibraryA 路径（验证与 GetModuleHandle 的差异）");
  logline("STEP  即将 LoadLibraryA(\"api-ms-win-core-synch-l1-2-0.dll\")");
  {
    HMODULE h = LoadLibraryA("api-ms-win-core-synch-l1-2-0.dll");
    logline("  -> LoadLibraryA 返回 = 0x%p  (错误码 %lu)", (void *)h, GetLastError());
  }

  logline("");
  logline("### 探测 6：模拟 parking_lot 的完整探测序列");
  logline("STEP  进入 parking_lot 式探测（GetModuleHandleA + 两次 GetProcAddress）");
  {
    HMODULE dll = GetModuleHandleA("api-ms-win-core-synch-l1-2-0.dll");
    logline("  synch_dll = 0x%p", (void *)dll);
    if (dll != NULL) {
      FARPROC wa = GetProcAddress(dll, "WaitOnAddress");
      logline("  WaitOnAddress = 0x%p", (void *)wa);
      if (wa != NULL) {
        FARPROC ws = GetProcAddress(dll, "WakeByAddressSingle");
        logline("  WakeByAddressSingle = 0x%p", (void *)ws);
      }
    } else {
      logline("  -> 返回 NULL，会安全回退到 KeyedEvent 后端（**这是期望行为**）");
    }
  }

  logline("");
  logline("===== 全部探测执行完毕，未发生崩溃 =====");
  logline("结论：GetModuleHandleA 对 apiset 名是**安全**的，");
  logline("      SilverMoon 崩溃另有原因（需要看 SilverMoon 自己的日志）。");
}

int WINAPI WinMain(HINSTANCE hi, HINSTANCE hp, LPSTR cmd, int show) {
  (void)hi;
  (void)hp;
  (void)cmd;
  (void)show;
  open_logs();

  int gui = (cmd && strstr(cmd, "--gui") != NULL);
  if (gui) {
    /* 先跑，结果攒起来，最后 MessageBox —— 崩了就到不了 MessageBox，
       但 trace 文件里已有记录 */
    run_all();
    char msg[4096];
    _snprintf(msg, sizeof(msg),
              "复现程序执行完毕，未崩溃。\r\n\r\n"
              "详细轨迹见 exe 同目录的 repro-trace.log\r\n\r\n"
              "如果本程序没崩，说明 GetModuleHandleA(apiset) 是安全的，\r\n"
              "SilverMoon 的崩溃需要另找原因。");
    MessageBoxA(NULL, msg, "SilverMoon Win7 复现 —— 未崩溃", MB_OK | MB_ICONINFORMATION);
  } else {
    /* 控制台模式：自己 attach 一个 */
    run_all();
    printf("\n轨迹已写入：\n");
    int i;
    for (i = 0; i < g_path_count; i++) printf("  %s\n", g_paths[i]);
    printf("\n按任意键退出…\n");
    getchar();
  }
  return 0;
}

/* 说明：显式提供 main()，便于 -mconsole 构建。 */
int main(int argc, char **argv) {
  (void)argc;
  return WinMain(NULL, NULL, (argc > 1 ? argv[1] : ""), SW_SHOW);
}
