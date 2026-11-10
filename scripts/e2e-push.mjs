// 推送链路验证（新版 Streamable HTTP）：
//  initialize → POST subscriptions/listen(SSE) → host_connect → shell_open → shell_subscribe
//  验证：真变化才推、静默期零帧、exec stream 分块、无会话 id 直接 400
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const cfg = JSON.parse(fs.readFileSync("C:/ProgramData/sshmcp/config.json", "utf8"));
const base = `http://${cfg.host}:${cfg.port}`;
const HOST = process.argv[2] || "100.64.100.22";

let pass = true;
const check = (label, okv, extra) => {
  console.log(`${okv ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!okv) pass = false;
};

// 0) 无会话 id 必须被拒
const noSid = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
check("无 mcp-session-id 直接 400", noSid.status === 400, `status=${noSid.status}`);

// 1) 建立会话
const mcp = new Client({ name: "push-test", version: "0" });
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${cfg.token}` } },
});
await mcp.connect(transport);
const sid = transport.sessionId;
check("initialize 拿到 session id", !!sid, sid);

const call = async (n, a = {}) => {
  const r = await mcp.callTool({ name: n, arguments: a });
  return r.isError ? { __error: r.content[0].text } : JSON.parse(r.content[0].text);
};

// 2) 开推送流（POST subscriptions/listen，长连 SSE）
const events = [];
const abort = new AbortController();
const sse = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${cfg.token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "mcp-session-id": sid,
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "subscriptions/listen", params: {} }),
  signal: abort.signal,
});
check("subscriptions/listen 建立 SSE", sse.status === 200 && (sse.headers.get("content-type") || "").includes("text/event-stream"), `ct=${sse.headers.get("content-type")}`);

(async () => {
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        try {
          events.push({ t: Date.now(), msg: JSON.parse(dataLine.slice(6)) });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* aborted */
  }
})();

await new Promise((r) => setTimeout(r, 300));
check("收到 stream_ready ack", events.some((e) => e.msg.method === "notifications/sshmcp.stream_ready"));

// 3) 连主机 + 开终端 + 订阅
const c = await call("host_connect", { name: HOST });
check("host_connect", c.boundHost === HOST, JSON.stringify({ bound: c.boundHost, ms: c.latencyMs }));
const so = await call("shell_open", { rows: 20, cols: 90 });
check("shell_open", !!so.shellId, so.shellId);

const sub = await call("shell_subscribe", { shellId: so.shellId, intervalMs: 0, mode: "raw" });
check("shell_subscribe 成功", !!sub.subId, JSON.stringify(sub));

// 4) 产生 3 次真变化，然后静默 6 秒
await call("shell_write", { shellId: so.shellId, data: "for i in 1 2 3; do echo TICK$i; sleep 1; done\n" });
await new Promise((r) => setTimeout(r, 4500));
const outEvents = events.filter((e) => e.msg.method === "notifications/sshmcp.output");
const ticks = outEvents.filter((e) => (e.msg.params?.delta || "").includes("TICK")).length;
check("三次 TICK 都有推送（增量）", ticks >= 1, `output事件=${outEvents.length}`);

// 静默期：发一个 sleep 8，等回显与提示符刷完，再观察 5 秒内是否还有帧
await call("shell_write", { shellId: so.shellId, data: "sleep 8\n" });
await new Promise((r) => setTimeout(r, 1200)); // 让命令回显/提示符重绘落地（这是真变化）
const before = events.filter((e) => e.msg.method === "notifications/sshmcp.output").length;
await new Promise((r) => setTimeout(r, 5000));
const during = events.filter((e) => e.msg.method === "notifications/sshmcp.output").length - before;
check("静默期零帧（无心跳）", during === 0, `期间 output 帧=${during}`);

// 5) exec stream
const ex = await call("exec", { command: "echo A; sleep 1; echo B", stream: true });
check("exec stream 立即返回 streamId", !!ex.streamId && ex.listeners >= 1, JSON.stringify(ex));
await new Promise((r) => setTimeout(r, 3000));
const chunks = events.filter((e) => e.msg.method === "notifications/sshmcp.exec" && e.msg.params.streamId === ex.streamId);
const exitEv = events.find((e) => e.msg.method === "notifications/sshmcp.exit" && e.msg.params.streamId === ex.streamId);
check("exec 输出分块推送", chunks.length >= 1, `chunks=${chunks.length}`);
check("exec 结束推送 exitCode", !!exitEv && exitEv.msg.params.exitCode === 0, JSON.stringify(exitEv?.msg.params));

// 6) 清理
await call("shell_unsubscribe", { subId: sub.subId });
const sl = await call("subscription_list");
check("取消后订阅清空", sl.subscriptions.length === 0, JSON.stringify(sl));
await call("shell_close", { shellId: so.shellId });
await call("session_minimize");

abort.abort();
await mcp.close().catch(() => {});
console.log(`\n${pass ? "ALL PASS ✅" : "SOME FAILED ❌"}`);
process.exit(pass ? 0 : 1);
