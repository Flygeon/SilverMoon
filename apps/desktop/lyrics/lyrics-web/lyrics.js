/**
 * 桌面歌词窗口的渲染层。
 *
 * ## 职责边界
 *
 * - Rust 侧：窗口、任务栏嵌入、WebView2、消息搬运；
 * - 本文件：把歌词数据渲染成画面 + 逐字填充 + 频谱绘制。
 *
 * 渲染留在 Web 侧是**刻意的**：Rust 侧换 Win32 窗口是为了「真嵌入」，
 * 不是为了重写渲染。现有的动画手感（缓动曲线、双文字层裁切）在 CSS 里
 * 表达最自然，换成 GDI 手绘只会更难调。
 *
 * ## 数据从哪来
 *
 * 宿主（Electron 主进程）经 stdin 推 JSON → Rust 的 bridge.rs 转成
 * `window.__smLyrics.state({...})` 调用 → 这里接收。
 */
(() => {
  "use strict";

  /** @type {{time:number,text:string,translation?:string,bg?:string,units?:{start:number,end:number}[]}[]} */
  let lines = [];
  /** 宿主推来的权威播放时间（秒） */
  let authoritativeTime = 0;
  let playing = false;
  /**
   * 本地自走时钟（秒）。
   *
   * 宿主 200ms 才推一次时间，直接拿它做逐字填充会一跳一跳。
   * 这里在两次推送之间按真实经过时间累加，收到推送再校准 ——
   * 于是填充平滑到帧级，而**推送频率不必提高**。
   */
  let clock = 0;
  let lastFrameAt = 0;
  let currentIndex = -1;

  let showTranslation = true;
  let wordByWord = true;

  const elBase = document.getElementById("base");
  const elScan = document.getElementById("scan");
  const elSub = document.getElementById("sub");
  const elCanvas = document.getElementById("spectrum");

  /** 频谱数据与平滑后的柱高 */
  let bins = null;
  let smoothed = [];
  const BARS = 32;

  // ---------------------------------------------------------------- 纯计算

  /** 数视觉字符数（中文一字、emoji 一个） */
  function charCount(text) {
    return Array.from(text).length;
  }

  /** 行结束时间：优先下一行起点，其次末词结束，最后按字数估算 */
  function resolveLineEnd(line, nextTime) {
    if (nextTime !== undefined && nextTime > line.time) return nextTime;
    if (line.units && line.units.length) return line.units[line.units.length - 1].end;
    return line.time + Math.max(2, charCount(line.text) * 0.4);
  }

  /**
   * 计算填充比例（0-1）。与 Rust 侧 karaoke.rs 的语义**逐条对齐**：
   * 按字符位置插值、词间空隙停上一词末尾、无词级时间轴则匀速。
   */
  function computeFill(line, nextTime, time) {
    const start = line.time;
    const end = resolveLineEnd(line, nextTime);
    if (time <= start) return 0;
    if (time >= end) return 1;

    const units = line.units;
    if (!units || !units.length) {
      const span = end - start;
      return span <= 0 ? 1 : clamp01((time - start) / span);
    }

    const total = charCount(line.text);
    if (total === 0) return 0;

    const spans = buildCharSpans(total, units.length);
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      const [from, to] = spans[i];
      if (time < u.start) return clamp01(from / total);
      if (time < u.end) {
        const unitSpan = u.end - u.start;
        const ratio = unitSpan <= 0 ? 1 : (time - u.start) / unitSpan;
        return clamp01((from + (to - from) * ratio) / total);
      }
    }
    return clamp01(spans[spans.length - 1][1] / total);
  }

  /** 每个词占的字符区间（均匀分配剩余字符，词多于字也不越界） */
  function buildCharSpans(total, unitCount) {
    const spans = [];
    let cursor = 0;
    for (let i = 0; i < unitCount; i++) {
      const remainingUnits = unitCount - i;
      const remainingChars = total - cursor;
      const take =
        remainingUnits <= 1 ? remainingChars : Math.round(remainingChars / remainingUnits);
      const size = Math.max(1, Math.min(take, remainingChars));
      spans.push([cursor, cursor + size]);
      cursor += size;
    }
    return spans;
  }

  function clamp01(v) {
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  }

  // ---------------------------------------------------------------- 渲染

  /** 找到当前行下标（-1 = 还没到第一行） */
  function findIndex(time) {
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (time >= lines[i].time) idx = i;
      else break;
    }
    return idx;
  }

  function render() {
    if (!lines.length) {
      elBase.textContent = "SilverMoon";
      elScan.textContent = "SilverMoon";
      elSub.textContent = "";
      elScan.style.clipPath = "inset(0 100% 0 0)";
      return;
    }

    const idx = findIndex(clock);
    const line = idx >= 0 ? lines[idx] : undefined;
    const text = line ? line.text : lines[0].text;
    const next = idx >= 0 ? lines[idx + 1] : lines[0];

    // 换行时才写文本（写 DOM 会触发布局，每帧写会掉帧）
    if (idx !== currentIndex) {
      currentIndex = idx;
      elBase.textContent = text;
      elScan.textContent = text;
    }

    // 逐字填充：两层裁切严格互补
    if (wordByWord && line) {
      const fill = computeFill(line, next && next.time, clock);
      const pct = fill * 100;
      elScan.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    } else {
      // 关掉逐字时整行高亮
      elScan.style.clipPath = line ? "inset(0 0 0 0)" : "inset(0 100% 0 0)";
    }

    // 副行：翻译优先，其次背景和声
    if (showTranslation) {
      const tr = line && line.translation;
      const bg = line && line.bg;
      elSub.textContent = tr && tr !== text ? tr : bg && bg !== text ? bg : "";
    } else {
      elSub.textContent = "";
    }
  }

  /** 频谱绘制（上升跟手、下降缓动 —— 与 Rust 的 smooth_bar 同策略） */
  function drawSpectrum() {
    const dpr = window.devicePixelRatio || 1;
    const rect = elCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (elCanvas.width !== w || elCanvas.height !== h) {
      elCanvas.width = w;
      elCanvas.height = h;
    }
    const ctx = elCanvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const target = new Array(BARS).fill(0);
    if (bins && bins.length) {
      for (let i = 0; i < BARS; i++) {
        const a = bins[i * 2] || 0;
        const b = bins[i * 2 + 1] || 0;
        target[i] = Math.max(a, b) / 255;
      }
    }
    if (smoothed.length !== BARS) smoothed = new Array(BARS).fill(0);
    for (let i = 0; i < BARS; i++) {
      const t = target[i];
      smoothed[i] = t > smoothed[i] ? t : smoothed[i] * 0.75 + t * 0.25;
    }

    const gap = Math.round(2 * dpr);
    const barW = Math.max(1, (w - gap * (BARS - 1)) / BARS);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (let i = 0; i < BARS; i++) {
      const barH = Math.max(2 * dpr, smoothed[i] * h);
      ctx.fillRect(i * (barW + gap), h - barH, barW, barH);
    }
  }

  /** 主循环：推进时钟 + 重绘 */
  function frame(now) {
    const prev = lastFrameAt || now;
    const dt = (now - prev) / 1000;
    lastFrameAt = now;
    // 上限 0.25s：窗口被挂起后回来时别让时钟一次跳很远
    if (playing && dt > 0 && dt < 0.25) clock += dt;

    render();
    if (document.body.classList.contains("spectrum-mode")) drawSpectrum();

    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- 宿主接口

  window.__smLyrics = {
    state(payload) {
      if (!payload) return;
      lines = Array.isArray(payload.lines) ? payload.lines : [];
      authoritativeTime = payload.currentTime || 0;
      playing = !!payload.playing;
      // 校准：偏差大就硬拉，否则平滑逼近（避免画面抖）
      if (Math.abs(clock - authoritativeTime) > 0.35) clock = authoritativeTime;
      else clock = clock * 0.8 + authoritativeTime * 0.2;
      // 换歌时重置行缓存，强制重写文本
      if (currentIndex >= lines.length) currentIndex = -1;
    },
    spectrum(payload) {
      bins = payload && Array.isArray(payload.bins) ? payload.bins : null;
      document.body.classList.toggle("spectrum-mode", !lines.length);
    },
    settings(payload) {
      if (!payload) return;
      if (typeof payload.fontSize === "number") {
        document.documentElement.style.setProperty("--font-size", payload.fontSize + "px");
      }
      if (typeof payload.opacity === "number") {
        document.getElementById("root").style.opacity = String(payload.opacity / 100);
      }
      if (typeof payload.showTranslation === "boolean") showTranslation = payload.showTranslation;
      if (typeof payload.wordByWord === "boolean") wordByWord = payload.wordByWord;
    },
    quit() {
      // 页面无权关窗口，交给宿主：这里只是清空画面，避免残留内容
      lines = [];
      render();
    },
  };

  requestAnimationFrame(frame);
})();
