'use strict';
// ego_space.cjs — 按名字解析 bot 的 task space；空间被 ego 回收/关闭时自动重建。
// Backpack 登录 cookies 挂在 profile（Default）上、不随空间消失——重建后无需重新登录。
// 仅在 ego-browser 派发上下文内使用（依赖注入的 ego / taskSpace 全局）。
//
// 单页签纪律：全系统（observe/act/peak_probe/两个采集器）只维持一个常驻页签，
// 停在资产总览页，所有数据获取都是带 cookie 的 page.fetch。导航只发生在页签
// 不在 backpack 域名时（空间重建后首次接线），稳态零导航——重载页面会杀死
// 其它使用方的 in-flight fetch，且交易页过重，多页签纯属内存浪费。

const SPACE_NAME = "backpack-bot";
const PARK_URL = "https://backpack.exchange/portfolio/balances/assets"; // 轻页面：只为提供会话 origin

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

// 空间 + 页签一次解析到位，返回的页面保证停在 backpack 域名（可直接 page.fetch）。
// 全新空间没有页签，task.page() 的惰性句柄会在使用时才炸——必须显式创建。新空间的
// 第一个页签自动命名 p1（与 config.watch.page 对应）；已有页签但无目标标签时复用
// 第一个现有页签，绝不新建第二个。
async function resolveBotPage(ego, taskSpace, pageLabel, log = () => {}) {
  const task = await resolveBotSpace(ego, taskSpace, log);
  let labels;
  try { labels = (await task.pages()).map(p => (typeof p === "string" ? p : p.label ?? p.id)).filter(Boolean); }
  // 页签库存读不到时禁止盲建——盲建会在已有页签旁边再造一个，内存问题复发
  catch (e) { throw Error(`page inventory unavailable: ${String(e.message).slice(0, 80)}`); }
  let page;
  if (labels.includes(pageLabel)) page = task.page(pageLabel);
  else if (labels.length) { log(`page ${pageLabel} missing — using existing ${labels[0]}`); page = task.page(labels[0]); }
  else { page = await task.newPage(); log(`page ${pageLabel} missing — created as ${page.label ?? pageLabel}`); }
  const navigated = await parkBotPage(page, log);
  return { task, page, navigated };
}

// 页面不在 backpack 域名下时导航到资产总览页。url() 拿不到（旧句柄/瞬时失败）按
// 离域保守处理——多导航一次无害，漏导航会让 fetch 失去会话 origin。返回是否发生了导航。
async function parkBotPage(page, log = () => {}) {
  let cur = null;
  try { cur = typeof page.url === "function" ? await page.url() : null; } catch { cur = null; }
  if (cur && String(cur).startsWith("https://backpack.exchange")) return false;
  await page.goto(PARK_URL, { waitUntil: "domcontentloaded", timeout: 25000 })
    .catch(() => page.waitForTimeout(3000).then(() => page.goto(PARK_URL, { waitUntil: "domcontentloaded", timeout: 25000 })));
  await page.waitForTimeout(1500); // 首次落点后稍作沉淀；稳态调用不经过这里
  return true;
}

module.exports = { resolveBotSpace, resolveBotPage, parkBotPage, SPACE_NAME, PARK_URL };
