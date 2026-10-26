/**
 * 桌面设计守卫：存量按文件设置只减不增预算，新文件默认零预算。
 * Vue / CSS 分别由官方 SFC 编译器与其 PostCSS AST 解析，不自造解析器。
 * --baseline 仅生成审计数据；不得用它自动接受新增违规。
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, compileStyle } from "vue/compiler-sfc";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BASELINE = path.join(ROOT, "doc/design/desktop-design-baseline.json");
const METRICS = [
  "literalColors",
  "literalLayout",
  "vendorInternals",
  "rawControls",
  "globalLayers",
];
const LIBRARY_FIELDS = new Set(["m3e-search-bar", "m3e-form-field"]);
const NATIVE_INPUTS = new Set(["file", "color", "range"]);
// 内容卡片是已评审例外：原生 button 提供键盘激活，不是自绘通用按钮。
const CONTENT_CARDS = new Set(["MediaCardShell.vue", "BilibiliCard.vue"]);

export function inspectDesign(source, filename) {
  const counts = Object.fromEntries(METRICS.map((name) => [name, 0]));
  let styles;
  if (filename.endsWith(".vue")) {
    const { descriptor, errors } = parse(source, { filename });
    if (errors.length) throw new Error(filename + ": " + errors.join("; "));
    styles = descriptor.styles.map((style) => style.content);
    function visit(node, parents = []) {
      if (node.type === 1) {
        const type = node.props.find((prop) => prop.type === 6 && prop.name === "type")?.value
          ?.content;
        const field = parents.some((tag) => LIBRARY_FIELDS.has(tag));
        const native = node.tag === "input" && NATIVE_INPUTS.has(type);
        const content = node.tag === "button" && CONTENT_CARDS.has(path.basename(filename));
        if (
          ["button", "input", "select", "textarea"].includes(node.tag) &&
          !field &&
          !native &&
          !content
        ) {
          counts.rawControls++;
        }
        parents = [...parents, node.tag];
      }
      for (const child of node.children ?? []) visit(child, parents);
    }
    if (descriptor.template?.ast) visit(descriptor.template.ast);
  } else {
    styles = [source];
  }
  for (const source of styles) {
    const result = compileStyle({ source, filename, id: "desktop-design-audit" });
    if (result.errors.length) throw new Error(filename + ": " + result.errors.join("; "));
    result.rawResult.root.walkDecls((decl) => {
      if (/#([0-9a-f]{3,8})\b|\b(?:rgba?|hsla?|oklch|lab|lch)\(/i.test(decl.value)) {
        counts.literalColors++;
      }
      if (
        /^(?:(?:row-|column-)?gap|padding(?:-.+)?|margin(?:-.+)?|border-radius)$/.test(decl.prop)
      ) {
        if (/(?:^|[\s,(])\d*\.?\d+(?:px|rem|em)\b/.test(decl.value)) counts.literalLayout++;
      }
      if (decl.prop === "z-index" && /^\d+$/.test(decl.value) && Number(decl.value) > 10) {
        counts.globalLayers++;
      }
    });
    result.rawResult.root.walkRules((rule) => {
      if (
        rule.selector.includes("::part(") ||
        (rule.selector.includes(":deep(") && rule.selector.includes("m3e-"))
      ) {
        counts.vendorInternals++;
      }
    });
  }
  return counts;
}

export function checkBudget(actual, baseline) {
  const failures = [];
  for (const [file, counts] of Object.entries(actual)) {
    for (const name of METRICS) {
      const budget = baseline[file]?.[name] ?? 0;
      if (counts[name] > budget)
        failures.push(file + ": " + name + " " + counts[name] + " > " + budget);
    }
  }
  return failures;
}

function collect(directory, actual) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["assets", "tokens", "__tests__"].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(full, actual);
    else if (/\.(vue|css)$/.test(entry.name)) {
      const key = path.relative(ROOT, full).split(path.sep).join("/");
      actual[key] = inspectDesign(readFileSync(full, "utf8"), full);
    }
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const actual = {};
  collect(path.join(ROOT, "src"), actual);
  if (process.argv.includes("--baseline")) {
    const legacy = Object.fromEntries(
      Object.entries(actual).filter(([, counts]) => Object.values(counts).some(Boolean)),
    );
    writeFileSync(BASELINE, JSON.stringify(legacy, null, 2) + "\n");
    console.log("Design baseline generated: " + Object.keys(legacy).length + " legacy files.");
  } else {
    const failures = checkBudget(actual, JSON.parse(readFileSync(BASELINE, "utf8")));
    if (failures.length) {
      console.error(failures.join("\n"));
      process.exitCode = 1;
    } else console.log("Desktop design guard passed: " + Object.keys(actual).length + " files.");
  }
}
