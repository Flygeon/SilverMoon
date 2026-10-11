<script setup lang="ts">
/**
 * 插件 UI 注入面板（主界面内嵌）。
 *
 * 把扩展自带的前端以 `ext:` 协议嵌进主窗口，用于 `contributes.ui[]` 里
 * `surface: "main"` 的注入点。与 ExtensionHost.vue 的区别：
 *
 * - ExtensionHost：另开一个**独立窗口**，扩展独占整个界面（适合工具型扩展）；
 * - 本组件：嵌在**主窗口内容区**的一块（适合「在库页面上加一条状态栏 / 一个信息卡」
 *   这类轻量增强）。
 *
 * 两者共用同一套 postMessage 桥协议，扩展侧代码不需要为「我是嵌进去还是弹出来」
 * 写两套逻辑 —— 父窗口是谁它不关心，只管 `window.parent.postMessage`。
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { appDataDir, join } from "@/ipc/paths";
import { toAssetUrl } from "@/ipc/invoke";
import { capabilities, isDesktop } from "@/capabilities";
import { defaultsFrom, getExtSettings, setExtSettings } from "@/utils/pluginSettings";
import { useSkinsStore } from "@/stores/skins";
import type { ExtManifest, ExtUiSurface } from "@shared/types";

const props = defineProps<{
  surface: ExtUiSurface;
  /** 皮肤应用等宿主能力要用到（bridge handler 里） */
  manifest?: ExtManifest | null;
}>();

const iframeRef = ref<HTMLIFrameElement | null>(null);
const src = ref("");
const error = ref("");
const host = "lumiluna-host";

/** 与 ExtensionHost 一致的 source 校验（含 miaohui 旧包兼容） */
function acceptedSources(ext: string): string[] {
  return ext === "miaohui" ? [`ext:${ext}`, "miaohui-ext"] : [`ext:${ext}`];
}

async function buildSrc() {
  error.value = "";
  if (!isDesktop) {
    error.value = "浏览器预览下无法加载插件 UI（需要桌面端宿主）";
    return;
  }
  const s = props.surface;
  try {
    const base = await appDataDir();
    const dir = await join(base, "extensions", s.extId, ...s.relIndex.split("/").filter(Boolean));
    src.value = `${toAssetUrl(dir, "ext")}?ext=${encodeURIComponent(s.extId)}&route=${encodeURIComponent(s.route)}`;
  } catch (e) {
    error.value = `解析插件 UI 路径失败：${String(e)}`;
    src.value = "";
  }
}

/** 与 ExtensionHost 相同的分发：宿主保留方法就地处理，其余转发引擎 */
async function handleInvoke(ext: string, method: string, payload: unknown): Promise<unknown> {
  const args = (payload ?? {}) as Record<string, unknown>;
  switch (method) {
    case "settings:get": {
      const mf = props.manifest ?? (await capabilities.extGet(ext).catch(() => null));
      return { values: await getExtSettings(ext, defaultsFrom(mf)) };
    }
    case "settings:set":
      await setExtSettings(ext, (args.values ?? {}) as Record<string, unknown>);
      return { ok: true };
    case "themes:list": {
      const all = await capabilities.extThemes();
      const want = typeof args.extId === "string" && args.extId ? args.extId : null;
      return { themes: want ? all.filter((t) => t.extId === want) : all };
    }
    case "themes:apply": {
      const themeId = String(args.themeId ?? "");
      if (!themeId) throw new Error("themes:apply 缺少 themeId");
      const target = typeof args.extId === "string" && args.extId ? args.extId : ext;
      await useSkinsStore().applyExtTheme(target, themeId);
      return { ok: true };
    }
    case "themes:clear":
      await useSkinsStore().clearExtTheme();
      return { ok: true };
    case "ui:openWindow": {
      const target = String(args.extId ?? "");
      if (!target) throw new Error("ui:openWindow 缺少 extId");
      await capabilities.extOpenWindow(target);
      return { ok: true };
    }
    default:
      return capabilities.extInvoke(ext, method, payload ?? {});
  }
}

function onMessage(ev: MessageEvent) {
  const m = ev.data as {
    source?: string;
    type?: string;
    reqId?: string;
    method?: string;
    payload?: unknown;
  } | null;
  const ext = props.surface.extId;
  if (!m || !m.reqId || m.type !== "invoke" || !acceptedSources(ext).includes(m.source ?? ""))
    return;
  // 消息必须来自本组件那个 iframe（所有扩展共享 ext://localhost 这个 origin）
  if (ev.source && iframeRef.value && ev.source !== iframeRef.value.contentWindow) return;
  const reply = (ok: boolean, data?: unknown, err?: string) => {
    iframeRef.value?.contentWindow?.postMessage(
      { source: host, type: "invoke-result", reqId: m.reqId, ok, data, error: err },
      "*",
    );
  };
  handleInvoke(ext, m.method ?? "", m.payload ?? {})
    .then((data) => reply(true, data))
    .catch((e) => reply(false, undefined, String(e)));
}

onMounted(() => {
  window.addEventListener("message", onMessage);
  void buildSrc();
});
onBeforeUnmount(() => window.removeEventListener("message", onMessage));
watch(
  () => [props.surface.extId, props.surface.route, props.surface.relIndex],
  () => void buildSrc(),
);
</script>

<template>
  <div class="ext-embed" :style="{ height: (surface.height ?? 160) + 'px' }">
    <div v-if="error" class="err">{{ error }}</div>
    <iframe
      v-else-if="src"
      ref="iframeRef"
      class="frame"
      :src="src"
      :title="surface.title"
      allow="clipboard-read; clipboard-write"
    ></iframe>
  </div>
</template>

<style scoped>
.ext-embed {
  width: 100%;
  background: #1b1d22;
  border: 1px solid var(--md-sys-color-outline-variant, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 16px;
}
.frame {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
  background: #1b1d22;
}
.err {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--md-sys-color-on-surface-variant, rgba(255, 255, 255, 0.5));
  font-size: 13px;
  padding: 12px;
  text-align: center;
}
</style>
