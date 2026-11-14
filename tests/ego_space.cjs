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
check('用户持有控制权路由：takeOver/claim/旧运行器回退/接管抛错兜底（串行——共享全局）', async () => {
  // check() 不 await async 场景：四条路径共享 globalThis 接管全局，必须在一个
  // 场景内串行完成，否则注入/恢复互相交错
  let taken = 0, claimed = 0;
  const prevTake = globalThis.takeOverTaskSpace;
  const prevClaim = globalThis.claimTaskSpace;
  try {
    // ① agentDelegatedToUser → takeOverTaskSpace，不走普通 attach
    {
      const h = makeEgo([{ id: 11, name: SPACE_NAME, ownership: 'agentDelegatedToUser' }]);
      let attached = 0;
      h.taskSpace = async (id) => { attached++; return { id }; };
      globalThis.takeOverTaskSpace = async (id) => { taken++; return { id, via: 'takeover' }; };
      const t = await resolveBotSpace(h.ego, h.taskSpace);
      assert.equal(taken, 1);
      assert.equal(attached, 0); // pages() 在 user-held 空间会被拒，绝不能普通 attach
      assert.equal(t.via, 'takeover');
    }
    // ② ownership=user（finish keep 后）→ claimTaskSpace
    {
      const h = makeEgo([{ id: 12, name: SPACE_NAME, ownership: 'user' }]);
      globalThis.claimTaskSpace = async (id) => { claimed++; return { id, via: 'claim' }; };
      const t = await resolveBotSpace(h.ego, h.taskSpace);
      assert.equal(claimed, 1);
      assert.equal(t.via, 'claim');
    }
    // ③ 旧运行器无接管全局：回退普通 attach 不抛错（fail-loud 语义保留）
    {
      globalThis.takeOverTaskSpace = undefined;
      globalThis.claimTaskSpace = undefined;
      const h = makeEgo([{ id: 13, name: SPACE_NAME, ownership: 'agentDelegatedToUser' }]);
      const t = await resolveBotSpace(h.ego, h.taskSpace);
      assert.equal(t.id, 13);
      assert.equal(t.attached, true);
    }
    // ④ 接管 API 抛错：落回重建兜底
    {
      globalThis.takeOverTaskSpace = async () => { throw Error('takeover race'); };
      const h = makeEgo([{ id: 14, name: SPACE_NAME, ownership: 'agentDelegatedToUser' }]);
      const t = await resolveBotSpace(h.ego, h.taskSpace);
      assert.equal(h.created.length, 1); // 重建了一个新空间
      assert.equal(t.attached, true);
    }
  } finally {
    globalThis.takeOverTaskSpace = prevTake;
    globalThis.claimTaskSpace = prevClaim;
  }
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
    tabs: async () => [],
    newPage: async () => { const label = 'p' + (pages.length + 1); pages.push(label); return mkPage(label, 'about:blank', navigations); },
    page: (label) => { if (!pages.includes(label)) throw Error('page label not found: ' + label); return mkPage(label, onDomain, navigations); },
  });
  const { page, navigated } = await resolveBotPage(h.ego, taskSpace, 'p1');
  assert.equal(page.label, 'p1');
  assert.equal(navigated, true);
  assert.deepEqual(navigations, [PARK_URL]); // 新页签离域 → 停车恰好一次
});
check('resolveBotPage：claim 后无 managed page 时收养现有页签，绝不新建第二个', async () => {
  let created = 0, adopted = 0; const navigations = [];
  const h = makeEgo([{ id: 9, name: SPACE_NAME }]);
  const keptTab = mkPage('kept', 'https://backpack.exchange/markets', navigations);
  const taskSpace = async (id) => ({
    id,
    pages: async () => [], // claim 之后没有 managed page
    tabs: async () => [{ label: null, page: keptTab }],
    adopt: async (p) => { adopted++; p.label = 'p1'; return p; },
    newPage: async () => { created++; return mkPage('px', 'about:blank', navigations); },
    page: (label) => mkPage(label, onDomain, navigations),
  });
  const { page } = await resolveBotPage(h.ego, taskSpace, 'p1');
  assert.equal(adopted, 1);
  assert.equal(created, 0); // 单页签纪律：收养旧页签而不是盲建新页签
  assert.equal(page.label, 'p1');
  assert.deepEqual(navigations, []); // 收养的页签已在 backpack 域 → 零导航
});
check('resolveBotPage：claim 后空间真空才新建页签', async () => {
  const navigations = [];
  const h = makeEgo([{ id: 10, name: SPACE_NAME }]);
  const taskSpace = async (id) => ({
    id,
    pages: async () => [],
    tabs: async () => [],
    adopt: async () => { throw Error('adopt must not be called'); },
    newPage: async () => mkPage('p1', 'about:blank', navigations),
    page: (label) => mkPage(label, onDomain, navigations),
  });
  const { page, navigated } = await resolveBotPage(h.ego, taskSpace, 'p1');
  assert.equal(page.label, 'p1');
  assert.equal(navigated, true);
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
