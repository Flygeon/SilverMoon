<script setup lang="ts">
/**
 * 扩展宿主页面（专用窗口，label: extension）。
 *
 * 由 Rust 侧 open_extension_window() 创建并 emit `ext:navigate` 导航事件；
 * 本页面按事件里的 ext/route 加载扩展自带的 web UI，路径与默认路由都读扩展
 * 自己的 manifest（ext_get），宿主不写死任何扩展的产物目录：
 *   <iframe src="ext://.../extensions/<id>/<web.dist>/index.html?ext=&route=">
 * 扩展 UI 在 iframe 内没有宿主桥，通过 postMessage 与本页面通信：
 *   iframe → 本页：{ source: "ext:<扩展 id>", type: "invoke", reqId, method, payload }
 *   本页 → iframe：{ source: "lumiluna-host", type: "invoke-result",
 *                    reqId, ok, data, error }
 * 回复标识 "lumiluna-host" 是**固定**的宿主 token（历史名字，改了会破坏已发布的
 * 扩展包），与扩展 id 无关。
 * invoke 统一走 ext_invoke（open/reveal 由主机拦截代执行，见 extension.rs）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { appDataDir, join } from "@/ipc/paths";
import { toAssetUrl } from "@/ipc/invoke";
import { capabilities, isDesktop } from "@/capabilities";
import { defaultsFrom, getExtSettings, setExtSettings } from "@/utils/extSettings";
import { useSkinsStore } from "@/stores/skins";
import type { ExtManifest } from "@shared/types";

/** 宿主回复扩展时的固定 source 标识（不要改：已发布的扩展包按它匹配回复） */
const HOST_SOURCE = "lumiluna-host";

/**
 * 接受哪些扩展侧 source。
 * 新约定是 `ext:<扩展 id>`；参考扩展 miaohui 的历史构建写死了 "miaohui-ext"，
 * 迁移期对它的旧包一并接受。
 */
function acceptedSources(ext: string): string[] {
  return ext === "miaohui" ? [`ext:${ext}`, "miaohui-ext"] : [`ext:${ext}`];
}

const current = ref<{ ext: string; route: string } | null>(null);
const manifest = ref<ExtManifest | null>(null);
const iframeSrc = ref("");
const loadError = ref("");
const statusText = ref("");

/** 标题栏：优先显示扩展自己的名字与 manifest 声明的 route */
const title = computed(() => {
  if (!current.value) return "扩展";
  const name = manifest.value?.name || current.value.ext;
  return current.value.route ? `${name} · ${current.value.route}` : name;
});

let unNav: (() => void) | null = null;

async function navigateTo(ext: string, route: string) {
  loadError.value = "";
  statusText.value = "";
  if (!isDesktop) {
    current.value = { ext, route };
    loadError.value = "浏览器预览下无法加载扩展 UI（需要桌面端宿主）";
    return;
  }
  try {
    // 路径与默认路由都取自扩展自己的 manifest，不在宿主里写死
    const mf = await capabilities.extGet(ext).catch(() => null);
    manifest.value = mf;
    const effRoute = route || mf?.web?.defaultRoute || "";
    current.value = { ext, route: effRoute };
    // web.dist 允许形如 "web/dist" 的多级路径，拆成 join 的片段
    const dist = (mf?.web?.dist || "web/dist").split("/").filter(Boolean);
    const base = await appDataDir();
    const dir = await join(base, "extensions", ext, ...dist);
    const htmlPath = await join(dir, "index.html");
    // ⚠️ 必须走 ext: 而不是 asset:。
    // 扩展 UI 若用 asset: 加载，自己就站在 asset.localhost 上，与**任意**
    // asset URL 同源（assetProtocol.scope 是 **），能直接 fetch 本机任意文件，
    // 绕过 capabilities/extension.json 里那条限 extensions/** 的 fs:read。
    // ext: 是独立 origin（http://ext.localhost），跨源读取会被 asset 协议的
    // 「ACAO=窗口 origin」判据挡下。见 src-tauri/src/ext_protocol.rs。
    iframeSrc.value = `${toAssetUrl(htmlPath, "ext")}?ext=${encodeURIComponent(ext)}&route=${encodeURIComponent(effRoute)}`;
  } catch (e) {
    current.value = { ext, route };
    loadError.value = `解析扩展 UI 路径失败：${String(e)}`;
    iframeSrc.value = "";
  }
}

