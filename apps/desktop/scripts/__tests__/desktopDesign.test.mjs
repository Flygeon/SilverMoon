import { describe, expect, it } from "vitest";
import { inspectDesign, checkBudget } from "../verify-desktop-design.mjs";

describe("desktop design guard", () => {
  it("detects new colors, spacing and global layers in parsed CSS", () => {
    const counts = inspectDesign(".x { color: #fff; gap: 8px; z-index: 99 }", "demo.css");
    expect(counts.literalColors).toBe(1);
    expect(counts.literalLayout).toBe(1);
    expect(counts.globalLayers).toBe(1);
    expect(checkBudget({ "demo.css": counts }, {})).toHaveLength(3);
  });
  it("permits tokens and local stacking", () => {
    const counts = inspectDesign(
      ".x { color: var(--lm-text-secondary); gap: var(--lm-space-8); z-index: 1 }",
      "demo.css",
    );
    expect(Object.values(counts).every((value) => value === 0)).toBe(true);
  });
  it("counts raw controls while preserving native library fields and color pickers", () => {
    const source =
      '<template><div><button>Custom</button><input /><m3e-form-field><input /></m3e-form-field><input type="color" /></div></template>';
    expect(inspectDesign(source, "Demo.vue").rawControls).toBe(2);
  });
  it("catches library internal selectors but allows documented public tokens", () => {
    expect(
      inspectDesign(".x :deep(m3e-menu .internal) {color: var(--lm-text-secondary)}", "demo.css")
        .vendorInternals,
    ).toBe(1);
    expect(
      inspectDesign(".x { --m3e-menu-container-color: var(--md-sys-color-surface) }", "demo.css")
        .vendorInternals,
    ).toBe(0);
  });
  it("does not transfer deleted file budgets to new files", () => {
    const counts = inspectDesign(".x {color: #fff}", "new.css");
    expect(checkBudget({ "new.css": counts }, { "old.css": counts })).toHaveLength(1);
  });
});
