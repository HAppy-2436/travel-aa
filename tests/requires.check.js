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
// 跳过编辑/工具留下的临时备份文件（避免把 .tmpnew / .bak 当真实源码扫描）
const SKIP_FILE_RE = /(\.tmpnew|\.tmp|\.bak|\.orig|\.rej|~)$/;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    if (SKIP_FILE_RE.test(e.name)) continue;
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

/**
 * 剥掉注释与字符串字面量，避免把「注释/文档里提到的路径」误判成真实引用。
 * （例如 server.test.js 的注释里就写了那条历史 bug 的错误路径。）
 */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')            // 块注释（含 JSDoc）
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1 ')       // 行注释（m 让 ^ 匹配每行行首；避开 http://）
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")        // 单引号字符串
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')        // 双引号字符串
    .replace(/`(?:\\.|[^`\\])*`/g, '``');         // 模板字符串
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

  const raw = fs.readFileSync(f, 'utf8');
  // HTML 标签属性本身就是字符串，用原文扫描；JS 用副本判断"该处是否位于注释/字符串里"
  const stripped = isJs ? stripCommentsAndStrings(raw) : raw;
  const rel = path.relative(ROOT, f);

  const probe = (spec, kind) => {
    if (!spec.startsWith('.')) return;                 // 裸模块名交给 node 解析
    if (/^https?:|^data:/.test(spec)) return;          // 外链不检查
    const clean = spec.split('?')[0].split('#')[0];
    checks++;
    const base = path.resolve(path.dirname(f), clean);
    if (!exists(base)) {
      broken++;
      problems.push(`${rel}  ${kind}  ${spec}`);
    }
  };

  /**
   * 在原文里找 require(...)，但只保留"真实代码"里的那些。
   * 做法：取匹配处前后一小段窗口 → 剥掉注释与字符串 → 若 require 关键字消失了，
   * 说明它本身就在注释/字符串里（例如文档里提到的那条历史 bug 路径），忽略。
   * 用窗口而非全文比对，避免剥壳改变偏移量导致位置对不上。
   */
  const scanRequire = () => {
    RE_REQUIRE.lastIndex = 0;
    let m;
    while ((m = RE_REQUIRE.exec(raw))) {
      const lo = Math.max(0, m.index - 120);
      const hi = Math.min(raw.length, m.index + m[0].length + 120);
      const windowStripped = stripCommentsAndStrings(raw.slice(lo, hi));
      if (!/require\s*\(/.test(windowStripped)) continue;   // 在注释/字符串里 → 忽略
      probe(m[1], 'require');
    }
  };
  scanRequire();

  if (isHtml) {
    RE_SCRIPT_SRC.lastIndex = 0;
    let m2;
    while ((m2 = RE_SCRIPT_SRC.exec(raw))) probe(m2[1], 'script-src');
    RE_HREF.lastIndex = 0;
    while ((m2 = RE_HREF.exec(raw))) probe(m2[1], 'link-href');
  }
}

console.log('  扫描文件 ' + files.length + ' 个，相对引用 ' + checks + ' 处');
problems.forEach((p) => console.log('  ❌ ' + p));
const ok = broken === 0;
console.log('  ' + (ok ? '✅' : '❌') + ' 相对路径引用全部可解析');
console.log('\n========================================');
console.log(ok ? '相对路径检查全部通过' : ('相对路径检查失败 ' + broken + ' 处'));
console.log('========================================');
process.exit(ok ? 0 : 1);
