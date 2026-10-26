import { onBeforeUnmount, onMounted, type Ref } from "vue";

/** 仅供自绘弹层；原生 m3e-dialog 的 top-layer 生命周期仍由库负责。 */
const layers: symbol[] = [];
let previousOverflow = "";
let background: HTMLElement | null = null;
let previousInert = false;

export function useModalLayer(surface: Ref<HTMLElement | null>, close: () => void) {
  const id = Symbol("modal");
  let trigger: HTMLElement | null = null;
  let frame = 0;

  onMounted(() => {
    trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!layers.length) {
      previousOverflow = document.body.style.overflow;
      background = document.getElementById("app");
      previousInert = background?.inert ?? false;
      document.body.style.overflow = "hidden";
      if (background) background.inert = true;
    }
    layers.push(id);
    frame = requestAnimationFrame(() => surface.value?.focus());
  });

  onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    const index = layers.indexOf(id);
    if (index < 0) return;
    const wasTop = index === layers.length - 1;
    layers.splice(index, 1);
    if (!layers.length) {
      document.body.style.overflow = previousOverflow;
      if (background) background.inert = previousInert;
      background = null;
    }
    if (wasTop && trigger?.isConnected) trigger.focus({ preventScroll: true });
  });

  return {
    onEscape(event: KeyboardEvent) {
      if (layers.at(-1) !== id || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    },
  };
}
