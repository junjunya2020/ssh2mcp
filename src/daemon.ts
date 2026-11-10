import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfig, saveConfig } from "./config.js";
import { paths, ensureDir } from "./paths.js";
import { Audit } from "./security/audit.js";
import { ConnectionPool } from "./ssh/pool.js";
import { createApp } from "./http/app.js";
import { TunnelManager } from "./tunnel.js";

const FIXED_KNOWN_HOSTS = path.join("C:\\ProgramData\\sshmcp", "known_hosts");

/** 找一个当前空闲的本地端口（用于一次性模式） */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function runDaemon(flags: {
  port?: number;
  foreground?: boolean;
  oneshot?: boolean;
}): Promise<void> {
  // 服务化环境（WinSW / systemd）会设置这个标志；一次性模式禁止在服务模式下使用
  const serviceMode = process.env.SSHMCP_SERVICE === "1";
  const oneshot = !!flags.oneshot;

  if (oneshot && serviceMode) {
    throw new Error("一次性模式不支持在系统服务下运行，请以 --foreground 前台手动运行");
  }

  // ── 一次性模式：随机端口 + 随机 key + 临时 CF 隧道 + 仅主机密钥持久化 ──
  if (oneshot && !flags.foreground) {
    throw new Error("一次性模式必须前台运行：请使用 `sshmcp daemon --oneshot --foreground`");
  }

  if (oneshot) {
    await runOneshot();
    return;
  }

  // ── 正常模式 ──────────────────────────────────────────────────────────
  const cfg = getConfig();
  if (flags.port && flags.port !== cfg.port) {
    cfg.port = flags.port;
    saveConfig(cfg); // 持久化，保证 CLI/客户端与 daemon 端口一致
  }

  const audit = new Audit(cfg);
  const pool = new ConnectionPool(cfg, audit);

  const tunnel = new TunnelManager(`http://127.0.0.1:${cfg.port}`, cfg.dataDir);
  tunnel.setOptions({ mode: cfg.tunnelMode === "named" ? "named" : "quick", customUrl: cfg.tunnelCustomUrl });
  tunnel.killStale();

  const app = createApp(cfg, pool, tunnel);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, () => resolve()));

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
      tunnel.stop();
    } catch {
      /* ignore */
    }
    pool.closeAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", () => {
    try {
      tunnel.stop();
    } catch {
      /* ignore */
    }
  });
}

/**
 * 一次性模式：
 *  - 随机本地端口、随机 Bearer key（只在控制台打印一次，不落盘）
 *  - 强制 quick 免登录临时隧道（即使有 CF 登录凭证也强制临时链接；出现登录也会被忽略/取消）
 *  - 数据目录独立临时化：hosts 从主注册表只读载入（复用已登记主机/密钥），vault/审计留在内存
 *  - 唯一持久化的东西：known_hosts（主机密钥），保证不误报 MITM 也能复用信任
 *  - 进程退出：清掉临时目录、杀隧道，什么都不留
 */
async function runOneshot(): Promise<void> {
  const realDataDir = getConfig(true).dataDir; // 固定真实数据目录（只读取 hosts/vault/known_hosts）

  const port = await findFreePort();
  const token = crypto.randomBytes(24).toString("base64url");
  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMP || ".", "sshmcp-oneshot-"));
  ensureDir(tmpDir);

  // 启动前清扫历史一次性临时目录（上次被强杀可能残留）
  try {
    const tmpRoot = process.env.TEMP || process.env.TMP || ".";
    for (const name of fs.readdirSync(tmpRoot)) {
      if (name.startsWith("sshmcp-oneshot-") && path.join(tmpRoot, name) !== tmpDir) {
        try {
          fs.rmSync(path.join(tmpRoot, name), { recursive: true, force: true });
        } catch {
          /* 被占用就算了 */
        }
      }
    }
  } catch {
    /* ignore */
  }

  // 临时配置：端口/key 随机，数据目录指向临时目录（绝不写回 config.json）
  const cfg = {
    ...(getConfig(true) as any),
    host: "127.0.0.1",
    port,
    token,
    dataDir: tmpDir,
    tunnelAutoStart: false,
    tunnelMode: "quick" as const,
    tunnelCustomUrl: "",
    safetyGuard: true,
  };

  // 只读复用主注册表 hosts.json 与 vault.enc；known_hosts 用固定持久路径
  try {
    const srcHosts = paths(realDataDir).hosts;
    if (fs.existsSync(srcHosts)) fs.copyFileSync(srcHosts, paths(tmpDir).hosts);
    const srcVault = paths(realDataDir).vault;
    if (fs.existsSync(srcVault)) fs.copyFileSync(srcVault, paths(tmpDir).vault);
    const srcMaster = paths(realDataDir).masterKey;
    if (fs.existsSync(srcMaster)) fs.copyFileSync(srcMaster, paths(tmpDir).masterKey);
  } catch {
    /* 没有也可继续（一次性模式可现场 host add） */
  }

  const audit = new Audit(cfg as any);
  const pool = new ConnectionPool(cfg as any, audit, FIXED_KNOWN_HOSTS);

  const tunnel = new TunnelManager(`http://127.0.0.1:${port}`, tmpDir, false);
  tunnel.setOptions({ mode: "quick" }); // 强制临时链接
  tunnel.killStale();
  // 不调用 killExistingCloudflared：避免影响同时运行的正常 daemon 的隧道；临时目录+quick 本身即新 URL

  const app = createApp(cfg as any, pool, tunnel, { fileLog: false });
  const server = http.createServer(app);

  // 清理与信号处理：必须在任何 await 之前注册，否则启动过程中按 Ctrl+C 会走默认退出、不清理
  let closing = false;
  const cleanup = () => {
    try {
      tunnel.stop();
    } catch {
      /* ignore */
    }
    pool.closeAll();
    try {
      (app as unknown as { closeLog?: () => void }).closeLog?.();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    const t = setTimeout(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }, 800);
    t.unref?.();
  };
  const shutdown = (sig: string) => {
    if (closing) return;
    closing = true;
    process.stdout.write(`\n收到 ${sig}，正在关闭并清理一次性数据...\n`);
    cleanup();
    try {
      server.close(() => process.exit(0));
    } catch {
      /* ignore */
    }
    setTimeout(() => process.exit(0), 2500).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("exit", cleanup);

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));

  // ── 一次性信息：全部只打印这一次，不落盘 ──
  process.stdout.write(`\n============================================================\n`);
  process.stdout.write(`  sshmcp 一次性模式（临时、随机、免登录）\n`);
  process.stdout.write(`============================================================\n`);
  process.stdout.write(`  本地 MCP : http://127.0.0.1:${port}/mcp\n`);
  process.stdout.write(`  Key      : ${token}\n`);
  process.stdout.write(`  （以上仅本次有效，进程退出即失效，不写入任何配置文件）\n`);

  process.stdout.write(`  CF       : 正在开启免登录临时隧道...\n`);
  try {
    const { url: turl } = await tunnel.start();
    process.stdout.write(`  公网 MCP : ${turl}/mcp\n`);
    process.stdout.write(`  授权页   : ${turl}/authorize\n`);
  } catch (e) {
    process.stdout.write(`  CF       : 隧道启动失败: ${(e as Error).message}\n`);
  }
  process.stdout.write(`============================================================\n\n`);
}
