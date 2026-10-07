#!/usr/bin/env node
/**
 * 从 react-native-windows 自带的 cpp-app 模板生成 `windows/` 原生工程。
 *
 * **为什么不用 `npx react-native init-windows`**：RNW 0.83 的 CLI 在**加载配置阶段**
 * 就会 require `@react-native-windows/find-dotnet-tools` 去探测 .NET SDK 与 pwsh，
 * 探测失败会直接抛错，导致整个 CLI 连 `init-windows` 都注册不上（在没装 VS/.NET 的
 * 机器上必然如此）。这里改用同一份模板 + 同一套替换规则自己生成，产出与 CLI 一致：
 *
 *   - 变量表逐条对照 templates/cpp-app/template.config.js 的 `replacements`
 *   - 文本走 mustache 渲染，二进制按扩展名直通（与 generator-common 的判定一致）
 *   - `_gitignore` / `NuGet_Config` 的重命名、以及文件名里的 `MyApp` 替换同样照搬
 *
 * 用法：`node scripts/generate-windows-project.mjs`
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const rnwRoot = path.dirname(require.resolve('react-native-windows/package.json'));
const templateDir = path.join(rnwRoot, 'templates', 'cpp-app');

// ⚠️ 刻意**不** require `templates/cpp-app/template.config.js`：
// 它会连带加载 `templates/templateUtils.js`，而后者顶层就写着
// `require('@react-native-windows/cli')` —— 那个包一加载就会去探测 .NET SDK 与
// pwsh，在没有 VS / .NET 的机器上直接抛错。这里只需要模板目录，不需要它的配置对象。
const TEMPLATE_NAME = 'React Native Windows Application (New Arch, WinAppSDK, C++)';

// 直接复用 RNW 生成器依赖的同一批包（它们是 @react-native-windows/cli 的依赖，
// npm 会提升到顶层）。刻意**不** require @react-native-windows/cli 本身：
// 那个包一加载就会去探测 .NET SDK / pwsh，在没装 VS 的机器上直接抛错。
const mustache = require('mustache');
const glob = require('glob');
const username = require('username');

const appJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'));
const rnwPkg = JSON.parse(fs.readFileSync(path.join(rnwRoot, 'package.json'), 'utf8'));

const projectName = appJson.name;
const namespace = projectName;
const guid = () => '{' + crypto.randomUUID() + '}';
const projectGuid = guid();
const packageGuid = guid();

const replacements = {
  useMustache: true,
  regExpPatternsToRemove: [],

  name: projectName,
  namespace,
  namespaceCpp: namespace.replace(/\./g, '::'),

  rnwVersion: rnwPkg.version,
  rnwPathFromProjectRoot: path.relative(projectRoot, rnwRoot).replace(/\//g, '\\'),

  mainComponentName: appJson.name,

  projectGuidLower: projectGuid.toLowerCase(),
  projectGuidUpper: projectGuid.toUpperCase(),
  packageGuidLower: packageGuid.toLowerCase(),
  packageGuidUpper: packageGuid.toUpperCase(),

  currentUser: username.sync() ?? 'user',
  devMode: false,
  useNuGets: true,
  addReactNativePublicAdoFeed: true,
  cppNugetPackages: [],

  // 自动链接的占位（与 CLI 的 autolinkWindows 保持一致）
  autolinkPropertiesForProps: '',
  autolinkProjectReferencesForTargets: '',
  autolinkCppIncludes: '',
  autolinkCppPackageProviders: '\n    UNREFERENCED_PARAMETER(packageProviders);',
};

// 与 generator-common 的 binaryExtensions 一致
const BINARY_EXTENSIONS = new Set(['.png', '.jar', '.keystore', '.ico', '.rc']);

function render(srcPath) {
  let content = fs.readFileSync(srcPath, 'utf8');
  const crlf = content.includes('\r\n');
  const vars = { ...replacements };
  for (const key of Object.keys(vars)) {
    if (typeof vars[key] === 'string') {
      vars[key] = crlf ? vars[key].replace(/(?<!\r)\n/g, '\r\n') : vars[key].replace(/\r\n/g, '\n');
    }
  }
  return mustache.render(content, vars);
}

const files = glob.sync('**/*', { cwd: templateDir, nodir: true, ignore: 'template.config.js' });
let written = 0;

for (const file of files) {
  const from = path.join(templateDir, file);
  let to = path.normalize(file);

  const base = path.basename(to);
  if (base === '_gitignore') to = path.join(path.dirname(to), '.gitignore');
  if (base === 'NuGet_Config') to = path.join(path.dirname(to), 'NuGet.config');
  to = to.replace(/MyApp/g, projectName);

  const dest = path.join(projectRoot, to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (BINARY_EXTENSIONS.has(path.extname(from).toLowerCase())) {
    fs.copyFileSync(from, dest);
  } else {
    fs.writeFileSync(dest, render(from), 'utf8');
  }
  written += 1;
  console.log('  ' + to.replace(/\\/g, '/'));
}

console.log(`\n模板 ${TEMPLATE_NAME}（react-native-windows ${rnwPkg.version}）→ 写出 ${written} 个文件`);
console.log(`项目名 ${projectName} / 命名空间 ${namespace} / projectGuid ${projectGuid}`);
