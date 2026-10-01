<script setup lang="ts">
/**
 * 封面图组件：把原始 URL 转成 `app-cover://` 代理地址，由主进程统一取图
 * （防盗链 Referer/UA 伪装、磁盘缓存、并发去重、负缓存——见 electron/protocols.ts）。
 * 加载失败（死链/网络断）显示内联占位图，不再出现"alt 文本裸奔"的裂图。
 * 传 alt 覆盖默认；保留 loading="lazy" / decoding="async"。
 */
import { ref, watch } from "vue";
import { COVER_FALLBACK_DATA_URL, toCoverProxyUrl } from "@/utils/onlineCache";

const props = withDefaults(defineProps<{ url?: string; alt?: string }>(), { url: "", alt: "" });

const src = ref("");
/** 加载失败后切占位图；URL 变化时复位允许重试。 */
const failed = ref(false);

watch(
  () => props.url,
  (url) => {
    failed.value = false;
    src.value = url ? toCoverProxyUrl(url) : "";
  },
  { immediate: true },
);

function onError() {
  if (failed.value) return;
  failed.value = true;
  src.value = COVER_FALLBACK_DATA_URL;
}
</script>

<template>
  <img :src="src" :alt="alt" loading="lazy" decoding="async" @error="onError" />
</template>
