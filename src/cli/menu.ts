import readline from "node:readline";
import { getConfig } from "../config.js";
import { addHost, removeHost, loadHosts } from "../store/hosts.js";
import { setSecret, removeSecret, selfTest } from "../store/vault.js";
import { adminRequest, daemonAlive } from "../http/client.js";

/** 带隐藏密码输入的交互提示器（单例 readline，避免缓冲丢失） */
class Prompter {
  private rl: readline.Interface;
  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.on("SIGINT", () => {
      this.rl.close();
      process.stdout.write("\n已退出。\n");
      process.exit(0);
    });
  }
  ask(q: string): Promise<string> {
    return new Promise((res) => this.rl.question(q, (a) => res(a)));
  }
  /** 隐藏读取（TTY）；非 TTY 退回普通读取 */
  secret(q: string): Promise<string> {
    if (!process.stdin.isTTY) return this.ask(q);
    return new Promise((res) => {
      const stdin = process.stdin;
      this.rl.pause();
      process.stdout.write(q);
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.setEncoding("utf-8");
      let buf = "";
      const onData = (ch: string) => {
        for (const c of ch) {
          if (c === "\r" || c === "\n") {
            stdin.setRawMode?.(false);
            stdin.pause();
            stdin.removeListener("data", onData);
            process.stdout.write("\n");
            this.rl.resume();
            res(buf);
            return;
          }
          if (c === "\u0003") {
            stdin.setRawMode?.(false);
            process.exit(130);
          }
          if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
          else buf += c;
        }
      };
      stdin.on("data", onData);
    });
  }
  close() {
    this.rl.close();
  }
}

async function needDaemon(cfg: ReturnType<typeof getConfig>): Promise<boolean> {
  if (await daemonAlive(cfg)) return true;
  process.stdout.write("\n✗ daemon 未运行。请先运行 start-daemon.bat 启动守护进程。\n");
  return false;
}

async function opAddKey(p: Prompter): Promise<void> {
  process.stdout.write("\n--- 添加主机（密钥认证）---\n");
  const host = (await p.ask("主机地址(IP/域名): ")).trim();
  const nameInput = (await p.ask("主机别名(回车=直接用上面的地址): ")).trim();
  const user = (await p.ask("登录用户名: ")).trim();
  let port = (await p.ask("端口(回车=22): ")).trim();
  let keyPath = (await p.ask(`私钥路径(回车=${process.env.USERPROFILE || "~"}\\.ssh\\id_ed25519): `)).trim();
  const hasPass = (await p.ask("私钥是否带口令?(y/N): ")).trim().toLowerCase() === "y";
  if (!host || !user) {
    process.stdout.write("✗ 地址/用户名不能为空\n");
    return;
  }
  if (!port) port = "22";
  if (!keyPath) keyPath = `${process.env.USERPROFILE || "~"}\\.ssh\\id_ed25519`;
  try {
    const entry = addHost({ name: nameInput || undefined, host, port: Number(port), user, authType: "key", keyPath });
    if (hasPass) {
      const pp = await p.secret("输入私钥口令: ");
      setSecret(entry.name, { passphrase: pp });
    }
    process.stdout.write(`✓ 已添加 host '${entry.name}' (${user}@${host}:${port}, key)\n`);
  } catch (e) {
    process.stdout.write(`✗ ${(e as Error).message}\n`);
  }
}

async function opAddPass(p: Prompter): Promise<void> {
  process.stdout.write("\n--- 添加主机（密码认证）---\n");
  const host = (await p.ask("主机地址(IP/域名): ")).trim();
  const nameInput = (await p.ask("主机别名(回车=直接用上面的地址): ")).trim();
  const user = (await p.ask("登录用户名: ")).trim();
  let port = (await p.ask("端口(回车=22): ")).trim();
  if (!host || !user) {
    process.stdout.write("✗ 地址/用户名不能为空\n");
    return;
  }
  if (!port) port = "22";
  const pw = await p.secret("输入登录密码(不回显，仅写入加密库): ");
  try {
    const entry = addHost({ name: nameInput || undefined, host, port: Number(port), user, authType: "password" });
    setSecret(entry.name, { password: pw });
    process.stdout.write(`✓ 已添加 host '${entry.name}' (${user}@${host}:${port}, password)\n`);
  } catch (e) {
    process.stdout.write(`✗ ${(e as Error).message}\n`);
  }
}

