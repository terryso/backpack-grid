'use strict';
// ego_space.cjs — 按名字解析 bot 的 task space；空间被 ego 回收/关闭时自动重建。
// Backpack 登录 cookies 挂在 profile（Default）上、不随空间消失——重建后无需重新登录。
// 仅在 ego-browser 派发上下文内使用（依赖注入的 ego / taskSpace 全局）。

const SPACE_NAME = "backpack-bot";

async function resolveBotSpace(ego, taskSpace, log = () => {}) {
  const spaces = await ego.listTaskSpaces();
  const hit = spaces.taskSpaces.find(s => s.name === SPACE_NAME);
  if (hit) {
    try { return await taskSpace(hit.id); } catch (e) { log(`attach ${hit.id} failed: ${String(e.message).slice(0, 60)} — recreating`); }
  }
  await ego.createTaskSpace(SPACE_NAME, "Default");
  await new Promise(r => setTimeout(r, 1500)); // ego 后端注册新空间需要一点时间
  const fresh = await ego.listTaskSpaces();
  const made = fresh.taskSpaces.find(s => s.name === SPACE_NAME);
  if (!made) throw Error("task space recreate failed: " + SPACE_NAME);
  log(`task space was missing — recreated as id ${made.id}`);
  return await taskSpace(made.id);
}

module.exports = { resolveBotSpace, SPACE_NAME };
