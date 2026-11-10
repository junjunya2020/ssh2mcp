import express from "express";
import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AppConfig } from "../types.js";
import { saveConfig } from "../config.js";
import type { ConnectionPool } from "../ssh/pool.js";
import { buildMcpServer } from "../mcp/server.js";
import { newSessionCtx } from "../mcp/session.js";
import type { GlobalBinding, SessionCtx } from "../mcp/session.js";
import { PushHub } from "../push.js";
import type { Subscriber } from "../push.js";
import { SubscriptionManager } from "../subscriptions.js";
import { createOAuthRouter } from "../oauth.js";
import { registerAdminRoutes } from "./admin-routes.js";
import type { TunnelManager } from "../tunnel.js";

interface SessionRec {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  ctx: SessionCtx;
}

/** 空闲会话回收：12h 无请求即销毁并释放其上 SSH 连接 */
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000;

export function createApp(cfg: AppConfig, pool: ConnectionPool, tunnel?: TunnelManager) {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json({ limit: "4mb" }));

  // 访问日志：同时写前台 stdout 和 dataDir/sshmcp.log（排查客户端行为用）
  const logFile = path.join(cfg.dataDir, "sshmcp.log");
  let logStream: fs.WriteStream | undefined;
  try {
    logStream = fs.createWriteStream(logFile, { flags: "a" });
    logStream.on("error", () => {
      logStream = undefined;
    });
  } catch {
    logStream = undefined;
  }
  const logLine = (line: string) => {
    process.stdout.write(line);
    try {
      logStream?.write(line);
    } catch {
      /* ignore */
    }
  };

  const hub = new PushHub();
  const subs = new SubscriptionManager(pool, hub);
  const gb: GlobalBinding = {};
  const sessions = new Map<string, SessionRec>();

  // 前台可见的访问日志（health 不刷屏）
  let lastHealthLog = 0;
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/health") {
      const now = Date.now();
      if (now - lastHealthLog > 60000) {
        lastHealthLog = now;
        logLine(`[${new Date().toISOString()}] GET /health\n`);
      }
      return next();
    }
    const t0 = Date.now();
    const h = req.header("authorization") || "";
    const authState = !h ? "none" : h.startsWith("Bearer ") ? "bearer" : "other";
    const sid = req.header("mcp-session-id") || "-";
    res.on("finish", () => {
      logLine(
        `[${new Date().toISOString()}] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - t0}ms) auth=${authState} sid=${sid.slice(0, 8)}\n`,
      );
    });
    next();
  });

  // 假 OAuth：给 ChatGPT / OpenAI 等在线客户端用。必须在 Bearer 鉴权之前挂载，
  // 否则 /authorize、/token、/.well-known/* 会被 401 挡掉。
  app.use(createOAuthRouter(cfg));

  // Bearer 鉴权（/health 与落地页 GPT 探测 GET / 除外）
  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "GET" && (req.path === "/health" || req.path === "/")) return next();
    const h = req.header("authorization") || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (token !== cfg.token) {
      logLine(
        `[${new Date().toISOString()}] ${req.method} ${req.path} -> 401 auth=${
          !h ? "none" : h.startsWith("Bearer ") ? `badBearer(len=${token.length})` : "other"
        } ua=${(req.header("user-agent") || "-").slice(0, 40)}\n`,
      );
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${req.protocol}://${req.get("host")}/.well-known/oauth-protected-resource"`,
      );
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
  app.use(auth);

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "sshmcp",
      version: "0.3.0",
      transport: "streamable-http",
      sessions: sessions.size,
      listeners: hub.totalListeners(),
      tunnel: tunnel ? { running: tunnel.status().running, url: tunnel.status().url } : undefined,
      boundHosts: [
        ...new Set(
          [...sessions.values()]
            .map((s) => s.ctx.boundHost)
            .filter((h): h is string => !!h),
        ),
      ],
    });
  });

  // 落地页：浏览器直接打开公网地址时给出「已就绪 + MCP/OAuth 地址」的可读页面，
  // 也让在线平台对 GET / 的探测不撞 401（避免它们把服务判成不可用直接放弃）。
  app.get("/", (req, res) => {
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
    const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || `${cfg.host}:${cfg.port}`;
    const b = `${proto}://${host}`;
    res.type("html").send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>sshmcp</title>
<style>body{font:15px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:8vh auto;padding:0 20px;color:#1a1d22}
h1{font-size:20px}code{background:#f1f3f5;padding:2px 6px;border-radius:5px;font-size:13px}
.row{margin:10px 0}.k{color:#8a93a0;font-size:13px}</style></head><body>
<h1>🪶 sshmcp 已就绪</h1>
<p class="k">这是一个远程 MCP（Streamable HTTP）服务，在线客户端请按下面对接：</p>
<div class="row"><span class="k">MCP 端点：</span><br><code>${b}/mcp</code></div>
<div class="row"><span class="k">授权页（粘贴 key）：</span><br><code>${b}/authorize</code></div>
<div class="row"><span class="k">OAuth 元数据：</span><br><code>${b}/.well-known/oauth-authorization-server</code></div>
<p class="k" style="margin-top:22px">在 ChatGPT/OpenAI 里添加自定义 MCP 连接器时填上面的 /mcp；授权时把本机 key 粘进去即可。</p>
</body></html>`);
  });

  async function releaseSession(rec: SessionRec): Promise<void> {
    const key = rec.ctx.sessionId ?? "";
    if (key) {
      const stopped = subs.stopSession(key);
      if (stopped) process.stdout.write(`  stopped ${stopped} subscription(s) of ${key}\n`);
      hub.closeSession(key);
    }
    const host = rec.ctx.boundHost;
    if (!host) return;
    const shells = pool.shellCount(host);
    try {
      await pool.disconnect(host);
      process.stdout.write(
        `[${new Date().toISOString()}] session ${key || "?"} closed -> disconnect ${host} (shells closed: ${shells})\n`,
      );
    } catch {
      /* 连接可能已断 */
    }
  }

  /** 取会话：严格模式，没有/不认识就 null（不猜、不兼容） */
  function getSession(req: Request): SessionRec | null {
    const sid = req.header("mcp-session-id");
    if (!sid) return null;
    return sessions.get(sid) ?? null;
  }

  function replyNoSession(res: Response, reason: string): void {
    res.status(400).json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: `missing or unknown mcp-session-id: ${reason}` },
    });
  }

  // ── POST /mcp ──────────────────────────────────────────────────────────
  // 1) method=subscriptions/listen → 长时间 SSE 下行流（新版 Streamable HTTP 的流式响应）
  // 2) 其余 JSON-RPC → 交给官方 transport（必须带 mcp-session-id，initialize 除外）
  app.post("/mcp", async (req: Request, res: Response) => {
    const body = req.body as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown } | undefined;

    if (body?.method === "subscriptions/listen") {
      const rec = getSession(req);
      if (!rec) {
        replyNoSession(res, "subscriptions/listen requires an initialized session");
        return;
      }
      const sid = rec.ctx.sessionId!;
      rec.ctx.lastSeen = Date.now();

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Mcp-Session-Id": sid,
        "X-Accel-Buffering": "no",
      });

      const subId = `sse_${randomUUID()}`;
      const subscriber: Subscriber = {
        id: subId,
        sessionKey: sid,
        write: (evt) => {
          // 只推真实事件；不发注释行/心跳，避免 AI 把空帧当输出
          res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: evt.method, params: evt.params })}\n\n`);
        },
        close: () => {
          try {
            res.end();
          } catch {
            /* ignore */
          }
        },
      };
      hub.add(subscriber);

      // 一次性 ack（不是心跳）：告诉客户端流已建立、会话 id 与订阅现状
      res.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/sshmcp.stream_ready",
          params: {
            sessionId: sid,
            subId,
            boundHost: rec.ctx.boundHost ?? null,
            subscriptions: subs.list().length,
            at: Date.now(),
          },
        })}\n\n`,
      );

      const cleanup = () => {
        hub.remove(subscriber);
        subs.stopSession(sid); // 流断了，订阅定时器一起收掉，避免僵尸
      };
      // 注意：POST 的 req 'close' 在 body 读完后就会触发（Node 16+），
      // 必须挂在 res 上，才是"客户端断开这条流"。
      res.on("close", cleanup);
      res.on("error", cleanup);
      return;
    }

    const sid = req.header("mcp-session-id");

    // 已有会话：路由到它的 transport（状态在 SessionCtx 里）
    if (sid) {
      const rec = sessions.get(sid);
      if (!rec) {
        replyNoSession(res, "session not found or expired; re-initialize");
        return;
      }
      rec.ctx.lastSeen = Date.now();
      try {
        await rec.transport.handleRequest(req, res, req.body);
      } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
      }
      return;
    }

    // 无会话 id：只允许 initialize（严格模式，不做任何兼容回退）
    if (!body || body.method !== "initialize") {
      replyNoSession(res, "send initialize first; legacy session-less mode is not supported");
      return;
    }

    const ctx = newSessionCtx();
    let rec: SessionRec | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
        ctx.sessionId = id;
        if (rec) sessions.set(id, rec);
        process.stdout.write(`[${new Date().toISOString()}] mcp session ${id} initialized\n`);
      },
    });
    const server = buildMcpServer(pool, ctx, gb, hub, subs);
    rec = { server, transport, ctx };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      void releaseSession(rec!);
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
    }
  });

  // GET：新版 Streamable HTTP 的服务端主动消息流（可选），必须有会话 id
  app.get("/mcp", async (req: Request, res: Response) => {
    const rec = getSession(req);
    if (!rec) {
      replyNoSession(res, "GET stream requires mcp-session-id");
      return;
    }
    rec.ctx.lastSeen = Date.now();
    try {
      await rec.transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
    }
  });

  // DELETE：显式销毁会话 → 断 SSH、停订阅
  app.delete("/mcp", async (req: Request, res: Response) => {
    const rec = getSession(req);
    if (!rec) {
      replyNoSession(res, "DELETE requires mcp-session-id");
      return;
    }
    try {
      await rec.transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
    }
  });

  // 空闲会话回收
  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, rec] of sessions) {
      if (now - rec.ctx.lastSeen > SESSION_IDLE_MS) {
        process.stdout.write(`[${new Date().toISOString()}] reap idle mcp session ${id}\n`);
        sessions.delete(id);
        void releaseSession(rec).finally(() => {
          rec.transport.close().catch(() => {});
          rec.server.close().catch(() => {});
        });
      }
    }
  }, 10 * 60 * 1000);
  reaper.unref?.();

  // ── Cloudflare 隧道控制（走 Bearer 鉴权，CLI/菜单调用） ──────────────
  app.get("/admin/tunnel", (_req, res) => {
    res.json({
      ...(tunnel ? tunnel.status() : { running: false, reason: "tunnel manager not attached" }),
      autoStart: cfg.tunnelAutoStart ?? false,
    });
  });
  // 设置「daemon 启动时自动开隧道」开关（持久化到 config，需重启 daemon 生效）
  app.post("/admin/tunnel/autostart", (req, res) => {
    const on = !!(req.body as { on?: boolean })?.on;
    cfg.tunnelAutoStart = on;
    saveConfig(cfg);
    res.json({ autoStart: on, effective: "next-daemon-start" });
  });
  app.post("/admin/tunnel/start", async (_req, res) => {
    if (!tunnel) return res.status(500).json({ error: "tunnel manager not attached" });
    try {
      res.json(await tunnel.start());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
  app.post("/admin/tunnel/stop", (_req, res) => {
    if (!tunnel) return res.status(500).json({ error: "tunnel manager not attached" });
    res.json(tunnel.stop());
  });
  app.post("/admin/tunnel/login", async (_req, res) => {
    if (!tunnel) return res.status(500).json({ error: "tunnel manager not attached" });
    try {
      res.json(await tunnel.login());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  registerAdminRoutes(app, cfg, pool);

  // 供 CLI / 其它模块查询（非 MCP 接口）
  app.get("/admin/push", (_req, res) => {
    res.json({ listeners: hub.totalListeners(), subscriptions: subs.list() });
  });

  return app;
}