// ---- iframe postMessage 桥接 ----
function onMessage(ev: MessageEvent) {
  const m = ev.data as {
    source?: string;
    type?: string;
    reqId?: string;
    method?: string;
    payload?: unknown;
  } | null;
  const ext = current.value?.ext ?? "";
  if (!m || !m.reqId || m.type !== "invoke" || !acceptedSources(ext).includes(m.source ?? "")) {
    return;
  }
  // 更硬的一道：消息必须来自**本页那个 iframe**。
  // 所有扩展共享 ext://localhost 这个 origin，光靠 origin 分不出是谁，
  // 所以这里用 contentWindow 相等来确认来源（也顺带挡住任意其它窗口的 postMessage）。
  if (ev.source && iframeRef.value && ev.source !== iframeRef.value.contentWindow) {
    return;
  }
  const reply = (ok: boolean, data?: unknown, error?: string) => {
    iframeRef.value?.contentWindow?.postMessage(
      { source: HOST_SOURCE, type: "invoke-result", reqId: m.reqId, ok, data, error },
      "*",
    );
  };
  handleInvoke(ext, m.method ?? "", m.payload ?? {})
    .then((data) => reply(true, data))
    .catch((e) => {
      statusText.value = `${m.method} 失败：${String(e)}`;
      reply(false, undefined, String(e));
    });
}

/**
 * 处理一次桥调用。
 *
 * 宿主**保留**的方法在这里就地处理，不转发给引擎：
 *   settings:get / settings:set  —— 扩展私有设置（独立存储，不污染主设置）
 *   themes:list / themes:apply / themes:clear —— 皮肤已改由扩展承载
 * 其余方法一律走 `ext_invoke` 转发到扩展引擎。
 */
async function handleInvoke(ext: string, method: string, payload: unknown): Promise<unknown> {
  const args = (payload ?? {}) as Record<string, unknown>;
  switch (method) {
    case "settings:get": {
      const mf = manifest.value ?? (await capabilities.extGet(ext).catch(() => null));
      return { values: await getExtSettings(ext, defaultsFrom(mf)) };
    }
    case "settings:set": {
      const values = (args.values ?? {}) as Record<string, unknown>;
      await setExtSettings(ext, values);
      return { ok: true };
    }
    case "themes:list":
      return { themes: await capabilities.extThemes() };
    case "themes:apply": {
      // 皮肤的应用仍由前端皮肤引擎完成（CSS 变量/背景/图标都在渲染层）
      const themeId = String(args.themeId ?? "");
      if (!themeId) throw new Error("themes:apply 缺少 themeId");
      // extId 缺省 = 本扩展自己的皮肤；显式传别的 extId 用于**管理器类扩展**
      // （themes:list 是全量的，管理器要能把别人的皮肤也切上去）。
      const targetExt = typeof args.extId === "string" && args.extId ? args.extId : ext;
      const skins = useSkinsStore();
      await skins.applyExtTheme(targetExt, themeId);
      return { ok: true };
    }
    case "themes:clear": {
      const skins = useSkinsStore();
      await skins.clearExtTheme();
      return { ok: true };
    }
    default:
      return capabilities.extInvoke(ext, method, payload ?? {});
  }
}

const iframeRef = ref<HTMLIFrameElement | null>(null);

function closeWindow() {
  window.close();
}

onMounted(async () => {
  window.addEventListener("message", onMessage);
  if (!isDesktop) return;
  unNav = await capabilities.onExtNavigate(({ ext, route }) => {
    // route 为空时交给 manifest 的 web.defaultRoute 决定，宿主不写死默认值
    void navigateTo(ext, route || "");
  });
  // ⚠️ 挂载后**主动拉一次**目标。
  //
  // 新建扩展窗口时，宿主 `build()` 一返回就 emit，而这里的 listen 还没注册上 ——
  // Tauri 事件不缓存，那一发就丢了，窗口会停在下面的「等待导航事件」空白页，
  // 用户得再按一次热键才正常（第二次走「窗口已存在」分支，那时监听早就在了）。
  // 拉取把「推的时机」这个竞态彻底去掉。
  const nav = await capabilities.extCurrentNav().catch(() => null);
  if (nav) void navigateTo(nav.ext, nav.route || "");
});

onBeforeUnmount(() => {
  window.removeEventListener("message", onMessage);
  unNav?.();
  unNav = null;
});
</script>

<template>
  <div class="ext-host">
    <div class="bar">
      <span class="title">{{ title }}</span>
      <button class="close" title="关闭" @click="closeWindow">✕</button>
    </div>
    <div v-if="loadError" class="err">{{ loadError }}</div>
    <iframe
      v-else-if="iframeSrc"
      ref="iframeRef"
      class="ext-frame"
      :src="iframeSrc"
      allow="clipboard-read; clipboard-write"
    ></iframe>
    <div v-else class="err">等待导航事件（由扩展自己声明的热键或托盘项触发）…</div>
  </div>
</template>

<style scoped>
.ext-host {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #1b1d22;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  overflow: hidden;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 34px;
  padding: 0 10px;
  background: rgba(255, 255, 255, 0.04);
  user-select: none;
  flex-shrink: 0;
  /* 本窗口无系统标题栏（frame: false），这一条即是拖拽区。
     子元素里的可点区域必须显式声明 no-drag，否则收不到点击。 */
  -webkit-app-region: drag;
}
.title {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.65);
}
.close {
  -webkit-app-region: no-drag;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.55);
  cursor: pointer;
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 6px;
}
.close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}
.ext-frame {
  flex: 1;
  border: none;
  width: 100%;
  background: #1b1d22;
}
.err {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.45);
  font-size: 13px;
}
</style>
