/**
 * requires.check.js —— 静态检查：所有相对路径 require/引用是否真实存在
 *
 * 为什么需要：目录重构（miniprogram/ → apps/miniprogram/）后，server/app.js 曾出现
 * `../apps/apps/miniprogram/utils/ai` 这样的路径拼接错误，导致后端**完全无法启动**，
 * 而三套测试都没覆盖到（它们只测内核与 Demo）。本检查把这类"改目录改漏"钉死。
 *
 * 覆盖范围：
 *   1. CommonJS  `require('相对路径')`
 *   2. HTML 中   `<script src="相对路径">`
 *   3. HTML 中   `new Worker('相对路径')` 之类（可选）
 *
 * 用法：node tests/requires.check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'edgeprof', 'chrome-prof', '.cache']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function exists(base) {
  const cands = [base, base + '.js', base + '.json', base + '.mjs', base + '.cjs'];
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return true; } catch (e) { /* ignore */ }
  }
  try { if (fs.statSync(base).isDirectory()) return true; } catch (e) { /* ignore */ }
  return false;
}

const files = walk(ROOT, []);
let checks = 0;
let broken = 0;
const problems = [];

const RE_REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_SCRIPT_SRC = /<script[^>]+src\s*=\s*['"]([^'"]+)['"]/gi;
const RE_HREF = /<link[^>]+href\s*=\s*['"]([^'"]+)['"]/gi;

for (const f of files) {
  const isJs = f.endsWith('.js');
  const isHtml = f.endsWith('.html');
  if (!isJs && !isHtml) continue;

  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f);

  const probe = (spec, kind) => {
    if (!spec.startsWith('.')) return;                 // 裸模块名交给 node 解析
    if (/^https?:|^data:/.test(spec)) return;
    const clean = spec.split('?')[0].split('#')[0];
    checks++;
    const base = path.resolve(path.dirname(f), clean);
    if (!exists(base)) {
      broken++;
      problems.push(`${rel}  ${kind}  ${spec}`);
    }
  };

  let m;
  RE_REQUIRE.lastIndex = 0;
  while ((m = RE_REQUIRE.exec(src))) probe(m[1], 'require');
  RE_SCRIPT_SRC.lastIndex = 0;
  while ((m = RE_SCRIPT_SRC.exec(src))) probe(m[1], 'script-src');
  RE_HREF.lastIndex = 0;
  while ((m = RE_HREF.exec(src))) probe(m[1], 'link-href');
}

console.log('  扫描文件 ' + files.length + ' 个，相对引用 ' + checks + ' 处');
problems.forEach((p) => console.log('  ❌ ' + p));
const ok = broken === 0;
console.log('  ' + (ok ? '✅' : '❌') + ' 相对路径引用全部可解析');
console.log('\n========================================');
console.log(ok ? '相对路径检查全部通过' : ('相对路径检查失败 ' + broken + ' 处'));
console.log('========================================');
process.exit(ok ? 0 : 1);
