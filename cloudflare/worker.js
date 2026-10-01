// Cloudflare Worker: receives inspection snapshots (token-protected POST) and serves
// the dashboard (token-gated read). KV stores the latest snapshot.
import html from "./dashboard.html";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const writeToken = env.DASH_WRITE_TOKEN; // POST 上传专用，永不公开
    if (!writeToken) return new Response("DASH_WRITE_TOKEN secret not set", { status: 500 });
    // 读取与首页公开（实盘展示用途）；只有写入受 DASH_WRITE_TOKEN 保护

    if (url.pathname === "/api/snapshot" && request.method === "POST") {
      if (request.headers.get("x-token") !== writeToken) return new Response("forbidden", { status: 403 });
      const body = await request.text();
      JSON.parse(body); // reject malformed uploads
      await env.DASH.put("latest", body);
      return new Response("ok");
    }

    if (url.pathname === "/api/snapshot") {
      const snap = await env.DASH.get("latest");
      return new Response(snap ?? "{}", {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === "/") {
      return new Response(html.replaceAll("__TOKEN__", ""), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    return new Response("not found", { status: 404 });
  },
};
