<script setup lang="ts">
/**
 * 插件管理面板：已安装扩展列表（启用开关 / 卸载）+ 安装（文件夹 / zip）。
 * 引擎状态（engine_ready）与模型下载进度经 ext_invoke 轮询扩展引擎。
 * 注意：文案不进 shared/i18n.ts（项目 WIP 文件，禁止改动）。
 */
import { onActivated, ref } from "vue";
import { open as dialogOpen } from "@/ipc/dialog";
import PageHeader from "@/components/PageHeader.vue";
import { capabilities } from "@/capabilities";
import type { ExtInfo, ExtSource } from "@shared/types";

const list = ref<ExtInfo[]>([]);
const loading = ref(false);
const busy = ref("");
const toast = ref("");
let toastTimer: number | null = null;

function notify(message: string) {
  toast.value = message;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = ""), 3000);
}

async function load() {
  loading.value = true;
  try {
    list.value = await capabilities.extList();
  } catch (e) {
    notify(`加载插件列表失败：${String(e)}`);
  } finally {
    loading.value = false;
  }
}

async function toggle(ext: ExtInfo) {
  busy.value = ext.id;
  try {
    await capabilities.extSetEnabled(ext.id, !ext.enabled);
    ext.enabled = !ext.enabled;
    notify(ext.enabled ? `已启用 ${ext.name}` : `已禁用 ${ext.name}`);
  } catch (e) {
    notify(`切换失败：${String(e)}`);
  } finally {
    busy.value = "";
  }
}

/**
 * 状态文案。
 *
 * `hasEngine` 是关键：没有引擎的扩展（纯 UI，只用宿主保留方法）
 * 永远不会有 `engineReady`，若一律显示"已启用"，用户会以为引擎没起来。
 */
function stateText(ext: ExtInfo): string {
  if (!ext.enabled) return "已禁用";
  if (!ext.hasEngine) return "已启用";
  return ext.engineReady ? "运行中" : "已启用（引擎未启动）";
}

async function openWindow(ext: ExtInfo) {
  try {
    await capabilities.extOpenWindow(ext.id);
  } catch (e) {
    notify(`打开失败：${String(e)}`);
  }
}

async function uninstall(ext: ExtInfo) {
  if (!window.confirm(`卸载插件「${ext.name}」？数据目录（索引/模型）将一并删除。`)) return;
  busy.value = ext.id;
  try {
    await capabilities.extUninstall(ext.id);
    await load();
    notify(`已卸载 ${ext.name}`);
  } catch (e) {
    notify(`卸载失败：${String(e)}`);
  } finally {
    busy.value = "";
  }
}

async function install(kind: "folder" | "zip") {
  const selected = await dialogOpen({
    directory: kind === "folder",
    multiple: false,
    filters: kind === "zip" ? [{ name: "插件包", extensions: ["zip"] }] : undefined,
  });
  if (typeof selected !== "string") return;
  const source: ExtSource =
    kind === "folder" ? { kind: "folder", path: selected } : { kind: "zip", path: selected };
  busy.value = "__install";
  notify("安装中…");
  try {
    const info = await capabilities.extInstall(source);
    await load();
    notify(`已安装 ${info.name} v${info.version}`);
  } catch (e) {
    notify(`安装失败：${String(e)}`);
  } finally {
    busy.value = "";
  }
}

onActivated(load);
</script>

