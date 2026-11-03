/* page-url.js —— B站页面 URL 解析（content script、popup、bridge 共用） */
((root, factory) => {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BiliIdmPageUrl = api;
})(globalThis, () => {
  const VIDEO_PATH = /^\/video\/(BV[0-9A-Za-z]{10}|av(\d+))/i;
  const BANGUMI_PATH = /^\/bangumi\/play\/(ep|ss)(\d+)/i;
  const BVID = /^BV[0-9A-Za-z]{10}$/i;
  const BVID_IN_TEXT = /BV[0-9A-Za-z]{10}/i;

  function validBvid(value) {
    const match = BVID.exec(String(value || '').trim());
    return match ? match[0] : null;
  }

  function pageNumber(url) {
    const raw = url.searchParams.get('p');
    return /^\d+$/.test(raw || '') ? Number(raw) || 1 : 1;
  }

  function parse(pageUrl) {
    let url;
    try { url = new URL(pageUrl); } catch { return null; }
    if (!/(^|\.)bilibili\.com$/i.test(url.hostname)) return null;

    // 先判断番剧；在番剧语境下 oid 是 ep_id，不能当作普通视频 aid。
    let match = BANGUMI_PATH.exec(url.pathname);
    if (match) return { kind: 'bangumi', type: match[1].toLowerCase(), id: Number(match[2]) };

    match = VIDEO_PATH.exec(url.pathname);
    if (match) {
      return {
        kind: 'video',
        bvid: match[1].startsWith('BV') ? match[1] : null,
        avid: match[2] ? Number(match[2]) : null,
        p: pageNumber(url),
      };
    }

    // 稍后再看、收藏夹、媒体列表等页面把视频标识放在 query 或旧版 hash 中。
    const bvid = validBvid(url.searchParams.get('bvid')) || BVID_IN_TEXT.exec(url.hash)?.[0] || null;
    if (bvid) return { kind: 'video', bvid, avid: null, p: pageNumber(url) };

    const oid = url.searchParams.get('oid');
    if (/^\d+$/.test(oid || '')) return { kind: 'video', bvid: null, avid: Number(oid), p: pageNumber(url) };

    return null;
  }

  return Object.freeze({
    parse,
    isVideoUrl: (pageUrl) => !!parse(pageUrl),
  });
});
