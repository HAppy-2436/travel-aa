'use strict';
/* 体检 + 修：找出带 UTF-8 BOM 的文件（PowerShell 的 Set-Content -Encoding UTF8 会写 BOM）。
   小程序/服务端源码不该有 BOM（部分工具链会把它当正文，wxml 首字符多一个不可见字符）。
   用法：node tests/tools/strip-bom.js [--fix] */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ROOTS = ['apps/miniprogram', 'apps/cloudfunctions', 'server', 'demo', 'tests', 'tools', 'docs'];
const EXTS = ['.js', '.json', '.wxml', '.wxss', '.html', '.css', '.md'];
const SKIP = /node_modules|[\\/]data[\\/]|[\\/]\.git[\\/]/;

const fix = process.argv.includes('--fix');
const found = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (SKIP.test(p)) continue;
    const st = fs.statSync(p);
    if (st.isDirectory()) { walk(p); continue; }
    if (!EXTS.includes(path.extname(p).toLowerCase())) continue;
    const buf = fs.readFileSync(p);
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      found.push(path.relative(ROOT, p));
      if (fix) fs.writeFileSync(p, buf.slice(3));
    }
  }
}
ROOTS.forEach((r) => walk(path.join(ROOT, r)));

if (!found.length) {
  console.log('✅ 没有文件带 UTF-8 BOM');
} else {
  console.log((fix ? '🧹 已去掉 BOM：' : '⚠️ 以下文件带 UTF-8 BOM（加 --fix 去掉）：') + found.length + ' 个');
  found.forEach((f) => console.log('   ' + f));
}
process.exit(0);
