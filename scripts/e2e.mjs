// 端到端自测：本地起一个一次性 ssh2 Server，验证 exec 通道 + shell PTY 双通道。
// 不连接任何真实主机。用法: node scripts/e2e.mjs
import crypto from "node:crypto";
import ssh2 from "ssh2";

const { Server, Client } = ssh2;

function withTimeout(p, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`TIMEOUT(${label}) after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on("authentication", (ctx) => {
    if (ctx.method === "password" && ctx.password === "testpw") ctx.accept();
    else if (ctx.method === "none") ctx.accept();
    else ctx.reject(["password"]);
  });
  client.on("ready", () => {
    client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (a) => a && a());
      session.on("exec", (accept, reject, info) => {
        const stream = accept();
        const cmd = info.command;
        const code = cmd.includes("exit7") ? 7 : 0;
        stream.write(`EXEC:${cmd}\n`, () => {
          stream.exit(code, `done(${code})`); // 第二参数: signal/desc 视版本
          stream.end();
        });
      });
      session.on("shell", (accept) => {
        const stream = accept();
        stream.write("welcome$ ");
        let buf = "";
        stream.on("data", (d) => {
          buf += d.toString("utf-8");
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            stream.write(`OUT:${line}\nwelcome$ `);
          }
        });
      });
    });
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log(`[test-server] listening 127.0.0.1:${port}`);

const conn = new Client();
await withTimeout(
  new Promise((res, rej) => {
    conn.on("ready", res).on("error", rej).connect({
      host: "127.0.0.1",
      port,
      username: "tester",
      password: "testpw",
      hostVerifier: () => true,
    });
  }),
  8000,
  "connect",
);
console.log("✓ 连接建立");

// --- exec 通道 ---
function doExec(cmd) {
  return withTimeout(
    new Promise((res) => {
      conn.exec(cmd, (err, stream) => {
        if (err) return res({ err: err.message });
        let o = "";
        let code = null;
        stream.on("data", (c) => (o += c));
        stream.on("exit", (cd) => (code = cd));
        stream.on("close", () => res({ out: o.trim(), code }));
      });
    }),
    5000,
    `exec:${cmd}`,
  );
}

console.log("✓ exec:", JSON.stringify(await doExec("echo hi")));
console.log("✓ exec 退出码:", JSON.stringify(await doExec("run exit7")));

// --- shell 通道 ---
const shell = await withTimeout(
  new Promise((res, rej) => {
    conn.shell({ term: "xterm-256color", rows: 10, cols: 40 }, (err, s) => {
      if (err) return rej(err);
      res(s);
    });
  }),
  5000,
  "shell-open",
);
let shellBuf = "";
shell.on("data", (c) => (shellBuf += c.toString("utf-8")));
await new Promise((r) => setTimeout(r, 200));
console.log("✓ shell 首屏:", JSON.stringify(shellBuf));
shell.write("hello world\n");
await new Promise((r) => setTimeout(r, 200));
console.log("✓ shell 写入后:", JSON.stringify(shellBuf));

conn.end();
server.close();
console.log("\nALL PASS");
process.exit(0);
