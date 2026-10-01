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

    if (url.pathname === "/api/likes" && request.method === "POST") {
      // 每 IP 每天 1 次赞（IP 哈希 + 日期记录，自动清理过期项）
      const day = new Date().toISOString().slice(0, 10);
      const ip = request.headers.get("cf-connecting-ip") || "unknown";
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|like-salt-v1|" + day));
      const h = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
      const ips = JSON.parse((await env.DASH.get("like_ips")) || "{}");
      for (const k of Object.keys(ips)) if (ips[k] !== day) delete ips[k];
      const likes = Number((await env.DASH.get("likes")) || 0);
      if (ips[h] === day) return new Response(JSON.stringify({ likes, already: true }), { headers: { "content-type": "application/json" } });
      ips[h] = day;
      const next = likes + 1;
      await env.DASH.put("likes", String(next));
      await env.DASH.put("like_ips", JSON.stringify(ips));
      return new Response(JSON.stringify({ likes: next, already: false }), { headers: { "content-type": "application/json" } });
    }

    if (url.pathname === "/api/likes") {
      const likes = Number((await env.DASH.get("likes")) || 0);
      return new Response(JSON.stringify({ likes }), { headers: { "content-type": "application/json" } });
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
