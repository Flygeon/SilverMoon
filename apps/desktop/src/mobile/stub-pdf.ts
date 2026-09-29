/**
 * 移动端 pdfjs 替身。
 *
 * stores/library.ts 里有一处动态 import("@/utils/pdf") 用于渲染 PDF 书籍封面；
 * 音乐路径永远走不到，但 Vite 会静态分析到它并把 2.2MB 的 pdf.worker 一起产出。
 * 移动端 web 包只承载音乐，这里用替身切断这条边。
 */
export function toArrayBuffer(buf: ArrayBuffer): ArrayBuffer {
  return buf;
}

export async function loadPdfjs(): Promise<never> {
  throw new Error("PDF 阅读在移动端 WebView 中不可用");
}

export async function renderPdfCover(): Promise<never> {
  throw new Error("PDF 封面在移动端 WebView 中不可用");
}
