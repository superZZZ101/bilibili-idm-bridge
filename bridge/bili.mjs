/**
 * B站接口解析层：URL → 可用清晰度列表（DASH 音视频 / 单文件 MP4）
 * 放在 Node 侧执行，避免浏览器 fetch 的 forbidden header / CORS 限制，
 * Referer / Cookie / UA 想怎么带就怎么带。
 */

const UA_DEFAULT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const REF = 'https://www.bilibili.com/';

const QN_LABEL = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
  6: '240P',
};

const CODEC_NAME = { 7: 'avc', 12: 'hevc', 13: 'av1' };

export function qnLabel(id) {
  return QN_LABEL[id] || `QN${id}`;
}

/** 从页面 URL 解析目标 */
export function parsePage(pageUrl) {
  let u;
  try { u = new URL(pageUrl); } catch { return null; }
  if (!/(^|\.)bilibili\.com$/.test(u.hostname)) return null;

  let m = /\/video\/(BV[0-9A-Za-z]{10}|av(\d+))/i.exec(u.pathname);
  if (m) {
    const p = Number(u.searchParams.get('p') || 1) || 1;
    return { kind: 'video', bvid: m[1].startsWith('BV') ? m[1] : null, avid: m[2] ? Number(m[2]) : null, p };
  }
  m = /\/bangumi\/play\/(ep|ss)(\d+)/i.exec(u.pathname);
  if (m) return { kind: 'bangumi', type: m[1].toLowerCase(), id: Number(m[2]) };
  return null;
}

async function apiJson(url, { cookie, ua } = {}) {
  const headers = { 'User-Agent': ua || UA_DEFAULT, Referer: REF, Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`接口返回非 JSON (HTTP ${r.status}): ${text.slice(0, 120)}`); }
  return json;
}

/**
 * B站风控要求请求带 buvid3（游客指纹）。扩展会把用户浏览器里的 cookie 整包发来，
 * 通常已有；匿名/缺失时用官方 spi 接口现取一个，避免 -412 request was banned。
 */
async function ensureCookie(opts) {
  const c = opts.cookie || '';
  if (/buvid3=/.test(c)) return c;
  try {
    const j = await apiJson('https://api.bilibili.com/x/frontend/finger/spi', opts);
    const b3 = j.data?.b_3;
    const b4 = j.data?.b_4;
    if (b3) return [c, `buvid3=${b3}`, b4 ? `buvid4=${b4}` : ''].filter(Boolean).join('; ');
  } catch { /* 取不到就裸奔 */ }
  return c;
}

function pick(arr, score) {
  let best = null;
  for (const x of arr || []) {
    if (!best || score(x) > score(best)) best = x;
  }
  return best;
}

/** 视频 DASH 流：按清晰度分组，每组优先 avc（兼容性最好） */
function groupVideo(dash) {
  const byId = new Map();
  for (const v of dash.video || []) {
    if (!byId.has(v.id)) byId.set(v.id, []);
    byId.get(v.id).push(v);
  }
  const out = [];
  for (const [id, list] of byId) {
    const pref = list.find((x) => x.codecid === 7) || list.find((x) => x.codecid === 12) || list[0];
    out.push({
      qn: id,
      label: qnLabel(id),
      codec: CODEC_NAME[pref.codecid] || String(pref.codecid),
      width: pref.width,
      height: pref.height,
      frameRate: pref.frameRate,
      url: pref.baseUrl,
      backups: pref.backupUrl || [],
      bandwidth: pref.bandwidth,
    });
  }
  return out.sort((a, b) => b.height - a.height || b.qn - a.qn);
}

function groupAudio(dash) {
  const best = pick(dash.audio, (x) => x.bandwidth || 0);
  if (!best) return null;
  return { url: best.baseUrl, backups: best.backupUrl || [], bandwidth: best.bandwidth, codecs: best.codecs };
}

function dashError(j) {
  const code = j.code ?? j.result?.code;
  const msg = j.message || j.result?.message || '';
  if (code === 0) return null;
  if (code === -404) return '视频不存在或已删除';
  if (code === -403) return '没有访问权限（可能需要登录 / 大会员）';
  if (code === -10403) return '区域限制或未登录，无法获取该画质';
  if (code === -400) return '请求参数被拒（可能需要登录）';
  return `B站接口返回 ${code}: ${msg}`;
}

/**
 * 解析页面 → 可选清晰度
 * @param {string} pageUrl
 * @param {{cookie?:string, ua?:string}} opts
 */
