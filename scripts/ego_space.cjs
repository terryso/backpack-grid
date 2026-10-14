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

// 空间 + 页签一次解析到位：全新空间没有页签，task.page() 的惰性句柄会在 goto 时才炸——
// 必须显式创建。新空间的第一个页签自动命名 p1（与 config.watch.page 对应）；
// 已有页签但无目标标签时复用第一个现有页签。
async function resolveBotPage(ego, taskSpace, pageLabel, log = () => {}) {
  const task = await resolveBotSpace(ego, taskSpace, log);
  let labels = [];
  try { labels = (await task.pages()).map(p => (typeof p === "string" ? p : p.label ?? p.id)).filter(Boolean); } catch {}
  if (labels.includes(pageLabel)) return { task, page: task.page(pageLabel) };
  if (labels.length) { log(`page ${pageLabel} missing — using existing ${labels[0]}`); return { task, page: task.page(labels[0]) }; }
  const page = await task.newPage();
  log(`page ${pageLabel} missing — created as ${page.label ?? pageLabel}`);
  return { task, page };
}

// Dedicated collector tabs may be closed while their space remains alive. A
// cached label is only usable when it is present in the live page inventory.
async function resolveCollectorPage(task, cached) {
  const pages = await task.pages();
  if (cached && cached.spaceId === task.spaceId && typeof cached.page === 'string'
    && pages.some(page => page.label === cached.page)) {
    return { page: task.page(cached.page), replaced: false };
  }
  return { page: await task.newPage(), replaced: true };
}

module.exports = { resolveBotSpace, resolveBotPage, resolveCollectorPage, SPACE_NAME };
