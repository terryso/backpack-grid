'use strict';
// ego_space.cjs 回归：按名附加 / 缺失自动重建 / 重建失败如实抛错 / 页签复用绝不盲建 /
// 停车（同域零导航、离域停回资产页、库存失败 fail-loud）。
const assert = require('node:assert/strict');
const { resolveBotSpace, resolveBotPage, PARK_URL, SPACE_NAME } = require('../scripts/ego_space.cjs');
let count = 0; const check = (name, fn) => { fn(); count++; console.log('PASS', name); };

function makeEgo(existing) {
  const created = [];
  return {
    created,
    ego: { async listTaskSpaces() { return { taskSpaces: existing.map(s => ({ ...s })) }; },
           async createTaskSpace(name) { const id = Math.max(-1, ...existing.map(s => s.id)) + 1; const s = { id, name, by: 'agent' }; existing.push(s); created.push(s); return { id }; } },
    taskSpace: async (id) => { const hit = existing.find(s => s.id === id); if (!hit) throw Error('task space not found: ' + id); return { id, attached: true }; },
  };
}

// 页签 mock：url 返回当前地址，goto 记录导航，waitForTimeout 立即返回。
const onDomain = 'https://backpack.exchange/portfolio/balances/assets';
const mkPage = (label, url, navigations) => ({
  label,
  url: async () => url,
  goto: async (u) => { navigations.push(u); },
  waitForTimeout: async () => {},
});

check('空间存在：直接附加', async () => {
  const h = makeEgo([{ id: 7, name: SPACE_NAME }]);
  const t = await resolveBotSpace(h.ego, h.taskSpace);
  assert.equal(t.id, 7);
});
check('空间消失：按名自动重建并附加', async () => {
  const h = makeEgo([]);
  const t = await resolveBotSpace(h.ego, h.taskSpace);
  assert.equal(h.created.length, 1);
  assert.equal(t.id, 0);
});
check('附加瞬时失败：重建兜底后可附加', async () => {
  const h = makeEgo([{ id: 5, name: SPACE_NAME }]);
  let calls = 0;
  const t = await resolveBotSpace(h.ego, (id) => { if (++calls === 1) throw Error('transient'); return { id, calls }; });
  assert.equal(t.id, 5);
});
check('重建失败：如实抛错不吞', async () => {
  const broken = { ego: { async listTaskSpaces() { return { taskSpaces: [] }; }, async createTaskSpace() { /* 建了但列表不出现 */ } },
                   taskSpace: async () => { throw Error('x'); } };
  await assert.rejects(() => resolveBotSpace(broken.ego, broken.taskSpace), /recreate failed/);
});
check('resolveBotPage：全新空间自动创建页签（p1 从 about:blank 停车到资产页）', async () => {
  const h = makeEgo([]);
  const pages = [], navigations = [];
  const taskSpace = async (id) => ({
    id,
    pages: async () => pages.map(l => ({ label: l })),
    newPage: async () => { const label = 'p' + (pages.length + 1); pages.push(label); return mkPage(label, 'about:blank', navigations); },
    page: (label) => { if (!pages.includes(label)) throw Error('page label not found: ' + label); return mkPage(label, onDomain, navigations); },
  });
  const { page, navigated } = await resolveBotPage(h.ego, taskSpace, 'p1');
  assert.equal(page.label, 'p1');
  assert.equal(navigated, true);
  assert.deepEqual(navigations, [PARK_URL]); // 新页签离域 → 停车恰好一次
});
check('resolveBotPage：已有目标页签且在同域，直接复用零新建零导航', async () => {
  let created = 0; const navigations = [];
  const h = makeEgo([{ id: 3, name: SPACE_NAME }]);
  const taskSpace = async (id) => ({
    id,
    pages: async () => [{ label: 'p1' }, { label: 'p2' }],
    newPage: async () => { created++; return mkPage('p3', 'about:blank', navigations); },
    page: (label) => mkPage(label, onDomain, navigations),
  });
  const { page, navigated } = await resolveBotPage(h.ego, taskSpace, 'p1');
  assert.equal(page.label, 'p1');
  assert.equal(created, 0);
  assert.equal(navigated, false);
  assert.deepEqual(navigations, []); // 稳态：不重载页面（会杀死 in-flight fetch）
});
check('resolveBotPage：有页签但无目标标签时复用第一个，绝不新建第二个', async () => {
  let created = 0; const navigations = [];
  const h = makeEgo([{ id: 4, name: SPACE_NAME }]);
  const taskSpace = async (id) => ({
    id,
    pages: async () => [{ label: 'work' }],
    newPage: async () => { created++; return mkPage('p1', 'about:blank', navigations); },
    page: (label) => mkPage(label, onDomain, navigations),
  });
  const { page } = await resolveBotPage(h.ego, taskSpace, 'p1');
  assert.equal(page.label, 'work');
  assert.equal(created, 0);
  assert.deepEqual(navigations, []);
});
check('resolveBotPage：页签库存读不到时如实抛错，绝不盲建重复页签', async () => {
  let created = 0;
  const h = makeEgo([{ id: 6, name: SPACE_NAME }]);
  const taskSpace = async (id) => ({
    id,
    pages: async () => { throw Error('fixture inventory failure'); },
    newPage: async () => { created++; return mkPage('p9', 'about:blank', []); },
    page: () => mkPage('p9', onDomain, []),
  });
  await assert.rejects(() => resolveBotPage(h.ego, taskSpace, 'p1'), /inventory/);
  assert.equal(created, 0); // 盲建会让内存问题复发——库存未知时宁可本轮失败
});
check('resolveBotPage：页签被导航走（离域）时停回资产页一次', async () => {
  const navigations = [];
  const h = makeEgo([{ id: 8, name: SPACE_NAME }]);
  const taskSpace = async (id) => ({
    id,
    pages: async () => [{ label: 'p1' }],
    newPage: async () => mkPage('p2', 'about:blank', navigations),
    page: (label) => mkPage(label, 'about:blank', navigations),
  });
  const { page, navigated } = await resolveBotPage(h.ego, taskSpace, 'p1');
  assert.equal(page.label, 'p1');
  assert.equal(navigated, true);
  assert.deepEqual(navigations, [PARK_URL]);
});
console.log(`${count} ego space scenarios passed`);
