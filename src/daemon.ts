import http from "node:http";
import { getConfig, saveConfig } from "./config.js";
import { Audit } from "./security/audit.js";
import { ConnectionPool } from "./ssh/pool.js";
import { createApp } from "./http/app.js";
import { TunnelManager } from "./tunnel.js";

export async function runDaemon(flags: { port?: number; foreground?: boolean }): Promise<void> {
  const cfg = getConfig();
  if (flags.port && flags.port !== cfg.port) {
    cfg.port = flags.port;
    saveConfig(cfg); // 持久化，保证 CLI/客户端与 daemon 端口一致
  }

  const audit = new Audit(cfg);
  const pool = new ConnectionPool(cfg, audit);

  // 隧道生命周期 = daemon 生命周期：进程在，隧道在；进程退出，隧道一起退。
  const tunnel = new TunnelManager(`http://127.0.0.1:${cfg.port}`, cfg.dataDir);
  tunnel.killStale(); // 清掉上次被强杀残留的孤儿隧道

  const app = createApp(cfg, pool, tunnel);

  const server = http.createServer(app);

  await new Promise<void>((resolve) => {
    server.listen(cfg.port, cfg.host, () => resolve());
  });

  const url = `http://${cfg.host}:${cfg.port}`;
  process.stdout.write(`sshmcp daemon 已启动\n`);
  process.stdout.write(`  MCP  : ${url}/mcp\n`);
  process.stdout.write(`  Admin: ${url}/admin\n`);
  process.stdout.write(`  数据 : ${cfg.dataDir}\n`);
  if (!tunnel.resolveBinary()) {
    process.stdout.write(`  CF   : 未找到 cloudflared（放到 bin/cloudflared.exe）\n`);
  } else if (!cfg.tunnelAutoStart) {
    process.stdout.write(`  CF   : 未启用（菜单 10 可手动开；或在菜单设为默认随 daemon 自动开）\n`);
  }

  // 默认自动开隧道时：每次 daemon 启动都拉一个全新的免登录隧道（URL 每次不同）
  if (cfg.tunnelAutoStart && tunnel.resolveBinary()) {
    process.stdout.write(`  CF   : 正在开启隧道，等待分配公网地址...\n`);
    try {
      const { url: turl } = await tunnel.start();
      process.stdout.write(`  CF   : ${turl}\n`);
      process.stdout.write(`         MCP 公网: ${turl}/mcp\n`);
    } catch (e) {
      process.stdout.write(`  CF   : 隧道启动失败: ${(e as Error).message}\n`);
    }
  }

  const shutdown = (sig: string) => {
    process.stdout.write(`\n收到 ${sig}，正在关闭...\n`);
    try {
      tunnel.stop(); // 隧道跟 daemon 一起退
    } catch {
      /* ignore */
    }
    pool.closeAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // 兜底：进程以任何方式退出时都杀掉隧道子进程，不留常驻
  process.on("exit", () => {
    try {
      tunnel.stop();
    } catch {
      /* ignore */
    }
  });
}
