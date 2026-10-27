/** 已迁移行优先用稳定键；存量行按当前语言标签定位，范围限定为当前分区。 */
export function findSettingTarget(
  root: HTMLElement,
  key: string,
  label: string,
): HTMLElement | null {
  const anchored = [...root.querySelectorAll<HTMLElement>("[data-setting]")].find(
    (element) => element.dataset.setting === key,
  );
  if (anchored) return anchored;
  const legacy = [
    ...root.querySelectorAll<HTMLElement>(".row-label, .hint, h3, label, m3e-button"),
  ].find((element) => element.textContent?.trim() === label);
  return (
    legacy?.closest<HTMLElement>(".settings-option") ??
    legacy?.closest<HTMLElement>(".row") ??
    legacy ??
    null
  );
}
