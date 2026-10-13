'use strict';
// ego_space.cjs 回归：按名附加 / 缺失自动重建 / 重建失败如实抛错。
const assert = require('node:assert/strict');
const { resolveBotSpace, SPACE_NAME } = require('../scripts/ego_space.cjs');
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
console.log(`${count} ego space scenarios passed`);
