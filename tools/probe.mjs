// Empirical probe: does bilibili CDN require Referer? What does playurl return anonymously?
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const REF = 'https://www.bilibili.com/';

const j = async (url, hdrs = {}) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: REF, ...hdrs } });
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
};

const head = async (url, hdrs) => {
  const r = await fetch(url, { method: 'GET', headers: { 'User-Agent': UA, Range: 'bytes=0-99', ...hdrs } });
  return `${r.status} ${r.headers.get('content-type') || '-'} len=${r.headers.get('content-length') || '-'} cr=${r.headers.get('content-range') || '-'}`;
};

const pop = await j('https://api.bilibili.com/x/web-interface/popular?ps=3&pn=1');
if (pop.status !== 200 || pop.body.code !== 0) {
  console.log('popular FAILED', pop.status, JSON.stringify(pop.body).slice(0, 300));
  process.exit(1);
}
const v = pop.body.data.list[0];
console.log('VIDEO:', v.bvid, 'aid=' + v.aid, 'cid=' + v.cid, '|', v.title);

const base = `avid=${v.aid}&cid=${v.cid}&fnver=0&fourk=1`;

// --- durl (single progressive file) ---
const d = await j(`https://api.bilibili.com/x/player/playurl?${base}&qn=64&fnval=1`);
console.log('PLAYURL(fnval=1) code=', d.body.code, 'msg=', d.body.message);
if (d.body.code === 0) {
  const dd = d.body.data;
  console.log('  quality=', dd.quality, 'fmt=', dd.format, 'accept=', JSON.stringify(dd.accept_description));
  const u = dd.durl[0].url;
  console.log('  durl host=', new URL(u).host);
  console.log('  NO-REFERER :', await head(u, {}));
  console.log('  WITH-REFERER:', await head(u, { Referer: REF }));
}

// --- dash (separate audio/video) ---
const dash = await j(`https://api.bilibili.com/x/player/playurl?${base}&qn=80&fnval=4048`);
console.log('PLAYURL(fnval=4048) code=', dash.body.code, 'msg=', dash.body.message);
if (dash.body.code === 0 && dash.body.data.dash) {
  const { video, audio } = dash.body.data.dash;
  console.log('  video streams=', video.length, 'audio streams=', audio.length);
  console.log('  tops:', video.slice(0, 3).map((x) => `${x.id}/${x.width}x${x.height}/${(x.baseUrl.match(/\.m4s/) ? 'm4s' : '?')}`).join(' '));
  const vu = video[0].baseUrl;
  console.log('  vurl host=', new URL(vu).host);
  console.log('  V NO-REFERER :', await head(vu, {}));
  console.log('  V WITH-REFERER:', await head(vu, { Referer: REF }));
  const au = audio[0].baseUrl;
  console.log('  A NO-REFERER :', await head(au, {}));
  console.log('  A WITH-REFERER:', await head(au, { Referer: REF }));
}
