/**
 * 全链路 e2e：页面 URL → 解析 → 音视频两路入队 IDM（走中继）→ 自动合并成 mp4
 * 用法：node tools/e2e-merge.mjs [页面URL] [画质关键字，默认 480P]
 */
const BRIDGE = 'http://127.0.0.1:12788';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const pageUrl = process.argv[2] || 'https://www.bilibili.com/video/BV1PsxT68E5J/';
const wantLabel = process.argv[3] || '480P';

const post = async (p, body) => {
  const r = await fetch(BRIDGE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
};

const health = await (await fetch(BRIDGE + '/health')).json();
console.log('health:', JSON.stringify(health));
if (!health.ffmpeg) { console.error('ffmpeg 未就绪'); process.exit(1); }

const res = await post('/api/resolve', { pageUrl, ua: UA });
if (!res.ok) { console.error('解析失败:', res.err); process.exit(1); }
console.log('标题:', res.title);
const dash = res.options.filter((o) => o.kind === 'dash');
console.log('DASH 选项:', dash.map((o) => o.label).join(' | '));
const opt = dash.find((o) => o.label.includes(wantLabel)) || dash[dash.length - 1];
if (!opt) { console.error('没有 DASH 选项'); process.exit(1); }
console.log('选中:', opt.label, '| video=', opt.video.url.slice(0, 60), '| audio=', opt.audio.url.slice(0, 60));

const add = await post('/api/add-batch', {
  filename: `e2e ${opt.label.replace(/\s*·.*$/, '')}.mp4`,
  merge: true,
  referer: 'https://www.bilibili.com/',
  ua: UA,
  items: [
    { url: opt.video.url, suffix: 'video.m4s', mime: 'video/mp4' },
    { url: opt.audio.url, suffix: 'audio.m4s', mime: 'audio/mp4' },
  ],
});
console.log('add-batch:', JSON.stringify(add));
if (!add.ok) { console.error('入队失败'); process.exit(1); }

const fs = await import('node:fs');
const deadline = Date.now() + 15 * 60 * 1000;
let lastLog = '';
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const jobs = await (await fetch(BRIDGE + '/api/jobs')).json();
  const g = jobs.jobs.find((j) => j.id === add.groupId);
  if (!g) continue;
  const parts = (g.items || []).map((i) => {
    let sz = 0;
    try { sz = fs.statSync(i.path).size; } catch { /* 未出现 */ }
    return `${i.path.split(/[\\/]/).pop()}=${sz}/${i.expect || '?'}`;
  }).join(' ');
  const line = `[${g.status}] ${parts}`;
  if (line !== lastLog) { console.log(line); lastLog = line; }
  if (g.status === 'done') {
    const st = fs.statSync(g.outPath || add.out);
    console.log(`\n✅ 合并完成: ${add.out}  ${st.size} bytes`);
    process.exit(0);
  }
  if (g.status === 'merge-failed') {
    console.error('\n❌ 合并失败:', g.error);
    process.exit(2);
  }
}
console.error('\n❌ 超时');
process.exit(3);
