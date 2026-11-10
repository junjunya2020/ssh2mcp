import type { Express } from "express";
import type { AppConfig } from "../types.js";
import type { ConnectionPool } from "../ssh/pool.js";
import { addHost, removeHost, loadHosts } from "../store/hosts.js";
import { setSecret, removeSecret } from "../store/vault.js";

/** /admin JSON API，供 CLI 调用 */
export function registerAdminRoutes(app: Express, cfg: AppConfig, pool: ConnectionPool): void {
  app.get("/admin/hosts", (_req, res) => {
    res.json({ hosts: loadHosts() });
  });

  app.post("/admin/hosts", (req, res) => {
    try {
      const b = req.body ?? {};
      const entry = addHost({
        name: b.name,
        host: b.host,
        port: b.port ? Number(b.port) : undefined,
        user: b.user,
        authType: b.authType,
        keyPath: b.keyPath,
        certPath: b.certPath,
        proxyJump: b.proxyJump,
        defaultDir: b.defaultDir,
        description: b.description,
      });
      if (b.password || b.passphrase) {
        setSecret(entry.name, { password: b.password, passphrase: b.passphrase });
      }
      res.json({ ok: true, host: entry });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.delete("/admin/hosts/:name", async (req, res) => {
    const name = req.params.name;
    const removed = removeHost(name);
    removeSecret(name);
    if (!removed) {
      res.status(404).json({ ok: false, error: `host '${name}' 不存在` });
      return;
    }
    try {
      await pool.disconnect(name);
    } catch {
      /* ignore */
    }
    res.json({ ok: true });
  });

  app.post("/admin/hosts/:name/test", async (req, res) => {
    try {
      const c = await pool.connect(req.params.name);
      const r = await pool.exec(req.params.name, { command: "echo sshmcp-ok && uname -a" });
      res.json({ ok: true, connect: c, probe: r });
    } catch (e) {
      res.status(400).json({ ok: false, error: (e as Error).message });
    }
  });

  app.get("/admin/sessions", (_req, res) => {
    res.json(pool.list());
  });

  app.get("/admin/config", (_req, res) => {
    // 不回传 token 明文以外的机密；token 用于客户端配置，本地 CLI 可取
    res.json({ host: cfg.host, port: cfg.port, token: cfg.token, dataDir: cfg.dataDir });
  });
}
