import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * `entriesByType` 的 shallowRef 不变量守卫。
 *
 * 这个 store 之前用 `ref`（深响应），会把**全库**条目逐个包上 Proxy；
 * 改成 `shallowRef` 后省掉那份开销，但代价是**就地修改不再触发更新** ——
 * 这是一个 typecheck 抓不到、只在运行时表现为「界面不刷新」的陷阱。
 *
 * 所以用静态守卫把不变量钉住：所有写入都必须是「替换外层对象」。
 * （本仓库已有同类先例：chipClick.test.ts / splashContract.test.ts。）
 */

const SRC = readFileSync(fileURLToPath(new URL("../library.ts", import.meta.url)), "utf8");

describe("entriesByType 的 shallowRef 不变量", () => {
  it("用 shallowRef 声明 —— 深响应会为全库条目建 Proxy", () => {
    expect(SRC).toMatch(/const entriesByType = shallowRef</);
    // 防止有人"顺手"改回 ref
    expect(SRC).not.toMatch(/const entriesByType = ref</);
  });

  it("所有写入都是「替换外层对象」", () => {
    const assigns = [...SRC.matchAll(/entriesByType\.value\s*=\s*([^\n;]+)/g)].map((m) =>
      m[1].trim(),
    );
    expect(assigns.length).toBeGreaterThan(0);
    for (const rhs of assigns) {
      // 合法形式：对象字面量（{ ...entriesByType.value, [type]: x } / {}）
      // 或一个整体对象变量（next）
      const ok = rhs.startsWith("{") || /^[a-zA-Z_$][\w$]*$/.test(rhs);
      expect(ok, `非整体替换的写法：${rhs}`).toBe(true);
    }
  });

  it("没有就地改数组的写法（push/splice/sort 不会触发 shallowRef 更新）", () => {
    expect(SRC).not.toMatch(
      /entriesByType\.value\[[^\]]+\]\.(push|splice|sort|pop|shift|unshift)\(/,
    );
    expect(SRC).not.toMatch(/entriesByType\.value\[[^\]]+\]\s*=/);
  });

  it("就地改字段后必须再替换一次外层对象（toggleFavorite 的这条不能删）", () => {
    const hit =
      /hit\.favorite = next;[\s\S]{0,240}?entriesByType\.value = \{ \.\.\.entriesByType\.value \}/.exec(
        SRC,
      );
    expect(hit, "toggleFavorite 就地改了 favorite，必须紧跟一次外层替换").not.toBeNull();
  });
});
