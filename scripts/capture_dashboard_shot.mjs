// capture_dashboard_shot.mjs — 每日 README 实盘截图（经 ego_dispatch 派发，ego-browser 内执行）。
// 专用 docs-shot 空间 + 2560 宽视口 + zoom 2（2 倍密度），截取后拷贝到 state/ 供 shell 侧
// 缩放与提交。页面复用 p1；站点不可达时抛错退出，shell 侧保留旧图。
const fs = await import("node:fs");
const out = {};
const SHOT_DST = "__BG_ROOT__/state/dashboard_shot_raw.png";
let spaces = await ego.listTaskSpaces();
let hit = spaces.taskSpaces.find(s => s.name === "docs-shot");
if (!hit) {
  await ego.createTaskSpace("docs-shot", "Default");
  await new Promise(r => setTimeout(r, 1500));
  spaces = await ego.listTaskSpaces();
  hit = spaces.taskSpaces.find(s => s.name === "docs-shot");
}
const task = await taskSpace(hit.id);
// task.page() 对不存在的标签返回惰性句柄（goto 才炸），必须先枚举真实页签
let labels = [];
try { labels = (await task.pages()).map(p => (typeof p === "string" ? p : p.label ?? p.id)).filter(Boolean); } catch {}
const page = labels.includes("p1") ? task.page("p1") : await task.newPage(); // 首个页签自动命名 p1
page.cdp("Emulation.setDeviceMetricsOverride", { width: 2560, height: 2120, deviceScaleFactor: 1, mobile: false });
await page.goto("https://grid.terryso.dev", { waitUntil: "domcontentloaded", timeout: 25000 });
await page.waitForTimeout(6000); // 快照 fetch + 客户端渲染
await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
await page.waitForTimeout(1500);
// 隐藏滚动条：成品图不需要浏览器 chrome
await page.evaluate(() => {
  const st = document.createElement("style");
  st.textContent = "::-webkit-scrollbar{display:none!important} html{scrollbar-width:none!important}";
  document.head.appendChild(st);
});
// 角标水印：让看图的人一眼知道数据拍摄时刻（静态 README 图没有「现在」的概念）
await page.evaluate(() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const el = document.createElement("div");
  el.textContent = `📸 实盘截图 · ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  el.style.cssText = "position:fixed;top:18px;right:24px;z-index:99999;background:rgba(11,14,20,.92);border:1px solid #2b3550;border-radius:10px;color:#9fc1ff;font:600 24px/1.4 -apple-system,'PingFang SC',sans-serif;padding:10px 18px;box-shadow:0 4px 16px rgba(0,0,0,.5);";
  document.body.appendChild(el);
});
await page.waitForTimeout(300);
const shotPath = await page.screenshot();
fs.copyFileSync(shotPath, SHOT_DST);
// 截完立刻关闭空间，不留窗口（ego 的自动回收有延迟）
try { await ego.closeTaskSpace(); out.closed = true; } catch (e) { out.closeErr = String(e.message).slice(0, 80); }
console.log("dashboard shot captured:", shotPath, JSON.stringify(out));
