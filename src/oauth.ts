import { randomUUID, createHash } from "node:crypto";
import type { Request, Response, Router } from "express";
import express from "express";
import type { AppConfig } from "./types.js";

/**
 * 假 OAuth —— 专门伺候 OpenAI/ChatGPT 这类「必须走 OAuth 才肯接远程 MCP」的在线客户端。
 *
 * 它对外长得完全像标准 OAuth2：
 *   /.well-known/oauth-authorization-server   RFC 8414 元数据
 *   /.well-known/oauth-protected-resource     RFC 9728 资源元数据
 *   POST /register                            RFC 7591 动态客户端注册
 *   GET/POST /authorize                       授权页（这里让用户「填 key」）
 *   POST /token                               换 token（code / refresh_token）
 *   + PKCE(S256) 支持
 *
 * 但内核只有一条规则：**授权页里填的那个 key 必须等于 daemon 的 token**，
 * 换出来的 access_token 就是这把 key 本身。所以现有 Bearer 鉴权不用改。
 * 没有真 OAuth 的第三方账号体系，也就没有"授权范围"这套东西 —— 一把钥匙通到底。
 */

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  challenge?: string;
  method?: string;
  state?: string;
  expires: number;
}

const CODE_TTL_MS = 5 * 60 * 1000;

