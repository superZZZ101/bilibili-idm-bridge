// 验证 B站普通视频、番剧和内嵌播放页 URL 的统一解析。
import assert from 'node:assert/strict';
import pageUrlApi from '../extension/page-url.js';
import { parsePage } from '../bridge/bili.mjs';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const browser = vm.createContext({ URL });
vm.runInContext(readFileSync(new URL('../extension/page-url.js', import.meta.url), 'utf8'), browser);

const cases = [
  {
    name: '普通 BV 视频 + 分P',
    url: 'https://www.bilibili.com/video/BV1PsxT68E5J/?p=2',
    target: { kind: 'video', bvid: 'BV1PsxT68E5J', avid: null, p: 2 },
  },
  {
    name: '普通 av 视频',
    url: 'https://www.bilibili.com/video/av170001234',
    target: { kind: 'video', bvid: null, avid: 170001234, p: 1 },
  },
  {
    name: '番剧 ep 优先于 oid',
    url: 'https://www.bilibili.com/bangumi/play/ep1234567?oid=170001234',
    target: { kind: 'bangumi', type: 'ep', id: 1234567 },
  },
  {
    name: '稍后再看 query bvid',
    url: 'https://www.bilibili.com/list/watchlater?bvid=BV1PsxT68E5J&oid=170001234&mode=0',
    target: { kind: 'video', bvid: 'BV1PsxT68E5J', avid: null, p: 1 },
  },
  {
    name: '收藏夹 query bvid + 分P',
    url: 'https://www.bilibili.com/list/ml1234567?bvid=BV1PsxT68E5J&p=3',
    target: { kind: 'video', bvid: 'BV1PsxT68E5J', avid: null, p: 3 },
  },
  {
    name: '番剧 season 优先于 query 视频标识',
    url: 'https://www.bilibili.com/bangumi/play/ss123?bvid=BV1PsxT68E5J&oid=170001234',
    target: { kind: 'bangumi', type: 'ss', id: 123 },
  },
  {
    name: '媒体列表 query oid',
    url: 'https://www.bilibili.com/medialist/play/ml1234567?oid=170001234',
    target: { kind: 'video', bvid: null, avid: 170001234, p: 1 },
  },
  {
    name: '旧版稍后再看 hash bvid',
    url: 'https://www.bilibili.com/watchlater/#/BV1PsxT68E5J',
    target: { kind: 'video', bvid: 'BV1PsxT68E5J', avid: null, p: 1 },
  },
];

for (const item of cases) {
  assert.deepEqual(pageUrlApi.parse(item.url), item.target, item.name);
  assert.equal(pageUrlApi.isVideoUrl(item.url), true, item.name);
  assert.deepEqual(parsePage(item.url), item.target, `桥接：${item.name}`);
  const browserTarget = JSON.parse(JSON.stringify(browser.BiliIdmPageUrl.parse(item.url)));
  assert.deepEqual(browserTarget, item.target, `浏览器：${item.name}`);
}

const rejected = [
  'https://www.bilibili.com/read/cv123',
  'https://example.com/video/BV1PsxT68E5J',
  'https://bilibili.com.example.com/list/watchlater?bvid=BV1PsxT68E5J',
  'https://www.bilibili.com/list/watchlater',
  'https://www.bilibili.com/list/watchlater?bvid=broken',
  'https://www.bilibili.com/medialist/play/ml123?oid=123oops',
  'not a URL',
];
for (const url of rejected) {
  assert.equal(pageUrlApi.parse(url), null, `应拒绝非视频页：${url}`);
  assert.equal(pageUrlApi.isVideoUrl(url), false, `应拒绝非视频页：${url}`);
}

console.log(`PASS ${cases.length} 个视频 URL 场景（浏览器 / 桥接一致）+ ${rejected.length} 个拒绝场景`);
