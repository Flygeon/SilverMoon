#!/usr/bin/env node
// 从归档的 shared/i18n.ts 生成 Dart 词条表（apps/desktop/lib/i18n/generated/archive_messages.dart）。
//
// 用法（在 apps/desktop 下）：node tool/gen_archive_messages.mjs
//
// 为什么生成而不是手抄：归档里是 23 组、上千条 zh/en 文案，手抄必然漏译且无法回归。
// 键名 = 原 TS 对象的点号路径，与 Electron 版 translate() 里 split(".") 的语义一致，
// 所以两边的键名可以逐条对应。
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const APP = path.resolve(HERE, '..');
const SRC = path.resolve(APP, '../../archive/electron-desktop/shared/i18n.ts');
const OUT = path.resolve(APP, 'lib/i18n/generated/archive_messages.dart');

const src = fs.readFileSync(SRC, 'utf8');
const start = src.indexOf('{', src.indexOf('export const messages'));
const end = src.lastIndexOf('} as const;');
if (start < 0 || end < 0) throw new Error('没找到 messages 对象字面量');
const messages = new Function('return ' + src.slice(start, end + 1))();

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = String(v);
  }
  return out;
}
const langs = Object.keys(messages);
const flat = {};
for (const l of langs) flat[l] = flatten(messages[l]);

const base = langs[0];
const missing = [];
for (const l of langs) {
  for (const k of Object.keys(flat[base])) if (!(k in flat[l])) missing.push(l + ' 缺 ' + k);
  for (const k of Object.keys(flat[l])) if (!(k in flat[base])) missing.push(l + ' 多 ' + k);
}
// 归档自身就不是严格对称的（en 缺 kugou.trialOnly / kugou.noSource）。
// 这里不报错中止，而是用基准语言补位并在生成物里标注，避免界面出现空文案。
const filled = new Set();
if (missing.length) {
  console.warn('注意：归档 zh/en 不对称 ' + missing.length + ' 处，已用基准语言补位：');
  for (const m of missing) console.warn('  ' + m);
  for (const l of langs) {
    if (l === base) continue;
    for (const k of Object.keys(flat[base])) {
      if (!(k in flat[l])) { flat[l][k] = flat[base][k]; filled.add(l + '.' + k); }
    }
  }
}

const groups = new Map();
for (const k of Object.keys(flat[base])) {
  const g = k.split('.')[0];
  groups.set(g, (groups.get(g) ?? 0) + 1);
}

/** Dart 单引号字符串转义：$ 必须转义，否则会被当成插值。 */
function dq(s) {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/\r?\n/g, '\\n') + "'";
}

const lines = [];
lines.push('// 由 tool/gen_archive_messages.mjs 从 archive/electron-desktop/shared/i18n.ts 生成 —— 请勿手工编辑。');
lines.push('//');
lines.push('// 重新生成（在 apps/desktop 下）：node tool/gen_archive_messages.mjs');
lines.push('//');
lines.push('// 键名 = 归档 TS 对象的点号路径（app.name / nav.images / settings.appearance.title …），');
lines.push('// 与 Electron 版 translate() 的 split(".") 语义一致，可与归档逐条对应。');
lines.push('//');
lines.push('// 分组：' + [...groups.entries()].map(([g, n]) => g + '(' + n + ')').join(' '));
lines.push('');
lines.push('/// Electron 版全部词条，' + Object.keys(flat[base]).length + ' 条 × ' + langs.length + ' 语言。');
lines.push('const Map<String, Map<String, String>> kArchiveMessages = <String, Map<String, String>>{');
for (const l of langs) {
  lines.push('  ' + dq(l) + ': <String, String>{');
  for (const k of Object.keys(flat[l]).sort()) {
    // 被补位的键单独标注，便于日后回填真正的英文文案
    if (filled.has(l + '.' + k)) lines.push('    // 归档缺该语言的文案，暂用中文占位');
    lines.push('    ' + dq(k) + ': ' + dq(flat[l][k]) + ',');
  }
  lines.push('  },');
}
lines.push('};');
lines.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join('\n'));
console.log('生成 ' + path.relative(APP, OUT) + '：' + Object.keys(flat[base]).length + ' 条 × ' + langs.length
  + ' 语言，' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
console.log('分组：' + [...groups.entries()].map(([g, n]) => g + '(' + n + ')').join(' '));
const settingsKeys = Object.keys(flat[base]).filter((k) => k.startsWith('settings.')).sort();
console.log('\nsettings 组共 ' + settingsKeys.length + ' 条，键名（值取 zh）：');
for (const k of settingsKeys) console.log('  ' + k.slice('settings.'.length) + ' = ' + flat.zh[k]);
