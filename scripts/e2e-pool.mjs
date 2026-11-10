// 集成自测：验证 sshmcp 自己的 ConnectionPool + ShellChannel(@xterm 虚拟屏) + session_list。
// 起本地一次性 ssh2 server，不碰任何真实主机。
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import ssh2 from "ssh2";

const { Server } = ssh2;

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sshmcp-e2e-"));
process.env.SSHMCP_DATA_DIR = dataDir;

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

// 模拟一个会渲染 ANSI（颜色+光标）的 shell，验证 xterm 虚拟屏能正确渲染
const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on("authentication", (ctx) => {
    if (ctx.method === "password" && ctx.password === "testpw") ctx.accept();
    else ctx.reject(["password"]);
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (a) => a && a());
      session.on("exec", (accept, _rej, info) => {
        const stream = accept();
        const code = info.command.includes("exit7") ? 7 : 0;
        stream.write(`EXEC-OUT\n`);
        stream.exit(code);
        stream.end();
      });
      session.on("shell", (accept) => {
        const stream = accept();
        // 带颜色的提示符
        stream.write("\x1b[32muser@host\x1b[0m:$ ");
        let buf = "";
        stream.on("data", (d) => {
          buf += d.toString("utf-8");
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            // 回显带颜色输出，模拟真实程序
            stream.write(`\x1b[36mRESULT\x1b[0m ${line}\n\x1b[32muser@host\x1b[0m:$ `);
          }
        });
      });
    });
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const { getConfig } = await import("../dist/config.js");
const { addHost } = await import("../dist/store/hosts.js");
const { setSecret } = await import("../dist/store/vault.js");
const { Audit } = await import("../dist/security/audit.js");
const { ConnectionPool } = await import("../dist/ssh/pool.js");

const cfg = getConfig(true);
addHost({ name: "local", host: "127.0.0.1", port, user: "tester", authType: "password" });
setSecret("local", { password: "testpw" });

const pool = new ConnectionPool(cfg, new Audit(cfg));

let pass = true;
function check(label, cond, extra) {
  console.log(`${cond ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!cond) pass = false;
}

// 1. connect
const c = await pool.connect("local");
check("host_connect", c.connected === true, JSON.stringify(c));

// 2. exec 成功退出码
const e0 = await pool.exec("local", { command: "echo hi" });
check("exec exitCode=0", e0.exitCode === 0 && e0.stdout.includes("EXEC-OUT"), JSON.stringify(e0));

// 3. exec 非零退出码
const e7 = await pool.exec("local", { command: "run exit7" });
check("exec exitCode=7", e7.exitCode === 7, `code=${e7.exitCode}`);

// 4. shell 虚拟屏（应渲染 ANI 后为干净文本 "user@host:$ "）
const shell = await pool.openShell("local", { rows: 12, cols: 50 });
const r1 = await shell.read({ mode: "screen" });
check("shell screen 渲染", r1.data.includes("user@host:$"), JSON.stringify(r1.data));
check("shell screen 无 ANSI 垃圾", !r1.data.includes("\x1b"), "");

// 5. shell 写入 + raw 增量游标
const cursor0 = r1.cursor;
shell.write("hello\n");
await new Promise((r) => setTimeout(r, 250));
const r2 = await shell.read({ mode: "raw", since: cursor0 });
check("shell raw 增量含回显", r2.data.includes("RESULT") && r2.data.includes("hello"), JSON.stringify(r2.data));
check("shell raw 游标前进", r2.cursor > cursor0, `${cursor0} -> ${r2.cursor}`);

// 6. shell screen 更新后也能读到回显
const r3 = await shell.read({ mode: "screen" });
check("shell screen 更新", r3.data.includes("RESULT") && r3.data.includes("hello"), JSON.stringify(r3.data));

// 7. session_list
const list = pool.list();
check("session_list hosts=1", list.hosts.length === 1 && list.hosts[0].name === "local");
check("session_list shells=1", list.shells.length === 1 && list.shells[0].active === true);

// 8. shell_close
check("shell_close", pool.closeShell(shell.shellId) === true);
check("session_list shells=0", pool.list().shells.length === 0);

// 9. disconnect
const d = await pool.disconnect("local");
check("host_disconnect", d.closedChannels === 0);

// 10. 安全守卫
let guarded = false;
try {
  await pool.exec("local", { command: "rm -rf /" });
} catch (err) {
  guarded = /安全守卫/.test(err.message);
}
check("危险命令被拦截", guarded);

pool.closeAll();
server.close();
console.log(`\n${pass ? "ALL PASS ✅" : "SOME FAILED ❌"}`);
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