export async function resolveOptions(pageUrl, opts = {}) {
  const target = parsePage(pageUrl);
  if (!target) return { ok: false, err: '不是 B站视频 / 番剧页面' };
  opts = { ...opts, cookie: await ensureCookie(opts) };

  let aid, cid, title, subTitle = '', cover = '', pageno = 1, epId = null;
  let isPgc = false;

  if (target.kind === 'video') {
    const q = target.bvid ? `bvid=${target.bvid}` : `aid=${target.avid}`;
    const j = await apiJson(`https://api.bilibili.com/x/web-interface/view?${q}`, opts);
    if (j.code !== 0) return { ok: false, err: j.code === -404 ? '视频不存在' : `获取视频信息失败: ${j.message} (code ${j.code})` };
    const d = j.data;
    aid = d.aid;
    title = d.title;
    const pages = d.pages || [];
    pageno = Math.min(Math.max(target.p || 1, 1), pages.length || 1);
    const page = pages[pageno - 1];
    cid = page?.cid || d.cid;
    if (pages.length > 1 && page?.part) subTitle = page.part;
    cover = d.pic || '';
  } else {
    isPgc = true;
    const q = target.type === 'ep' ? `ep_id=${target.id}` : `season_id=${target.id}`;
    const j = await apiJson(`https://api.bilibili.com/pgc/view/web/season?${q}`, opts);
    if (j.code !== 0) return { ok: false, err: `获取番剧信息失败: ${j.message} (code ${j.code})` };
    const season = j.result;
    let ep = season.episodes?.[0];
    if (target.type === 'ep') ep = (season.episodes || []).find((e) => e.id === target.id || e.ep_id === target.id) || ep;
    if (!ep) return { ok: false, err: '找不到对应剧集' };
    aid = ep.aid;
    cid = ep.cid;
    epId = ep.id || ep.ep_id;
    title = season.season_title || season.title;
    subTitle = ep.title || '';
    cover = ep.cover || season.cover || '';
    if (season.episodes?.length > 1) subTitle = `${subTitle} ${ep.long_title || ''}`.trim();
  }

  const result = {
    ok: true,
    title: (subTitle ? `${title} - ${subTitle}` : title).trim(),
    cover,
    pageno,
    duration: 0,
    options: [],
    warnings: [],
  };

  // ---- DASH（分音视频，最高画质）----
  const dashUrl = isPgc
    ? `https://api.bilibili.com/pgc/player/web/playurl?avid=${aid}&cid=${cid}&ep_id=${epId}&qn=127&fnver=0&fourk=1&fnval=4048`
    : `https://api.bilibili.com/x/player/playurl?avid=${aid}&cid=${cid}&qn=127&fnver=0&fourk=1&fnval=4048`;

  let dashData = null;
  try {
    const j = await apiJson(dashUrl, opts);
    const err = dashError(j);
    if (err) result.warnings.push('DASH: ' + err);
    else dashData = j.data || j.result;
  } catch (e) {
    result.warnings.push('DASH: ' + e.message);
  }

  if (dashData?.dash) {
    const videos = groupVideo(dashData.dash);
    const audio = groupAudio(dashData.dash);
    result.duration = dashData.dash.duration || dashData.timelength / 1000 || 0;
    if (videos.length && audio) {
      for (const v of videos) {
        result.options.push({
          kind: 'dash',
          qn: v.qn,
          label: `${v.label} · ${v.height}P${v.codec !== 'avc' ? ' ' + v.codec : ''}`,
          note: '音视频分开下载，自动合并',
          video: { url: v.url, backups: v.backups },
          audio: { url: audio.url, backups: audio.backups },
          height: v.height,
        });
      }
    } else if (videos.length) {
      result.warnings.push('没有可用音轨，只能拿到画面');
    }
  }

  // ---- durl（单文件，免合并）----
  const durlUrl = isPgc
    ? `https://api.bilibili.com/pgc/player/web/playurl?avid=${aid}&cid=${cid}&ep_id=${epId}&qn=127&fnver=0&fourk=1&fnval=1`
    : `https://api.bilibili.com/x/player/playurl?avid=${aid}&cid=${cid}&qn=127&fnver=0&fourk=1&fnval=1`;

  try {
    const j = await apiJson(durlUrl, opts);
    const data = j.data || j.result;
    if (!dashError(j) && data?.durl?.length) {
      const d = data.durl;
      const qn = data.quality || 0;
      if (d.length === 1) {
        result.options.push({
          kind: 'file',
          qn,
          label: `${qnLabel(qn)} · 单文件 MP4`,
          note: '无需合并，但画质上限较低',
          url: d[0].url,
          backups: d[0].backup_url || [],
          size: d[0].size || 0,
        });
      } else {
        result.warnings.push(`单文件被切成 ${d.length} 段，已跳过`);
      }
    }
  } catch (e) {
    result.warnings.push('durl: ' + e.message);
  }

  if (!result.options.length) {
    result.ok = false;
    result.err = result.warnings.join('；') || '没有拿到任何可下载地址（可能需要登录）';
  }
  return result;
}
