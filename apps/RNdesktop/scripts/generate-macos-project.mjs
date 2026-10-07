#!/usr/bin/env node
/**
 * 从 react-native-macos 自带的 macOS 模板生成 `macos/` 原生工程。
 *
 * 与 `scripts/generate-windows-project.mjs` 同理：不依赖交互式 init 工具，
 * 直接复用 `react-native-macos/local-cli/generator-macos` 的模板与替换规则
 * （模板里唯一的变量就是项目名 `HelloWorld` → `SilverMoon`）。
 *
 * **注意**：本脚本可以在 Windows / Linux 上跑（只是复制文件 + 文本替换），
 * 但 `macos/` 工程的**构建**必须在 macOS 上进行（`pod install` + Xcode）。
 *
 * 用法：`node scripts/generate-macos-project.mjs`
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const appJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'));
const projectName = appJson.name;
const OLD_NAME = 'HelloWorld';

let rnmRoot;
try {
  rnmRoot = path.dirname(require.resolve('react-native-macos/package.json'));
} catch {
  console.error(
    '找不到 react-native-macos。请先执行：\n' +
      '  npm install --save-dev react-native-macos@0.83.0\n' +
      '（它只在需要生成 / 构建 macOS 工程时才用得到）',
  );
  process.exit(1);
}

const templateRoot = path.join(rnmRoot, 'local-cli', 'generator-macos', 'templates', 'macos');
if (!fs.existsSync(templateRoot)) {
  console.error('模板目录不存在：' + templateRoot);
  process.exit(1);
}

/** 模板里的相对路径 → 目标仓库里的相对路径（与 generator-macos 的映射一致）。 */
function targetPath(rel) {
  const withName = rel.split(path.sep).join('/').replaceAll(OLD_NAME, projectName);
  return path.join('macos', withName);
}

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(path.relative(templateRoot, full));
  }
})(templateRoot);

let written = 0;
for (const rel of files) {
  const from = path.join(templateRoot, rel);
  let to = targetPath(rel);
  // 与 generator-macos 一致：_gitignore 落盘为 .gitignore
  if (path.basename(to) === '_gitignore') {
    to = path.join(path.dirname(to), '.gitignore');
  }

  const dest = path.join(projectRoot, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const ext = path.extname(from).toLowerCase();
  if (ext === '.png' || ext === '.ico') {
    fs.copyFileSync(from, dest);
  } else {
    // generator-common 的 copyAndReplaceAll 在模板变量名是纯标识符时，
    // 走的是「按字面量全局替换」而不是 mustache 渲染
    fs.writeFileSync(dest, fs.readFileSync(from, 'utf8').split(OLD_NAME).join(projectName), 'utf8');
  }
  written += 1;
  console.log('  ' + to.replace(/\\/g, '/'));
}

console.log(`\nmacOS 模板（react-native-macos）→ 写出 ${written} 个文件`);
console.log('下一步（必须在 macOS 上）：');
console.log('  cd macos && pod install');
console.log('  npx react-native run-macos');