async function opRemove(p: Prompter): Promise<void> {
  const name = (await p.ask("要删除的主机别名: ")).trim();
  if (!name) return;
  const cfg = getConfig();
  const removed = removeHost(name);
  removeSecret(name);
  if (await daemonAlive(cfg)) {
    await adminRequest(cfg, "DELETE", `/admin/hosts/${encodeURIComponent(name)}`).catch(() => {});
  }
  process.stdout.write(removed ? `✓ 已删除 host '${name}'\n` : `host '${name}' 不存在\n`);
}

function opList(): void {
  const hosts = loadHosts();
  if (hosts.length === 0) {
    process.stdout.write("(没有已登记的 host)\n");
    return;
  }
  for (const h of hosts) {
    process.stdout.write(
      `${h.name.padEnd(16)} ${h.user}@${h.host}:${h.port}  auth=${h.authType}${h.keyPath ? " key=" + h.keyPath : ""}\n`,
    );
  }
}

async function opTest(p: Prompter): Promise<void> {
  const cfg = getConfig();
  if (!(await needDaemon(cfg))) return;
  const name = (await p.ask("要测试的主机别名: ")).trim();
  if (!name) return;
  const r = await adminRequest(cfg, "POST", `/admin/hosts/${encodeURIComponent(name)}/test`);
  process.stdout.write(JSON.stringify(r.json, null, 2) + "\n");
}

async function opSessions(): Promise<void> {
  const cfg = getConfig();
  if (!(await needDaemon(cfg))) return;
  const r = await adminRequest(cfg, "GET", "/admin/sessions");
  process.stdout.write(JSON.stringify(r.json, null, 2) + "\n");
}

function opConfig(): void {
  const cfg = getConfig();
  process.stdout.write(
    `host: ${cfg.host}\nport: ${cfg.port}\ndataDir: ${cfg.dataDir}\ntoken: ${cfg.token}\n\n` +
      `客户端 MCP 配置示例:\n` +
      `{"mcpServers":{"sshmcp":{"type":"http","url":"http://${cfg.host}:${cfg.port}/mcp","headers":{"Authorization":"Bearer ${cfg.token}"}}}}\n`,
  );
}

