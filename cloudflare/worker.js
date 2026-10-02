// Cloudflare Worker: receives inspection snapshots (token-protected POST) and serves
// the dashboard (token-gated read). KV stores the latest snapshot.
export { LikeCounter } from "./likes.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const writeToken = env.DASH_WRITE_TOKEN; // POST 上传专用，永不公开
    if (!writeToken) return new Response("DASH_WRITE_TOKEN secret not set", { status: 500 });
    // 读取与首页公开（实盘展示用途）；只有写入受 DASH_WRITE_TOKEN 保护

    if (url.pathname === "/api/snapshot" && request.method === "POST") {
      if (request.headers.get("x-token") !== writeToken) return new Response("forbidden", { status: 403 });
      const body = await request.text();
      try { JSON.parse(body); } catch { return new Response("invalid JSON", { status: 400 }); }
      await env.DASH.put("latest", body);
      return new Response("ok");
    }

    if ((url.pathname === "/api/like" && request.method === "POST") || (url.pathname === "/api/likes" && request.method === "GET")) {
      const ip = request.headers.get("cf-connecting-ip");
      if (!ip) return new Response("visitor address unavailable", { status: 400 });
      const day = new Date().toISOString().slice(0, 10);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + writeToken + "|" + day));
      const visitor = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      if (!env.LIKES) return new Response("likes storage unavailable", { status: 503 });
      const stub = env.LIKES.get(env.LIKES.idFromName("dashboard-likes"));
      return stub.fetch(new Request("https://likes.internal/", { method: "POST", body: JSON.stringify({ visitor, day, increment: request.method === "POST" }) }));
    }

    if (url.pathname === "/api/snapshot") {
      const snap = await env.DASH.get("latest");
      return new Response(snap ?? "{}", {
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    return new Response("not found", { status: 404 });
  },
};
