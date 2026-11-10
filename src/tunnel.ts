import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** ESM 下没有 __dirname，这里自己算一次（dist/tunnel.js → 项目根） */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export interface TunnelState {
  running: boolean;
  url?: string;
  pid?: number;
  startedAt?: string;
  binary?: string;
  loggedIn: boolean;
  loginUrl?: string;
  lastLines?: string[];
  mode?: "quick" | "named";
  customUrl?: string;
}

const URL_RX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const LOGIN_RX = /https:\/\/dash\.cloudflare\.com\/argotunnel\?[^\s"']+/i;

/** 全局隧道配置（由 daemon 注入；quick=免登录临时域名，named=自定义域名） */
export interface TunnelOptions {
  mode: "quick" | "named";
  /** named 模式：自定义公网地址（如 https://mcp.example.com） */
  customUrl?: string;
}

/**
 * Cloudflare 隧道管理，**生命周期严格绑在 daemon 上**：
 *  - daemon 里 spawn 子进程，daemon 退出/被 Ctrl+C 时 kill 掉；
 *  - 不装服务、不留后台常驻，域名跟着这次 daemon 会话走。
 *
 * quick：`cloudflared tunnel --url <local>`，拿到 https://<random>.trycloudflare.com（每次不同）。
 * named：`cloudflared tunnel run`（用 CF 后台预建 tunnel + `cloudflared service install <token>` 配置），
 *        公网地址是你绑在 CF DNS 上的自定义域名（固定）。
 */
export class TunnelManager {
  private proc?: ChildProcess;
  private url?: string;
  private startedAt?: string;
  private loginProc?: ChildProcess;
  private loginUrl?: string;
  private tunnelName?: string;
  private tail: string[] = [];
  private opts: TunnelOptions = { mode: "quick" };

  constructor(
    private localUrl: string,
    private dataDir: string,
    private persistState = true,
  ) {}

  setOptions(opts: TunnelOptions): void {
    this.opts = opts;
  }

  /** 二进制查找：CLOUDFLARED_PATH → ./bin/ → PATH */
  resolveBinary(): string | undefined {
    const envPath = process.env.CLOUDFLARED_PATH;
    if (envPath && fs.existsSync(envPath)) return envPath;
    const name = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    const candidates = [
      path.resolve("bin", name),
      path.resolve(HERE, "..", "bin", name),
      path.resolve(HERE, "..", "..", "bin", name),
    ];
    for (const p of candidates) if (fs.existsSync(p)) return p;
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }

  isLoggedIn(): boolean {
    return fs.existsSync(path.join(os.homedir(), ".cloudflared", "cert.pem"));
  }

  private log(line: string): void {
    const t = line.trim();
    if (!t) return;
    this.tail.push(t);
    if (this.tail.length > 30) this.tail.shift();
    process.stdout.write(`[cf] ${t}\n`);
  }

  /** 登录：打印链接 → 等 cert.pem */
  async login(timeoutMs = 300000): Promise<{ loginUrl?: string; loggedIn: boolean }> {
    if (this.isLoggedIn()) return { loggedIn: true };
    const bin = this.resolveBinary();
    if (!bin) throw new Error("未找到 cloudflared 可执行文件（放 bin/cloudflared.exe 或设 CLOUDFLARED_PATH）");
    if (this.loginProc) return { loginUrl: this.loginUrl, loggedIn: false };

    const proc = spawn(bin, ["tunnel", "login"], { stdio: ["ignore", "pipe", "pipe"] });
    this.loginProc = proc;
    const onData = (b: Buffer) => {
      const s = b.toString();
      for (const line of s.split(/\r?\n/)) this.log(line);
      const m = s.match(LOGIN_RX) || this.tail.join("\n").match(LOGIN_RX);
      if (m && !this.loginUrl) {
        this.loginUrl = m[0];
        process.stdout.write(`\n[cf] 请在浏览器打开以下链接登录 Cloudflare 账户：\n\n    ${this.loginUrl}\n\n`);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);

    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.isLoggedIn()) {
        proc.kill();
        this.loginProc = undefined;
        process.stdout.write("[cf] 登录成功，已保存凭据到 ~/.cloudflared/cert.pem\n");
        return { loginUrl: this.loginUrl, loggedIn: true };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    proc.kill();
    this.loginProc = undefined;
    throw new Error("登录超时（5 分钟未完成）");
  }

  /** 启动隧道：quick 返回临时域名；named 走自定义域名（固定） */
  async start(timeoutMs = 90000): Promise<{ url: string; pid?: number }> {
    if (this.proc && this.url) return { url: this.url, pid: this.proc.pid };
    const bin = this.resolveBinary();
    if (!bin) throw new Error("未找到 cloudflared 可执行文件（放 bin/cloudflared.exe 或设 CLOUDFLARED_PATH）");

    this.killStale();
    // 再兜一层：杀掉本机所有遗留的 cloudflared，确保拿到的是全新 URL（快速隧道每次新域名）
    this.killExistingCloudflared();

    if (this.opts.mode === "named") {
      return this.startNamed(bin, timeoutMs);
    }

    const proc = spawn(bin, ["tunnel", "--url", this.localUrl, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.proc = proc;

    const url = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.stop();
          reject(new Error("等 Cloudflare 分配域名超时"));
        }
      }, timeoutMs);

      const onData = (b: Buffer) => {
        const s = b.toString();
        for (const line of s.split(/\r?\n/)) this.log(line);
        const m = s.match(URL_RX) || this.tail.join("\n").match(URL_RX);
        if (m && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      proc.on("exit", (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`cloudflared 退出 (code=${code})`));
        }
        this.proc = undefined;
        this.url = undefined;
      });
    });

    this.url = url;
    this.startedAt = new Date().toISOString();
    this.saveState();
    process.stdout.write(`\n[cf] 公网地址： ${url}\n[cf] MCP 端点： ${url}/mcp\n\n`);
    return { url, pid: proc.pid };
  }

  /**
   * named 模式：用预建 tunnel 跑 `cloudflared tunnel run`。
   * 前提：已在 CF 后台建好 tunnel 并 `cloudflared service install <token>`（或存在 credentials 文件），
   * 且已把自定义域名 CNAME 到 <tunnel-id>.cfargotunnel.com。公网地址 = opts.customUrl。
   */
  private async startNamed(bin: string, timeoutMs: number): Promise<{ url: string; pid?: number }> {
    const name = this.opts.customUrl || "";
    if (!name) throw new Error("named 模式需要先设置自定义域名（菜单可设，config.tunnelCustomUrl）");

    // 找到 tunnel 运行目标：优先环境变量 SSHMCP_CF_TUNNEL（tunnel 名或 token）
    const target = process.env.SSHMCP_CF_TUNNEL;
    if (!target) {
      throw new Error(
        "named 模式需要 CF 预建 tunnel：请先 `cloudflared service install <token>` 或设置环境变量 SSHMCP_CF_TUNNEL=<tunnel名>",
      );
    }

    const args = target.length > 100 ? ["tunnel", "run"] : ["tunnel", "run", target];
    const proc = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...(target.length > 100 ? { TUNNEL_TOKEN: target } : {}) },
    });
    this.proc = proc;
    this.tunnelName = name;

    // 等连接建立（日志出现 "Registered tunnel connection" / "Connection ... registered"）
    const ok = await new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(true); // 超时不等于失败，named 域名是固定的，继续用
        }
      }, Math.min(timeoutMs, 30000));
      const onData = (b: Buffer) => {
        const s = b.toString();
        for (const line of s.split(/\r?\n/)) this.log(line);
        if (/Registered tunnel connection|Connection .* registered|Registered tunnel/i.test(s) && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(true);
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      proc.on("exit", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      });
    });

    if (!ok) {
      this.stop();
      throw new Error("named 隧道连接失败（检查 CF tunnel token/凭证 与 DNS 绑定）");
    }

    this.url = name;
    this.startedAt = new Date().toISOString();
    this.saveState();
    process.stdout.write(`\n[cf] 自定义域名隧道已连接： ${name}\n[cf] MCP 端点： ${name}/mcp\n\n`);
    return { url: name, pid: proc.pid };
  }

  stop(): { stopped: boolean } {
    const proc = this.proc;
    this.proc = undefined;
    const had = !!proc;
    if (proc && proc.pid) {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      if (process.platform === "win32") {
        // cloudflared 在 Windows 上偶有子进程残留
        try {
          spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } catch {
          /* ignore */
        }
      }
    }
    this.url = undefined;
    this.startedAt = undefined;
    this.saveState();
    if (had) process.stdout.write("[cf] 隧道已停止\n");
    return { stopped: had };
  }

  status(): TunnelState {
    return {
      running: !!(this.proc && this.url),
      url: this.url,
      pid: this.proc?.pid,
      startedAt: this.startedAt,
      binary: this.resolveBinary(),
      loggedIn: this.isLoggedIn(),
      loginUrl: this.loginUrl,
      lastLines: this.tail.slice(-8),
      mode: this.opts.mode,
      customUrl: this.opts.customUrl,
    };
  }

  private statePath(): string {
    return path.join(this.dataDir, "tunnel.json");
  }

  private saveState(): void {
    if (!this.persistState) return; // 一次性模式：不落 state 文件，退出时目录可干净删除
    try {
      fs.writeFileSync(
        this.statePath(),
        JSON.stringify({ url: this.url ?? null, pid: this.proc?.pid ?? null, startedAt: this.startedAt ?? null }, null, 2),
      );
    } catch {
      /* ignore */
    }
  }

  /**
   * 杀掉本机所有遗留的 cloudflared 进程（不经状态文件）。
   * 必须**同步**执行：否则异步 taskkill 会在新隧道起来之后才落地，把自己刚起的那条也杀掉。
   */
  killExistingCloudflared(): void {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/IM", "cloudflared.exe", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        spawnSync("pkill", ["-f", "cloudflared"], { stdio: "ignore" });
      }
    } catch {
      /* ignore */
    }
  }

  /** daemon 启动时清理上次残留的孤儿隧道（守护进程被强杀时可能留下） */
  killStale(): void {
    try {
      const raw = fs.readFileSync(this.statePath(), "utf-8");
      const st = JSON.parse(raw) as { pid?: number | null };
      if (!st.pid) return;
      if (this.proc?.pid === st.pid) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(st.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } else {
        try {
          process.kill(st.pid, "SIGTERM");
        } catch {
          /* ignore */
        }
      }
      process.stdout.write(`[cf] 清理上次残留隧道 pid=${st.pid}\n`);
    } catch {
      /* 没有状态文件，正常 */
    }
  }
}
