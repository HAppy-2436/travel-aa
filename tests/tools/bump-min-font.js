'use strict';
/* 把 <9.5px（19rpx）的小字统一抬到 20rpx=10px —— 排版守卫下限。
   只改 font-size 声明，不动其它属性。 */
const fs = require('fs');
const files = ['app.wxss',
  'pages/index/index.wxss', 'pages/room/room.wxss', 'pages/add-bill/add-bill.wxss',
  'pages/settle/settle.wxss', 'pages/history/history.wxss'];
let total = 0;
files.forEach((f) => {
  if (!fs.existsSync(f)) return;
  const before = fs.readFileSync(f, 'utf8');
  /* font-size: 18rpx → 20rpx（仅 18rpx 这一档，最小可读下限） */
  const after = before.replace(/font-size:\s*18rpx/g, () => { total++; return 'font-size: 20rpx'; });
  if (after !== before) fs.writeFileSync(f, after);
});
console.log('已抬高 ' + total + ' 处 18rpx → 20rpx（9px → 10px，过排版下限）');
