// 端到端验证 relay：Range 透传、HEAD、Content-Length、防盗链注入
const BRIDGE = 'http://127.0.0.1:12788';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const REF = 'https://www.bilibili.com/';
const ok = [];
const bad = [];
const chk = (name, cond, extra = '') => (cond ? ok : bad).push(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`);

const pop = await (await fetch('https://api.bilibili.com/x/web-interface/popular?ps=1&pn=1', { headers: { 'User-Agent': UA, Referer: REF } })).json();
const v = pop.data.list[0];
const purl = await (await fetch(`https://api.bilibili.com/x/player/playurl?avid=${v.aid}&cid=${v.cid}&qn=64&fnval=1&fnver=0`, { headers: { 'User-Agent': UA, Referer: REF } })).json();
const durl = purl.data.durl[0].url;
console.log('target:', v.bvid, durl.slice(0, 90) + '...');

// 裸下载必须 403（证明防盗链存在）
const bare = await fetch(durl, { headers: { 'User-Agent': UA, Range: 'bytes=0-99' } });
chk('裸请求被防盗链拦截', bare.status === 403, `status=${bare.status}`);

// 建 dryRun 任务，不拉 IDM
const add = await (await fetch(`${BRIDGE}/api/add`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: durl, filename: '测试 视频.mp4', referer: REF, ua: UA, dryRun: true }),
})).json();
chk('建任务', add.ok === true, add.localUrl || add.err);

// A. Range 前 1KB
let r = await fetch(add.localUrl, { headers: { Range: 'bytes=0-1023' } });
const a = new Uint8Array(await r.arrayBuffer());
chk('Range 0-1023 → 206', r.status === 206, `status=${r.status}`);
chk('Range 长度 = 1024', a.length === 1024, `len=${a.length} type=${r.headers.get('content-type')} cr=${r.headers.get('content-range')}`);
chk('Content-Disposition 带文件名', (r.headers.get('content-disposition') || '').includes('filename'), r.headers.get('content-disposition') || '');

// B. 中段 Range，内容必须不同（证明不是从头返回）
r = await fetch(add.localUrl, { headers: { Range: 'bytes=1000000-1000999' } });
const b = new Uint8Array(await r.arrayBuffer());
chk('中段 Range → 206', r.status === 206, `status=${r.status} cr=${r.headers.get('content-range')}`);
chk('中段内容与开头不同', b.length === 1000 && Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0, `len=${b.length}`);

// C. HEAD
r = await fetch(add.localUrl, { method: 'HEAD' });
chk('HEAD 200 + 总长度', r.status === 200 && Number(r.headers.get('content-length')) > 1e7, `len=${r.headers.get('content-length')}`);

// D. 无 Range 全量流（读 4KB 后断开，验证不缓冲整包）
const ac = new AbortController();
r = await fetch(add.localUrl, { signal: ac.signal });
chk('无 Range → 200', r.status === 200, `status=${r.status} len=${r.headers.get('content-length')}`);
const reader = r.body.getReader();
let got = 0;
while (got < 4096) { const { value, done } = await reader.read(); if (done) break; got += value.length; }
ac.abort();
chk('流式读取可用', got >= 4096, `read=${got}B`);

console.log('\n' + ok.join('\n'));
if (bad.length) console.log('\n' + bad.join('\n'));
console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
