import fs from "node:fs";
import ssh2 from "ssh2";
import type { ConnectConfig, Client as SshClient } from "ssh2";
import type { AppConfig, HostEntry } from "../types.js";

const { Client } = ssh2;

/** 私钥路径归一化：处理 ~ / %USERPROFILE% / 相对/绝对（服务进程 HOME 可能缺失） */
function resolveKeyPath(p: string): string {
  let out = p.trim();
  out = out.replace(/%([^%]+)%/g, (_m, k) => process.env[k] ?? _m);
  if (out.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    out = out.replace(/^~/, home);
  }
  return out;
}
import { getHost, loadHosts } from "../store/hosts.js";
import { getSecret } from "../store/vault.js";
import { SafetyGuard } from "../security/guard.js";
import { OutputTruncator } from "../security/truncator.js";
import { Audit } from "../security/audit.js";
import { HostKeyVerifier } from "./hostkey.js";
import { execOnClient, type ExecOptions } from "./exec-channel.js";
import { ShellChannel } from "./shell-channel.js";
import { createTerminal } from "../term.js";

interface HostRuntime {
  entry: HostEntry;
  clients: SshClient[];
  connecting?: Promise<SshClient>;
}

export class ConnectionPool {
  private hosts = new Map<string, HostRuntime>();
  private shells = new Map<string, ShellChannel>();
  private shellSeq = 0;
  private guard: SafetyGuard;
  private truncator: OutputTruncator;
  private hostKey: HostKeyVerifier;

  constructor(
    private cfg: AppConfig,
    private audit: Audit,
    knownHostsPath?: string,
  ) {
    this.guard = new SafetyGuard();
    this.truncator = new OutputTruncator(cfg.maxOutputBytes);
    this.hostKey = new HostKeyVerifier(cfg, knownHostsPath);
  }

  private buildConnectConfig(entry: HostEntry): ConnectConfig {
    const secret = getSecret(entry.name);
    const base: ConnectConfig = {
      host: entry.host,
      port: entry.port,
      username: entry.user,
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      keepaliveCountMax: 3,
      hostVerifier: this.hostKey.verifier(entry.host, entry.port),
    };
    if (entry.authType === "password") {
      if (!secret?.password) throw new Error(`host '${entry.name}' 缺少密码（用 host add 重新登记）`);
      base.password = secret.password;
    } else {
      if (!entry.keyPath) throw new Error(`host '${entry.name}' 缺少 keyPath`);
      let key: Buffer;
      try {
        key = fs.readFileSync(resolveKeyPath(entry.keyPath));
      } catch (e) {
        throw new Error(`读取私钥失败 ${entry.keyPath}: ${(e as Error).message}`);
      }
      base.privateKey = key;
      if (secret?.passphrase) base.passphrase = secret.passphrase;
    }
    return base;
  }

