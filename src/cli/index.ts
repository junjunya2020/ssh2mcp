import readline from "node:readline";
import { getConfig } from "../config.js";
import { addHost, removeHost, loadHosts } from "../store/hosts.js";
import { setSecret, removeSecret } from "../store/vault.js";
import { adminRequest, daemonAlive } from "../http/client.js";
import { selfTest } from "../store/vault.js";

/** 隐藏输入读取密码（TTY）；非 TTY 时读一行 */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin });
      rl.once("line", (line) => {
        rl.close();
        resolve(line);
      });
      return;
    }
    process.stdout.write(prompt);
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
          resolve(buf);
          return;
        }
        if (c === "\u0003") {
          // Ctrl-C
          stdin.setRawMode?.(false);
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") {
          buf = buf.slice(0, -1);
        } else {
          buf += c;
        }
      }
    };
    stdin.on("data", onData);
  });
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

export async function runCli(argv: string[]): Promise<void> {
  const [group, action, ...rest] = argv;
  const cfg = getConfig();

  if (!group || group === "help" || group === "--help") {
    printHelp();
    return;
  }

  if (group === "version" || group === "--version") {
    process.stdout.write("sshmcp 0.1.0\n");
    return;
  }

  if (group === "vault-selftest") {
    process.stdout.write(`vault selfTest: ${selfTest() ? "OK" : "FAIL"}\n`);
    return;
  }

  // cf / tunnel 子命令：隧道跑在 daemon 里（daemon 退出即一起退）
  if (group === "cf" || group === "tunnel") {
    const act = action || "status";
    if (!(await daemonAlive(cfg))) {
      process.stdout.write("✗ daemon 未运行。隧道必须挂在 daemon 上：先 start-daemon.bat，再执行本命令\n");
      return;
    }
    if (act === "start") {
      process.stdout.write("启动 Cloudflare 免登录临时隧道...\n");
      const r = await adminRequest(cfg, "POST", "/admin/tunnel/start");
      if (r.status !== 200) {
        process.stdout.write(`✗ ${JSON.stringify(r.json)}\n`);
        return;
      }
      const base = r.json.url as string;
      process.stdout.write(`\n✓ 公网地址: ${base}\n`);
      process.stdout.write(`  MCP 端点 : ${base}/mcp\n`);
      process.stdout.write(`  OAuth 元数据: ${base}/.well-known/oauth-authorization-server\n`);
      process.stdout.write(`  授权页(key) : ${base}/authorize\n`);
      process.stdout.write(`\n  在线客户端(OpenAI/ChatGPT 等)添加 MCP 时填上面 /mcp，OAuth 授权页粘 key 即可。\n`);
      process.stdout.write(`  隧道随 daemon 退出自动关闭。\n\n`);
      return;
    }
    if (act === "stop") {
      const r = await adminRequest(cfg, "POST", "/admin/tunnel/stop");
      process.stdout.write(r.json?.stopped ? "✓ 隧道已停止\n" : "隧道本来就没在跑\n");
      return;
    }
    if (act === "auto" || act === "autostart") {
      const on = (rest[0] || "").toLowerCase();
      if (on !== "on" && on !== "off") {
        process.stdout.write("用法: sshmcp cf auto on|off   （daemon 启动时是否自动开隧道）\n");
        return;
      }
      const r = await adminRequest(cfg, "POST", "/admin/tunnel/autostart", { on: on === "on" });
      process.stdout.write(
        `✓ 自动开隧道已${r.json?.autoStart ? "开启" : "关闭"}（重启 daemon 生效；开启后每次启动都换新 URL）\n`,
      );
      return;
    }
    if (act === "mode") {
      const m = (rest[0] || "").toLowerCase();
      if (m === "named") {
        const url = rest[1];
        if (!url || !/^https:\/\//.test(url)) {
          process.stdout.write("用法: sshmcp cf mode named https://mcp.example.com\n");
          return;
        }
        const r = await adminRequest(cfg, "POST", "/admin/tunnel/mode", { mode: "named", customUrl: url });
        process.stdout.write(`✓ 已设为自定义域名 ${r.json?.customUrl}（重启 daemon 生效）\n`);
        return;
      }
      if (m === "quick") {
        await adminRequest(cfg, "POST", "/admin/tunnel/mode", { mode: "quick" });
        process.stdout.write("✓ 已切回免登录临时域名（重启 daemon 生效）\n");
        return;
      }
      process.stdout.write("用法: sshmcp cf mode quick | sshmcp cf mode named https://你的域名\n");
      return;
    }
    // status
    const r = await adminRequest(cfg, "GET", "/admin/tunnel");
    const st = r.json ?? {};
    process.stdout.write(`cloudflared : ${st.binary || "(未找到)"}\n`);
    process.stdout.write(`自动随daemon: ${st.autoStart ? "开启（每次换新 URL）" : "关闭"}\n`);
    process.stdout.write(`隧道状态    : ${st.running ? "运行中" : "未运行"}（免登录）\n`);
    if (st.url) process.stdout.write(`公网地址    : ${st.url}\n  MCP: ${st.url}/mcp\n`);
    return;
  }

  // host 子命令
  if (group === "host") {
    if (action === "add") {
      const f = parseFlags(rest);
      const name = String(f.name || "").trim(); // 可省略，默认用 host
      const authType = (f.auth as string) === "password" ? "password" : "key";
      if (!f.host || !f.user) {
        throw new Error("用法: sshmcp host add --host IP --user U --auth key|password [--name X] [--key PATH] [--port 22]");
      }
      const displayName = name || String(f.host);
      let password: string | undefined;
      let passphrase: string | undefined;
      if (authType === "password") {
        password = await readSecret(`输入 ${displayName} 的登录密码: `);
      } else if (f["passphrase-prompt"]) {
        passphrase = await readSecret(`输入 ${displayName} 私钥口令(留空跳过): `);
      }
      const entry = addHost({
        name: name || undefined,
        host: String(f.host),
        port: f.port ? Number(f.port) : 22,
        user: String(f.user),
        authType,
        keyPath: f.key ? String(f.key) : undefined,
        certPath: f.cert ? String(f.cert) : undefined,
        proxyJump: f["proxy-jump"] ? String(f["proxy-jump"]) : undefined,
        defaultDir: f.dir ? String(f.dir) : undefined,
        description: f.desc ? String(f.desc) : undefined,
      });
      if (password || passphrase) setSecret(entry.name, { password, passphrase });
      process.stdout.write(`✓ 已添加 host '${entry.name}' (${entry.user}@${entry.host}:${entry.port}, ${entry.authType})\n`);
      return;
    }
    if (action === "remove") {
      const f = parseFlags(rest);
      const name = String(f.name || "");
      if (!name) throw new Error("用法: sshmcp host remove --name X");
      const removed = removeHost(name);
      removeSecret(name);
      if (await daemonAlive(cfg)) {
        await adminRequest(cfg, "DELETE", `/admin/hosts/${encodeURIComponent(name)}`).catch(() => {});
      }
      process.stdout.write(removed ? `✓ 已删除 host '${name}'\n` : `host '${name}' 不存在\n`);
      return;
    }
    if (action === "list") {
      const hosts = loadHosts();
      const asJson = rest.includes("--json");
      if (asJson) {
        process.stdout.write(JSON.stringify({ hosts }, null, 2) + "\n");
      } else if (hosts.length === 0) {
        process.stdout.write("(没有已登记的 host)\n");
      } else {
        for (const h of hosts) {
          process.stdout.write(
            `${h.name.padEnd(16)} ${h.user}@${h.host}:${h.port}  auth=${h.authType}${h.keyPath ? " key=" + h.keyPath : ""}\n`,
          );
        }
      }
      return;
    }
    if (action === "test") {
      const f = parseFlags(rest);
      const name = String(f.name || "");
      if (!name) throw new Error("用法: sshmcp host test --name X");
      if (!(await daemonAlive(cfg))) {
        process.stdout.write("✗ daemon 未运行，请先 `sshmcp service start` 或 `sshmcp daemon`\n");
        process.exitCode = 1;
        return;
      }
      const r = await adminRequest(cfg, "POST", `/admin/hosts/${encodeURIComponent(name)}/test`);
      process.stdout.write(JSON.stringify(r.json, null, 2) + "\n");
      return;
    }
    printHelp();
    return;
  }

  if (group === "session" && action === "list") {
    if (!(await daemonAlive(cfg))) {
      process.stdout.write("daemon 未运行。\n");
      process.exitCode = 1;
      return;
    }
    const r = await adminRequest(cfg, "GET", "/admin/sessions");
    process.stdout.write(JSON.stringify(r.json, null, 2) + "\n");
    return;
  }

  if (group === "config") {
    process.stdout.write(JSON.stringify({ host: cfg.host, port: cfg.port, dataDir: cfg.dataDir, token: cfg.token }, null, 2) + "\n");
    return;
  }

  printHelp();
}

function printHelp() {
  process.stdout.write(
    `sshmcp 0.1.0 — 有状态 SSH MCP（双通道）

用法:
  sshmcp daemon [--port 8765] [--foreground]   启动 daemon（HTTP: /mcp + /admin）
  sshmcp host add --name X --host IP --user U --auth key|password [--key PATH] [--port 22]
                                     [--passphrase-prompt] [--proxy-jump NAME] [--desc D]
  sshmcp host remove --name X
  sshmcp host list [--json]
  sshmcp host test --name X
  sshmcp session list
  sshmcp config                                  打印 url/token/dataDir
  sshmcp service install|uninstall|start|stop|status
  sshmcp vault-selftest                          凭据库加解密自检
  sshmcp version
`,
  );
}
