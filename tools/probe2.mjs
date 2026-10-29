const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const REF = 'https://www.bilibili.com/';

async function get(url, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: REF, ...headers } });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 150) }; }
  return { status: r.status, code: j.code, msg: j.message, j };
}

console.log('1) spi 无 cookie');
const spi = await get('https://api.bilibili.com/x/frontend/finger/spi');
console.log('   ', spi.status, 'code=', spi.code, JSON.stringify(spi.j.data || spi.j).slice(0, 120));

const b3 = spi.j?.data?.b_3;
console.log('2) view + buvid3 cookie');
const v1 = await get('https://api.bilibili.com/x/web-interface/view?bvid=BV1znxg6fEKA', { Cookie: `buvid3=${b3}` });
console.log('   ', v1.status, 'code=', v1.code, v1.msg, v1.j.data ? 'title=' + v1.j.data.title : '');

console.log('3) view + 完整浏览器头');
const v2 = await get('https://api.bilibili.com/x/web-interface/view?bvid=BV1znxg6fEKA', {
  Cookie: `buvid3=${b3}`,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Origin: 'https://www.bilibili.com',
});
console.log('   ', v2.status, 'code=', v2.code, v2.msg, v2.j.data ? 'title=' + v2.j.data.title : '');

console.log('4) view by aid');
const v3 = await get('https://api.bilibili.com/x/web-interface/view?aid=117512486256644', { Cookie: `buvid3=${b3}` });
console.log('   ', v3.status, 'code=', v3.code, v3.msg);

console.log('5) playurl（之前成功过的那个）');
const p = await get('https://api.bilibili.com/x/player/playurl?avid=117512486256644&cid=43118757434&qn=64&fnval=1&fnver=0', { Cookie: `buvid3=${b3}` });
console.log('   ', p.status, 'code=', p.code, p.msg ? p.msg : '', p.j.data ? 'has durl' : '');