  private async createClient(entry: HostEntry): Promise<SshClient> {
    const config = this.buildConnectConfig(entry);
    const client = new Client();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        client.removeListener("ready", onReady);
        client.removeListener("error", onError);
      };
      client.once("ready", onReady);
      client.once("error", onError);
      try {
        client.connect(config);
      } catch (e) {
        onError(e as Error);
      }
    });
    return client;
  }

  /** 确保该 host 至少有一条连接，返回运行时 */
  async ensureConnected(name: string): Promise<HostRuntime> {
    const entry = getHost(name);
    if (!entry) throw new Error(`未登记的 host: '${name}'（先用 sshmcp host add 添加）`);
    let rt = this.hosts.get(name);
    if (!rt) {
      rt = { entry, clients: [] };
      this.hosts.set(name, rt);
    }
    if (rt.clients.length === 0) {
      if (!rt.connecting) {
        rt.connecting = this.createClient(entry)
          .then((c) => {
            c.on("close", () => this.handleClientClose(rt!, c));
            c.on("error", () => {
              /* swallow; close 会处理清理 */
            });
            rt!.clients.push(c);
            return c;
          })
          .finally(() => {
            rt!.connecting = undefined;
          });
      }
      await rt.connecting;
    }
    return rt;
  }

  private handleClientClose(rt: HostRuntime, client: SshClient): void {
    const idx = rt.clients.indexOf(client);
    if (idx >= 0) rt.clients.splice(idx, 1);
    // 该连接上的 shell 会被 ssh2 关闭并各自 onClose，无需在此处理
  }

  /** 获取一条可用连接；channel 打开失败时自动新增连接（多连接回退） */
  private async acquireClient(name: string): Promise<SshClient> {
    const rt = await this.ensureConnected(name);
    if (rt.clients.length === 0) await this.ensureConnected(name);
    return rt.clients[0];
  }

  async connect(name: string): Promise<{
    name: string;
    connected: boolean;
    host: string;
    port: number;
    user: string;
    latencyMs: number;
  }> {
    const start = Date.now();
    const rt = await this.ensureConnected(name);
    this.audit.log({ event: "host_connect", name, ok: true });
    return {
      name,
      connected: rt.clients.length > 0,
      host: rt.entry.host,
      port: rt.entry.port,
      user: rt.entry.user,
      latencyMs: Date.now() - start,
    };
  }

  async exec(hostName: string, opts: ExecOptions) {
    const client = await this.acquireClient(hostName);
    this.audit.log({ event: "exec", host: hostName, command: opts.command });
    return execOnClient(client, opts, this.guard, this.truncator);
  }

  async openShell(
    hostName: string,
    opts: { rows?: number; cols?: number; term?: string; cwd?: string; env?: Record<string, string> },
  ) {
    const rows = opts.rows ?? 30;
    const cols = opts.cols ?? 120;
    const term = opts.term ?? "xterm-256color";
    const client = await this.acquireClient(hostName);

    const stream = await new Promise<import("ssh2").ClientChannel>((resolve, reject) => {
      client.shell({ term, rows, cols }, { env: opts.env }, (err, s) => {
        if (err) return reject(err);
        resolve(s);
      });
    }).catch(async (err: Error) => {
      // 多连接回退：当前连接 channel 到顶/失败，另开一条连接重试一次
      const rt = this.hosts.get(hostName)!;
      if (rt.clients.length >= this.cfg.maxConnPerHost) {
        throw new Error(`host '${hostName}' 已达最大连接数 ${this.cfg.maxConnPerHost}，仍无法开 shell: ${err.message}`);
      }
      const fresh = await this.createClient(rt.entry);
      fresh.on("close", () => this.handleClientClose(rt, fresh));
      rt.clients.push(fresh);
      return await new Promise<import("ssh2").ClientChannel>((resolve, reject) => {
        fresh.shell({ term, rows, cols }, { env: opts.env }, (e, s) => {
          if (e) return reject(e);
          resolve(s);
        });
      });
    });

    const shellId = `sh_${++this.shellSeq}_${Date.now()}`;
    const shell = new ShellChannel(
      shellId,
      hostName,
      stream,
      rows,
      cols,
      { createTerminal },
    );
    this.shells.set(shellId, shell);
    // 自动 GC
    stream.on("close", () => {
      this.shells.delete(shellId);
    });
    // 等首屏就绪，避免 openShell 立即读屏时为空的竞态
    await shell.waitForFirstData(1500);
    this.audit.log({ event: "shell_open", host: hostName, shellId });
    return shell;
  }

  getShell(shellId: string): ShellChannel {
    const s = this.shells.get(shellId);
    if (!s) throw new Error(`未找到 shell 会话 '${shellId}'`);
    return s;
  }

  closeShell(shellId: string): boolean {
    const s = this.shells.get(shellId);
    if (!s) return false;
    s.close();
    this.shells.delete(shellId);
    this.audit.log({ event: "shell_close", shellId });
    return true;
  }

  /** 该主机上当前活跃的交互式 shell 数（切换主机时判断能否安全断开） */
  shellCount(hostName: string): number {
    let n = 0;
    for (const s of this.shells.values()) if (s.hostName === hostName) n++;
    return n;
  }

  /** 该主机是否还有活着的 SSH 长连接（长连接优先继承用） */
  isConnected(hostName: string): boolean {
    const rt = this.hosts.get(hostName);
    return !!rt && rt.clients.length > 0;
  }

  /** 当前所有还活着的长连接主机名 */
  connectedHosts(): string[] {
    const out: string[] = [];
    for (const [name, rt] of this.hosts) if (rt.clients.length > 0) out.push(name);
    return out;
  }

  async disconnect(hostName: string): Promise<{ closedChannels: number }> {
    const rt = this.hosts.get(hostName);
    let closed = 0;
    for (const [id, s] of this.shells) {
      if (s.hostName === hostName) {
        s.close();
        this.shells.delete(id);
        closed++;
      }
    }
    if (rt) {
      for (const c of rt.clients) {
        try {
          c.end();
        } catch {
          /* ignore */
        }
      }
      this.hosts.delete(hostName);
    }
    this.audit.log({ event: "host_disconnect", host: hostName, closed });
    return { closedChannels: closed };
  }

  /** 列出所有「已登记」主机，并合并当前运行时连接状态（含未连接的） */
  listHosts() {
    const reg = loadHosts();
    return reg.map((h) => {
      const rt = this.hosts.get(h.name);
      const connections = rt?.clients.length ?? 0;
      const shells = [...this.shells.values()].filter((s) => s.hostName === h.name).length;
      return {
        name: h.name,
        host: h.host,
        port: h.port,
        user: h.user,
        authType: h.authType,
        description: h.description,
        state: connections > 0 ? "connected" : "disconnected",
        connections,
        shells,
      };
    });
  }

  list() {
    const hosts = [...this.hosts.values()].map((rt) => ({
      name: rt.entry.name,
      host: rt.entry.host,
      port: rt.entry.port,
      user: rt.entry.user,
      state: rt.clients.length > 0 ? "connected" : "disconnected",
      connections: rt.clients.length,
      channels: {
        shell: [...this.shells.values()].filter((s) => s.hostName === rt.entry.name).length,
      },
    }));
    const shells = [...this.shells.values()].map((s) => s.info());
    return { hosts, shells };
  }

  closeAll(): void {
    for (const [, s] of this.shells) s.close();
    this.shells.clear();
    for (const [, rt] of this.hosts) {
      for (const c of rt.clients) {
        try {
          c.end();
        } catch {
          /* ignore */
        }
      }
    }
    this.hosts.clear();
  }
}
