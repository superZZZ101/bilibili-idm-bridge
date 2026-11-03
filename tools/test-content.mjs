import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const fromRepo = relative => new URL('../' + relative, import.meta.url);
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.events = {}; this.className = ''; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
  attachShadow() { return this.shadowRoot = new Element('shadow'); }
  addEventListener(name, callback) { this.events[name] = callback; }
  set innerHTML(html) {
    this.children = [];
    for (const match of html.matchAll(/class="([^"]+)"/g)) {
      const node = new Element('div'); node.className = match[1]; this.append(node);
    }
  }
  querySelector(selector) {
    const className = selector.slice(1);
    for (const child of this.children) {
      if (child.className.split(' ').includes(className)) return child;
      const found = child.querySelector(selector); if (found) return found;
    }
    return null;
  }
}
const root = new Element('html');
const intervals = [];
const replies = [];
const routes = {};
const sandbox = vm.createContext({
  URL,
  location: { href: 'https://www.bilibili.com/list/watchlater' },
  document: { documentElement: root, createElement: tag => new Element(tag) },
  chrome: { runtime: { sendMessage: (msg, reply) => replies.push({ msg, reply }) } },
  setInterval: callback => intervals.push(callback),
  setTimeout: () => {},
  addEventListener: (name, callback) => { routes[name] = callback; },
});
sandbox.window = sandbox;
const manifest = JSON.parse(fs.readFileSync(fromRepo('extension/manifest.json'), 'utf8'));
for (const script of manifest.content_scripts[0].js) {
  vm.runInContext(fs.readFileSync(fromRepo('extension/' + script), 'utf8'), sandbox, { filename: script });
}
assert.equal(root.children.length, 0, '空稍后再看列表不显示视频下载按钮');
sandbox.location.href = 'https://www.bilibili.com/list/watchlater?bvid=BV1PsxT68E5J';
intervals[0]();
assert.equal(root.children.length, 1, '详情页注入按钮');
const shadow = root.children[0].shadowRoot;
const button = shadow.querySelector('.btn');
assert.equal(button.textContent, 'IDM');
const oldOpen = button.events.click();
const oldPanel = shadow.querySelector('.panel');
sandbox.location.href = 'https://www.bilibili.com/list/watchlater?bvid=BV1znxg6fEKA';
intervals[0]();
assert.equal(shadow.querySelector('.panel'), null, '列表内切换视频关闭旧面板');
const newOpen = button.events.click();
const newPanel = shadow.querySelector('.panel');
assert.notEqual(oldPanel, newPanel);
replies[0].reply({ ok: true, title: '旧视频', options: [] });
replies[1].reply({ ok: true });
await oldOpen;
assert.equal(newPanel.querySelector('.title').textContent, undefined, '旧请求不能覆盖新面板');
replies[2].reply({ ok: true, title: '新视频', options: [{ label: '480P', note: '', kind: 'file' }] });
replies[3].reply({ ok: true });
await newOpen;
assert.equal(newPanel.querySelector('.title').textContent, '新视频');
assert.equal(newPanel.children.filter(node => node.className === 'row').length, 1, '解析结果显示下载选项');
sandbox.location.href = 'https://www.bilibili.com/read/cv123';
routes.popstate();
assert.equal(root.children.length, 0, '离开视频页移除按钮');
sandbox.location.href = 'https://www.bilibili.com/watchlater/#/BV1PsxT68E5J';
routes.hashchange();
assert.equal(root.children.length, 1, '旧版 hash 详情页注入按钮');
const html = fs.readFileSync(fromRepo('extension/popup.html'), 'utf8');
assert.ok(html.indexOf('src="page-url.js"') < html.indexOf('src="popup.js"'), '弹窗先加载共享解析器');
console.log('PASS 扩展脚本顺序、详情页按钮、列表切换、异步响应隔离、下载选项及旧版 hash 注入（模拟 DOM）');
