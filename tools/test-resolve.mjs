// 验证 /api/resolve：普通视频 + 番剧
const BRIDGE = 'http://127.0.0.1:12788';
const post = async (p, body) => (await fetch(BRIDGE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

const show = (tag, r) => {
  console.log(`\n=== ${tag} ===`);
  if (!r.ok) return console.log('FAIL', r.err, r.warnings || '');
  console.log('title:', r.title, '| duration:', Math.round(r.duration) + 's');
  for (const o of r.options) {
    const u = (o.video?.url || o.url || '');
    console.log(`  [${o.kind.padEnd(4)}] ${o.label.padEnd(28)} host=${new URL(u).host}`);
  }
  if (r.warnings?.length) console.log('  warnings:', r.warnings.join(' | '));
};

show('普通视频 (匿名)', await post('/api/resolve', { pageUrl: 'https://www.bilibili.com/video/BV1znxg6fEKA/' }));
show('分P视频 p=2', await post('/api/resolve', { pageUrl: 'https://www.bilibili.com/video/BV1znxg6fEKA/?p=2' }));
show('番剧 ep', await post('/api/resolve', { pageUrl: 'https://www.bilibili.com/bangumi/play/ep1234567' }));
show('非视频页', await post('/api/resolve', { pageUrl: 'https://www.bilibili.com/read/cv123' }));