export function createOAuthRouter(cfg: AppConfig): Router {
  const router = express.Router();
  // OAuth 客户端按规范发 x-www-form-urlencoded（授权码换 token、授权页表单），必须单独解析
  router.use(express.urlencoded({ extended: false, limit: "256kb" }));
  router.use(express.json({ limit: "256kb" }));
  const codes = new Map<string, AuthCode>();
  const clientId = "sshmcp-client";
  const clientSecret = "sshmcp-secret";

  const baseUrl = (req: Request): string => {
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
    const host = (req.headers["x-forwarded-host"] as string) || req.get("host") || `${cfg.host}:${cfg.port}`;
    return `${proto}://${host}`;
  };

  const json = (res: Response, body: unknown) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(body);
  };

  // ── 元数据 ───────────────────────────────────────────────────────────
  const metadata = (req: Request) => {
    const b = baseUrl(req);
    return {
      issuer: b,
      authorization_endpoint: `${b}/authorize`,
      token_endpoint: `${b}/token`,
      registration_endpoint: `${b}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
      scopes_supported: ["mcp"],
      service_documentation: `${b}/health`,
    };
  };

  router.get("/.well-known/oauth-authorization-server", (req, res) => json(res, metadata(req)));
  router.get("/.well-known/oauth-authorization-server/mcp", (req, res) => json(res, metadata(req)));
  router.get("/.well-known/openid-configuration", (req, res) => json(res, metadata(req)));

  const resourceMeta = (req: Request) => {
    const b = baseUrl(req);
    return {
      resource: `${b}/mcp`,
      authorization_servers: [b],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
      resource_documentation: `${b}/health`,
    };
  };
  router.get("/.well-known/oauth-protected-resource", (req, res) => json(res, resourceMeta(req)));
  router.get("/.well-known/oauth-protected-resource/mcp", (req, res) => json(res, resourceMeta(req)));

  // ── 动态客户端注册 ───────────────────────────────────────────────────
  router.post("/register", (req, res) => {
    const body = (req.body ?? {}) as { redirect_uris?: unknown; client_name?: unknown };
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    json(res, {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      client_name: typeof body.client_name === "string" ? body.client_name : "mcp-client",
    });
  });

  // ── 授权页：让用户填 key ─────────────────────────────────────────────
  const page = (opts: { error?: string; params: Record<string, string> }) => {
    const hidden = Object.entries(opts.params)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`)
      .join("\n");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>sshmcp · 授权</title>
<style>
 :root{color-scheme:light}
 body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6f8;color:#111}
 .card{background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:28px 26px;width:min(440px,92vw);box-shadow:0 8px 28px rgba(0,0,0,.06)}
 h1{font-size:19px;margin:0 0 6px}
 p{margin:0 0 16px;color:#5b6472;font-size:13.5px}
 label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
 input[type=text]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d5dae1;border-radius:9px;font:inherit}
 input[type=text]:focus{outline:none;border-color:#2f6fed;box-shadow:0 0 0 3px rgba(47,111,237,.12)}
 button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:9px;background:#2f6fed;color:#fff;font:inherit;font-weight:600;cursor:pointer}
 button:hover{background:#275fd0}
 .err{margin:0 0 12px;padding:9px 12px;border-radius:8px;background:#fdecec;color:#b42318;font-size:13px}
 code{background:#f1f3f5;padding:1px 5px;border-radius:4px;font-size:12.5px}
 .tip{margin-top:14px;font-size:12px;color:#8a93a0}
</style></head><body>
<div class="card">
  <h1>sshmcp 授权</h1>
  <p>这个页面是给在线 MCP 客户端用的。粘贴本机 daemon 的 key 即可授权（key 见 <code>sshmcp config</code>）。</p>
  ${opts.error ? `<div class="err">${escapeHtml(opts.error)}</div>` : ""}
  <form method="post" action="/authorize">
    ${hidden}
    <label for="key">Access Key</label>
    <input id="key" name="key" type="text" autocomplete="off" spellcheck="false" placeholder="粘贴 sshmcp token" autofocus>
    <button type="submit">授权并继续</button>
  </form>
  <div class="tip">填错了会回到这一页；key 只用于校验，不会外传。</div>
</div></body></html>`;
  };

  const collect = (req: Request): Record<string, string> => {
    const src = req.method === "POST" ? (req.body ?? {}) : req.query;
    const out: Record<string, string> = {};
    for (const k of [
      "response_type",
      "client_id",
      "redirect_uri",
      "state",
      "scope",
      "code_challenge",
      "code_challenge_method",
    ]) {
      const v = (src as Record<string, unknown>)[k];
      if (typeof v === "string" && v) out[k] = v;
    }
    return out;
  };

  router.get("/authorize", (req, res) => {
    res.type("html").send(page({ params: collect(req) }));
  });

  router.post("/authorize", (req, res) => {
    const p = collect(req);
    const key = String((req.body as { key?: string })?.key ?? "").trim();

    if (key !== cfg.token) {
      res.status(401).type("html").send(page({ error: "key 不正确", params: p }));
      return;
    }
    if (!p.redirect_uri) {
      res.status(400).json({ error: "invalid_request", error_description: "missing redirect_uri" });
      return;
    }

    const code = randomUUID().replace(/-/g, "");
    codes.set(code, {
      code,
      clientId: p.client_id || clientId,
      redirectUri: p.redirect_uri,
      scope: p.scope || "mcp",
      challenge: p.code_challenge,
      method: p.code_challenge_method,
      state: p.state,
      expires: Date.now() + CODE_TTL_MS,
    });

    const u = new URL(p.redirect_uri);
    u.searchParams.set("code", code);
    if (p.state) u.searchParams.set("state", p.state);
    res.redirect(302, u.toString());
  });

  // ── 换 token ─────────────────────────────────────────────────────────
  router.post("/token", (req, res) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const grant = b.grant_type;

    if (grant === "refresh_token") {
      // 无状态：refresh_token 就是 key 的别名，直接再发一次
      json(res, {
        access_token: cfg.token,
        token_type: "Bearer",
        expires_in: 31536000,
        refresh_token: cfg.token,
        scope: "mcp",
      });
      return;
    }

    if (grant !== "authorization_code") {
      json(res, { error: "unsupported_grant_type" });
      return;
    }

    const rec = codes.get(b.code);
    if (!rec || rec.expires < Date.now()) {
      json(res, { error: "invalid_grant", error_description: "code expired or unknown" });
      return;
    }
    codes.delete(b.code);

    // PKCE 校验
    if (rec.challenge) {
      const verifier = b.code_verifier || "";
      const calc =
        rec.method === "S256" ? createHash("sha256").update(verifier).digest("base64url") : verifier;
      if (calc !== rec.challenge) {
        json(res, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }

    json(res, {
      access_token: cfg.token,
      token_type: "Bearer",
      expires_in: 31536000,
      refresh_token: cfg.token,
      scope: rec.scope,
    });
  });

  // 清过期 code（避免长期堆积）
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
  }, 10 * 60 * 1000).unref?.();

  return router;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
