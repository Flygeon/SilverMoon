<script lang="ts">
/**
 * 全局轻提示（M3 snackbar 风格）。
 *
 * 状态挂在模块作用域（不是组件实例）上，因此任何地方都能 `import { useAppToast }`
 * 直接弹提示，不需要注入/透传；`<AppToast />` 只在 App.vue 挂一次，Teleport 到 body。
 */
import { reactive } from "vue";

export interface AppToastOptions {
  /** error 用 error-container 配色，其余用 inverse-surface */
  tone?: "info" | "error";
  /** 毫秒；<=0 表示不自动消失 */
  duration?: number;
}

interface AppToastState {
  visible: boolean;
  message: string;
  tone: "info" | "error";
}

const toastState = reactive<AppToastState>({ visible: false, message: "", tone: "info" });

/** 默认停留时长（与设置页等既有提示的观感一致） */
const TOAST_MS = 3000;
let hideTimer: number | null = null;

export function useAppToast(): {
  state: AppToastState;
  show: (message: string, options?: AppToastOptions) => void;
  hide: () => void;
} {
  function hide() {
    toastState.visible = false;
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function show(message: string, options: AppToastOptions = {}) {
    if (!message) return;
    toastState.message = message;
    toastState.tone = options.tone ?? "info";
    toastState.visible = true;
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    const duration = options.duration ?? TOAST_MS;
    if (duration <= 0) {
      hideTimer = null;
      return;
    }
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      toastState.visible = false;
    }, duration);
  }

  return { state: toastState, show, hide };
}

/** 便捷函数：组件外（菜单、store、Dialog）直接弹一句话 */
export function showAppToast(message: string, options?: AppToastOptions): void {
  useAppToast().show(message, options);
}
</script>

<script setup lang="ts">
// useAppToast 与本块同处一个模块作用域（见上面的普通 <script>），无需再 import
const { state, hide } = useAppToast();
</script>

<template>
  <Teleport to="body">
    <Transition name="app-toast">
      <div
        v-if="state.visible"
        class="app-toast"
        :class="state.tone"
        role="status"
        aria-live="polite"
        @click="hide"
      >
        <span class="material-symbols-outlined">
          {{ state.tone === "error" ? "error" : "info" }}
        </span>
        <span class="app-toast-text">{{ state.message }}</span>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.app-toast {
  position: fixed;
  left: 50%;
  bottom: 96px;
  z-index: 3000;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(560px, calc(100vw - 48px));
  padding: 12px 18px;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  box-shadow: var(--md-elevation-3);
  font-size: var(--md-sys-typescale-body-medium-size);
  cursor: pointer;
  transform: translateX(-50%);
}
.app-toast.error {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
.app-toast .material-symbols-outlined {
  flex: none;
  font-size: 20px;
}
.app-toast-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-toast-enter-active,
.app-toast-leave-active {
  transition:
    opacity 200ms ease,
    transform 220ms var(--md-sys-motion-spring-spatial);
}
.app-toast-enter-from,
.app-toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 12px);
}
</style>