/** 连接 CF：一键开免登录临时隧道（quick tunnel）→ 拿公网域名 → 在线客户端用假 OAuth 接入 */
async function opCf(p: Prompter): Promise<void> {
  const cfg = getConfig();
  if (!(await needDaemon(cfg))) {
    process.stdout.write("提示：隧道跑在 daemon 里，daemon 退出隧道一起退出。先 start-daemon.bat\n");
    return;
  }
  for (;;) {
    const st = await adminRequest(cfg, "GET", "/admin/tunnel");
    const s = st.json ?? {};
    const auto = !!s.autoStart;
    process.stdout.write(
      "\n--- 连接 CF（免登录临时隧道 + 假 OAuth）---\n" +
        `  cloudflared: ${s.binary || "(未找到 bin/cloudflared.exe)"}\n` +
        `  自动随daemon开: ${auto ? "已开启（每次启动换新 URL）" : "关闭"}\n` +
        `  隧道状态  : ${s.running ? `运行中 ${s.url}` : "未运行"}\n` +
        (s.running
          ? ""
          : "  1. 立即启动公网隧道（本次临时，自动分配 *.trycloudflare.com）\n") +
        (s.running ? "  2. 停止隧道\n" : "") +
        `  3. 显示 OAuth / MCP 接入地址\n` +
        `  4. ${auto ? "关闭" : "开启"}「默认随 daemon 自动开隧道」（改完需重启 daemon）\n` +
        "  0. 返回\n",
    );
    const c = (await p.ask("选择: ")).trim();
    if (c === "0" || c === "") return;

    if (c === "1" && !s.running) {
      process.stdout.write("启动隧道中（等待 Cloudflare 分配域名，约 5~20 秒）...\n");
      const r = await adminRequest(cfg, "POST", "/admin/tunnel/start");
      if (r.status !== 200) {
        process.stdout.write(`✗ ${JSON.stringify(r.json)}\n`);
        continue;
      }
      const b = r.json.url as string;
      process.stdout.write(
        `\n✓ 公网地址: ${b}\n` +
          `  MCP 端点      : ${b}/mcp\n` +
          `  OAuth 元数据  : ${b}/.well-known/oauth-authorization-server\n` +
          `  授权页(填 key): ${b}/authorize\n\n` +
          `在线客户端（OpenAI / ChatGPT 等）添加远程 MCP 时填 ${b}/mcp，\n` +
          `授权页里粘贴本机 key 即可（key: ${cfg.token}）\n\n` +
          `免登录、随 daemon 退出自动关闭。\n`,
      );
      continue;
    }

    if (c === "2" && s.running) {
      const r = await adminRequest(cfg, "POST", "/admin/tunnel/stop");
      process.stdout.write(r.json?.stopped ? "✓ 隧道已停止\n" : "隧道不在运行\n");
      continue;
    }

    if (c === "3") {
      const url = s.url || "(隧道未启动，先选 1 启动)";
      process.stdout.write(
        `\nMCP 端点      : ${url}/mcp\n` +
          `OAuth 元数据  : ${url}/.well-known/oauth-authorization-server\n` +
          `资源元数据    : ${url}/.well-known/oauth-protected-resource\n` +
          `授权页        : ${url}/authorize\n` +
          `token 端点    : ${url}/token\n` +
          `注册端点      : ${url}/register\n` +
          `本机 key      : ${cfg.token}\n`,
      );
      continue;
    }

    if (c === "4") {
      const r = await adminRequest(cfg, "POST", "/admin/tunnel/autostart", { on: !auto });
      if (r.status !== 200) {
        process.stdout.write(`✗ ${JSON.stringify(r.json)}\n`);
        continue;
      }
      process.stdout.write(
        `✓ 已${r.json.autoStart ? "开启" : "关闭"}「默认随 daemon 自动开隧道」。\n` +
          `  ${r.json.autoStart ? "请重启 daemon 生效——之后每次启动都会开一个全新的隧道（URL 每次都变）" : "重启 daemon 后生效（之后启动不再自动开）"}。\n`,
      );
      continue;
    }

    process.stdout.write("无效选项\n");
  }
}

export async function runMenu(): Promise<void> {
  const p = new Prompter();
  let running = true;
  while (running) {
    process.stdout.write(
      "\n============================================================\n" +
        "   sshmcp 管理控制台\n" +
        "============================================================\n" +
        "   1. 添加主机（密钥认证）\n" +
        "   2. 添加主机（密码认证）\n" +
        "   3. 删除主机\n" +
        "   4. 列出主机\n" +
        "   5. 测试连接\n" +
        "   6. 查看会话\n" +
        "   7. 显示配置（MCP url / token）\n" +
        "   8. 凭据库自检\n" +
        "   9. 服务安装指引\n" +
        "  10. 连接 CF（免登录公网隧道）\n" +
        "   0. 退出\n" +
        "============================================================\n",
    );
    const choice = (await p.ask("请输入序号后回车: ")).trim();
    switch (choice) {
      case "1":
        await opAddKey(p);
        break;
      case "2":
        await opAddPass(p);
        break;
      case "3":
        await opRemove(p);
        break;
      case "4":
        opList();
        break;
      case "5":
        await opTest(p);
        break;
      case "6":
        await opSessions();
        break;
      case "7":
        opConfig();
        break;
      case "8":
        process.stdout.write(`vault selfTest: ${selfTest() ? "OK" : "FAIL"}\n`);
        break;
      case "9": {
        const { serviceInstallGuide } = await import("../service.js");
        serviceInstallGuide();
        break;
      }
      case "10":
        await opCf(p);
        break;
      case "0":
      case "":
        running = false;
        break;
      default:
        process.stdout.write("无效序号\n");
    }
  }
  p.close();
  process.stdout.write("再见。\n");
}