<template>
  <div class="view">
    <PageHeader title="插件" description="为 SilverMoon 安装独立分发的功能插件包" />
    <div class="toolbar">
      <button :disabled="busy !== ''" @click="install('zip')">安装 zip 包</button>
      <button :disabled="busy !== ''" @click="install('folder')">从文件夹安装</button>
      <button :disabled="loading" @click="load">刷新</button>
    </div>
    <p v-if="toast" class="toast">{{ toast }}</p>

    <div v-if="!list.length && !loading" class="empty">
      尚未安装任何插件。<br />
      插件自带引擎与前端、不随主程序分发，安装插件 zip 或文件夹即可。
    </div>

    <div v-for="ext in list" :key="ext.id" class="ext-card">
      <div class="head">
        <div>
          <div class="name">{{ ext.name }}</div>
          <div class="sub">
            id: {{ ext.id }} · v{{ ext.version || "?" }}
            <span class="state" :class="ext.enabled ? 'on' : 'off'">
              {{ stateText(ext) }}
            </span>
            <span v-if="!ext.compatible" class="state bad">API 不兼容</span>
            <!-- 纯 UI 扩展（没有引擎）标出来：用户看"已启用"会以为引擎在跑，
                 但它本来就不需要引擎，光看状态栏分不出来。 -->
            <span v-if="ext.enabled && !ext.hasEngine" class="state plain">纯界面</span>
          </div>
          <div v-if="!ext.compatible" class="warn">
            该插件要求更高的插件 API 版本，已跳过加载：{{ ext.incompatibleReason }}
          </div>
          <div v-else-if="ext.engineError" class="warn">引擎启动失败：{{ ext.engineError }}</div>
          <div class="perms">
            <template v-if="ext.permissions.length">
              权限：<span v-for="p in ext.permissions" :key="p" class="perm">{{ p }}</span>
            </template>
            <span v-else class="legacy">未声明权限（旧版插件包，宿主按兼容模式放行）</span>
          </div>
        </div>
        <div class="ops">
          <button v-if="ext.hasWindow" :disabled="busy === ext.id" @click="openWindow(ext)">
            打开
          </button>
          <button :disabled="busy === ext.id" @click="toggle(ext)">
            {{ ext.enabled ? "禁用" : "启用" }}
          </button>
          <button class="danger" :disabled="busy === ext.id" @click="uninstall(ext)">卸载</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.view {
  padding: 0 20px 40px;
}
.toolbar {
  display: flex;
  gap: 10px;
  margin: 12px 0;
}
.toolbar button {
  padding: 6px 14px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid var(--border, #ccc);
  background: transparent;
}
.toolbar button:hover:not(:disabled) {
  background: rgba(128, 128, 128, 0.1);
}
.toolbar button:disabled {
  opacity: 0.5;
  cursor: default;
}
.toast {
  color: #4a90d9;
  font-size: 13px;
  margin: 4px 0;
}
.empty {
  color: rgba(128, 128, 128, 0.8);
  text-align: center;
  padding: 60px 0;
  line-height: 2;
}
.ext-card {
  border: 1px solid var(--border, #ccc);
  border-radius: 10px;
  padding: 12px 16px;
  margin-bottom: 12px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.name {
  font-weight: 500;
}
.sub {
  font-size: 12px;
  color: rgba(128, 128, 128, 0.9);
  margin-top: 2px;
}
.state {
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
}
.state.on {
  background: rgba(74, 144, 217, 0.15);
  color: #4a90d9;
}
.state.off {
  background: rgba(128, 128, 128, 0.15);
  color: rgba(128, 128, 128, 0.9);
}
.state.bad {
  background: rgba(220, 80, 80, 0.15);
  color: #d05050;
}
.state.plain {
  background: rgba(128, 128, 128, 0.12);
  color: rgba(128, 128, 128, 0.9);
}
.warn {
  margin-top: 6px;
  font-size: 12px;
  color: #d05050;
}
.perms {
  margin-top: 6px;
  font-size: 12px;
  color: rgba(128, 128, 128, 0.95);
}
.perm {
  display: inline-block;
  margin-right: 6px;
  padding: 1px 7px;
  border-radius: 9px;
  background: rgba(128, 128, 128, 0.15);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.legacy {
  color: rgba(180, 140, 60, 0.95);
}
.ops {
  display: flex;
  gap: 8px;
}
.ops button {
  padding: 5px 12px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid var(--border, #ccc);
  background: transparent;
}
.ops .danger:hover {
  background: rgba(220, 80, 80, 0.12);
  border-color: rgba(220, 80, 80, 0.5);
}
</style>
