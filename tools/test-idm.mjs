// 端到端：bridge → relay → IDMan.exe → 文件落盘
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE = 'http://127.0.0.1:12788';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const h = await (await fetch(BRIDGE + '/health')).json();
console.log('health:', JSON.stringify(h));
if (!h.ok) process.exit(1);
const DIR = h.downloadDir;
if (!DIR) { console.error('health 里没有 downloadDir'); process.exit(1); }

// 取一个小的封面图当试验对象（几十 KB，秒下完）
const pop = await (await fetch('https://api.bilibili.com/x/web-interface/popular?ps=1&pn=1', {
  headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' },
})).json();
const cover = pop.data.list[0].pic;
console.log('test target:', cover.slice(0, 80));

const name = `__idm_test_${Date.now()}.jpg`;
const add = await (await fetch(BRIDGE + '/api/add', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: cover, filename: name, referer: 'https://www.bilibili.com/', ua: UA }),
})).json();
console.log('add:', JSON.stringify(add));
if (!add.ok) process.exit(1);

const target = path.join(DIR, name);
const deadline = Date.now() + 90000;
let size = 0;
while (Date.now() < deadline) {
  try {
    const st = fs.statSync(target);
    size = st.size;
    // IDM 可能还在写，等大小稳定
    await new Promise((r) => setTimeout(r, 1500));
    if (fs.statSync(target).size === size) break;
  } catch { /* 还没出现 */ }
  await new Promise((r) => setTimeout(r, 1000));
}

if (size > 0) {
  console.log(`PASS IDM 落盘成功: ${name}  ${size} bytes  (期望 ${add.size || '?'})`);
  fs.unlinkSync(target);
  console.log('已清理测试文件');
} else {
  console.log('FAIL 90 秒内没看到文件，检查 IDM 是否弹了对话框 / 是否被暂停');
  process.exit(1);
}
