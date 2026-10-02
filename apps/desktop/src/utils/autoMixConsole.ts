/**
 * 把 AutoMix 的调试接口挂到 window 上，供浏览器控制台直接调用。
 *
 * 之所以放控制台而不是做一整个调试面板：AutoMix 的决策依赖「时序」（还剩几秒、
 * 分析好了没、对拍比值多少），这些在 UI 上很难看清，但在控制台里可以随时
 * 敲一行命令、翻看最近 100 条流程记录，定位「为什么这次没对拍」最快。
 *
 * 挂载点在 main.ts，且**始终挂载**（不依赖开关）：
 * 不开详细日志时它也是静默的，只是允许你随时 enable() 打捞现场。
 */
import { clearAnalysisCache } from "./autoMixAnalysis";
import { clearEntries, getEntries, isVerbose, requestForceMix, setVerbose } from "./autoMixLog";

/** 控制台 API 的形状（同时给 TS 一个准确的类型） */
export interface AutoMixConsole {
  /** 开启详细日志（每一步流程都会打到控制台） */
  enable: () => void;
  /** 关闭详细日志 */
  disable: () => void;
  /** 当前是否在打详细日志 */
  verbose: () => boolean;
  /** 当前设置与运行时状态 */
  status: () => unknown;
  /** 最近 100 条流程记录 */
  trace: () => unknown;
  /** 最近一次过渡的完整决策依据 */
  last: () => unknown;
  /** 清空流程记录 */
  clear: () => void;
  /** 清空分析缓存（下次播放会重新分析） */
  clearCache: () => Promise<void>;
  /** 强制在下一次曲末执行一次过渡（即使设置里是关闭的） */
  forceMix: () => void;
  /** 帮助 */
  help: () => void;
}

const HELP = [
  "AutoMix 调试命令：",
  "  __automix.enable()      开启详细日志（每步流程打到控制台）",
  "  __automix.disable()     关闭详细日志",
  "  __automix.status()      当前设置与运行时状态",
  "  __automix.trace()       最近 100 条流程记录",
  "  __automix.last()        最近一次过渡的完整决策依据",
  "  __automix.clear()       清空流程记录",
  "  __automix.clearCache()  清空分析缓存",
  "  __automix.forceMix()    强制下一次曲末执行一次过渡",
].join("\n");

/**
 * 安装控制台接口。
 *
 * `getStatus` / `getLast` 由调用方注入 —— 避免这里直接依赖 player store
 * （store 依赖链很长，在 main.ts 顶层 import 可能触发循环依赖）。
 */
export function installAutoMixConsole(getStatus: () => unknown, getLast: () => unknown): void {
  if (typeof window === "undefined") return;
  const api: AutoMixConsole = {
    enable: () => setVerbose(true),
    disable: () => setVerbose(false),
    verbose: () => isVerbose(),
    status: () => {
      const s = getStatus();
      console.log(s);
      return s;
    },
    trace: () => {
      const rows = getEntries();
      console.log(`共 ${rows.length} 条记录`);
      return rows;
    },
    last: () => {
      const l = getLast();
      console.log(l ?? "还没有执行过过渡");
      return l;
    },
    clear: () => clearEntries(),
    clearCache: () => clearAnalysisCache(),
    forceMix: () => requestForceMix(),
    help: () => console.log(HELP),
  };
  (window as unknown as { __automix?: AutoMixConsole }).__automix = api;
  // 首次安装时给一行提示，让用户知道有这个能力
  console.log("[AutoMix] 调试接口已就绪，输入 __automix.help() 查看命令");
}
