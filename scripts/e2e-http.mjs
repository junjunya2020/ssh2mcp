// 端到端验证 HTTP MCP：起本地 ssh2 server + 起 sshmcp daemon，
// 用 MCP StreamableHTTP 客户端连 /mcp，列出 8 个工具并实际调用 exec / shell_open / shell_write / shell_read。
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import ssh2 from "ssh2";

const { Server } = ssh2;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sshmcp-http-"));
process.env.SSHMCP_DATA_DIR = dataDir;

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// --- 一次性 ssh server ---
const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on("authentication", (ctx) => {
    if (ctx.method === "password" && ctx.password === "testpw") ctx.accept();
    else ctx.reject(["password"]);
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (a) => a && a());
      session.on("exec", (accept, _r, info) => {
        const s = accept();
        s.write(`OK:${info.command.split(" ").slice(-1)[0]}\n`);
        s.exit(0);
        s.end();
      });
      session.on("shell", (accept) => {
        const s = accept();
        s.write("\x1b[32m$\x1b[0m ");
        let buf = "";
        s.on("data", (d) => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            s.write(`ECHO:${line}\n\x1b[32m$\x1b[0m `);
          }
        });
      });
    });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const sshPort = server.address().port;

// --- 配置 host ---
const { getConfig } = await import("../dist/config.js");
const { addHost } = await import("../dist/store/hosts.js");
const { setSecret } = await import("../dist/store/vault.js");
const cfg = getConfig(true);
cfg.port = 19200 + Math.floor(Math.random() * 500); // 随机端口，避免撞已运行的 daemon
addHost({ name: "local", host: "127.0.0.1", port: sshPort, user: "tester", authType: "password" });
setSecret("local", { password: "testpw" });

// --- 起 daemon（进程内）---
const { Audit } = await import("../dist/security/audit.js");
const { ConnectionPool } = await import("../dist/ssh/pool.js");
const { createApp } = await import("../dist/http/app.js");
const pool = new ConnectionPool(cfg, new Audit(cfg));
const app = createApp(cfg, pool);
const httpServer = http.createServer(app);
await new Promise((r) => httpServer.listen(cfg.port, cfg.host, r));
console.log(`[daemon] http://${cfg.host}:${cfg.port}`);

// --- MCP 客户端 ---
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

const mcp = new Client({ name: "e2e-http", version: "0.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(`http://${cfg.host}:${cfg.port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${cfg.token}` } },
});
await mcp.connect(transport);
console.log("✓ MCP 握手成功");

let pass = true;
const check = (l, c, x) => {
  console.log(`${c ? "✓" : "✗"} ${l}${x ? "  " + x : ""}`);
  if (!c) pass = false;
};

const tools = await mcp.listTools();
const names = tools.tools.map((t) => t.name).sort();
console.log("工具:", names.join(", "));
const expected = ["exec", "host_connect", "host_disconnect", "host_list", "session_close", "session_list", "session_minimize", "shell_close", "shell_open", "shell_read", "shell_subscribe", "shell_unsubscribe", "shell_write", "subscription_list"];
check("暴露 14 个工具且名称正确", expected.every((n) => names.includes(n)) && names.length === 14);

async function call(name, args) {
  const r = await mcp.callTool({ name, arguments: args });
  return r;
}

// host_connect（同时绑定到当前 MCP 会话）
const c1 = await call("host_connect", { name: "local" });
const c1o = JSON.parse(c1.content[0].text);
check("host_connect 建立连接并绑定", c1o.connected === true && c1o.boundHost === "local");

// exec —— 关键：不传 name，应打当前绑定主机
const e1 = await call("exec", { command: "hello" });
const eo = JSON.parse(e1.content[0].text);
check("exec 省略 name 打当前绑定主机", eo.exitCode === 0 && eo.stdout.includes("hello") && eo.host === "local", JSON.stringify(eo));

// shell_open —— 同样省略 name
const so = await call("shell_open", { rows: 10, cols: 40 });
const soObj = JSON.parse(so.content[0].text);
check("shell_open 省略 name 成功", !!soObj.shellId && soObj.host === "local", JSON.stringify(soObj.screen));

// shell_write
const sw = await call("shell_write", { shellId: soObj.shellId, data: "hi there\n" });
check("shell_write accepted", JSON.parse(sw.content[0].text).accepted === true);

// shell_read raw
await new Promise((r) => setTimeout(r, 250));
const sr = await call("shell_read", { shellId: soObj.shellId, mode: "raw", since: soObj.cursor });
const srObj = JSON.parse(sr.content[0].text);
check("shell_read raw 含 ECHO", srObj.data.includes("ECHO:hi there"), JSON.stringify(srObj.data));

// shell_read screen
const sr2 = await call("shell_read", { shellId: soObj.shellId, mode: "screen" });
const sr2Obj = JSON.parse(sr2.content[0].text);
check("shell_read screen 渲染干净", sr2Obj.data.includes("ECHO:hi there"), JSON.stringify(sr2Obj.data));

// session_list —— 应反映当前绑定
const sl = await call("session_list", {});
const slObj = JSON.parse(sl.content[0].text);
check("session_list 显示 boundHost", slObj.boundHost === "local" && slObj.hosts.length === 1 && slObj.shells.length === 1, JSON.stringify({ b: slObj.boundHost, s: slObj.shells.length }));

// shell_close
const sc = await call("shell_close", { shellId: soObj.shellId });
check("shell_close", JSON.parse(sc.content[0].text).closed === true);

// session_minimize —— 只解绑，连接保留
const sm = await call("session_minimize", {});
const smo = JSON.parse(sm.content[0].text);
check("session_minimize 解绑且连接保留", smo.minimized === true && smo.releasedHost === "local" && smo.boundHost === null);

// 解绑后 exec 不传 name 应明确报错（绝不瞎猜主机）
const e2 = await call("exec", { command: "hello" });
check("解绑后 exec 省略 name 报错", e2.isError === true && e2.content[0].text.includes("host_connect"));

// 重新绑定 → session_close 显式停止（断开 + 解绑）
const c2 = await call("host_connect", { name: "local" });
check("重新 host_connect 恢复绑定", JSON.parse(c2.content[0].text).boundHost === "local");
const scl = await call("session_close", {});
const sclo = JSON.parse(scl.content[0].text);
check("session_close 断开并解绑", sclo.closed === true);
const e3 = await call("exec", { command: "hello" });
check("session_close 后 exec 报错", e3.isError === true);

// 显式传 name 仍可用（多主机场景不受绑定影响）
const c3 = await call("host_connect", { name: "local" });
const e4 = await call("exec", { name: "local", command: "explicit" });
const e4o = JSON.parse(e4.content[0].text);
check("显式 name 仍可用", e4o.exitCode === 0 && e4o.host === "local");

// host_disconnect
const hd = await call("host_disconnect", {});
check("host_disconnect 省略 name 断开当前绑定", JSON.parse(hd.content[0].text).disconnected === true);

// 鉴权：无 token 应 401
const t2 = new StreamableHTTPClientTransport(new URL(`http://${cfg.host}:${cfg.port}/mcp`), {
  requestInit: { headers: { Authorization: "Bearer wrong" } },
});
const mcp2 = new Client({ name: "bad", version: "0" });
let authFailed = false;
try {
  await mcp2.connect(t2);
  await mcp2.listTools();
} catch {
  authFailed = true;
}
check("错误 token 被拒绝", authFailed);

await mcp.close();
pool.closeAll();
server.close();
httpServer.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass ? "ALL PASS ✅" : "SOME FAILED ❌"}`);
process.exit(pass ? 0 : 1);
