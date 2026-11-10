import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionPool } from "../ssh/pool.js";
import type { GlobalBinding, SessionCtx } from "./session.js";
import { suppressHost, unsuppressHost } from "./session.js";
import type { PushHub } from "../push.js";
import type { SubscriptionManager } from "../subscriptions.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: `错误: ${message}` }] };
}

const NO_BINDING =
  "当前 MCP 会话还没有绑定主机。先调用 host_connect({name:'<别名>'})，或在本次调用里显式传 name。可用别名见 host_list。";

/**
 * 解析本次调用要打哪台主机：显式 name > 本会话绑定 > 全局兜底（上次 host_connect）。
 * 三级都空则报错，绝不瞎猜。
 */
function pickHost(ctx: SessionCtx, gb: GlobalBinding, name?: string): string {
  if (name) return name;
  if (ctx.boundHost) return ctx.boundHost;
  if (gb.lastHost) return gb.lastHost;
  throw new Error(NO_BINDING);
}

/**
 * 注册 11 个工具。host 一律用别名寻址，参数中永不含密码/密钥。
 *
 * 有状态语义：
 *  - host_connect 之后，exec / shell_open / host_disconnect 都可省略 name，默认打当前绑定主机；
 *  - 连接在 daemon 内长驻，直到 session_close / host_disconnect / MCP 会话销毁；
 *  - session_close = 显式停止（断开该主机连接并解绑）；
 *  - session_minimize = 最小化（只解绑，连接保留在 daemon 里）。
 */
export function registerTools(
  server: McpServer,
  pool: ConnectionPool,
  ctx: SessionCtx,
  gb: GlobalBinding,
  hub?: PushHub,
  subs?: SubscriptionManager,
): void {
  /** 推送按 mcp-session-id 隔离；严格模式下一定有值 */
  const sessionKey = () => ctx.sessionId ?? "legacy";

  // 1. host_connect —— 连接 + 绑定当前会话
  server.registerTool(
    "host_connect",
    {
      title: "连接主机（并绑定到当前会话）",
      description:
        "按已登记别名建立（或复用）SSH 长连接，并把它设为当前 MCP 会话的默认主机。之后 exec / shell_open / host_disconnect 可省略 name。再次调用并传别的别名即为切换主机。",
      inputSchema: {
        name: z.string().describe("已用 CLI 登记的 host 别名（host_list 可查）"),
      },
    },
    async ({ name }) => {
      try {
        const prev = ctx.boundHost;
        const info = await pool.connect(name);
        ctx.boundHost = name;
        gb.lastHost = name;
        unsuppressHost(gb, name);

        // 切换主机：旧主机若已无活跃 shell 则断开释放，仍有 shell 则只解绑不误杀
        let previous: { name: string; disconnected: boolean; shellsKept: number } | undefined;
        if (prev && prev !== name) {
          const shells = pool.shellCount(prev);
          if (shells > 0) {
            previous = { name: prev, disconnected: false, shellsKept: shells };
          } else {
            await pool.disconnect(prev).catch(() => {});
            previous = { name: prev, disconnected: true, shellsKept: 0 };
          }
        }
        return ok({ ...info, bound: true, boundHost: name, switchedFrom: previous });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 2. host_disconnect —— 断开（默认当前绑定）
  server.registerTool(
    "host_disconnect",
    {
      title: "断开主机",
      description:
        "关闭到指定别名（省略=当前绑定主机）的所有连接及其上所有 shell 会话，同时解除绑定。",
      inputSchema: {
        name: z.string().optional().describe("host 别名；省略则用当前绑定主机"),
      },
    },
    async ({ name }) => {
      try {
        const host = pickHost(ctx, gb, name);
        const r = await pool.disconnect(host);
        if (ctx.boundHost === host) ctx.boundHost = undefined;
        if (gb.lastHost === host) gb.lastHost = undefined;
        suppressHost(gb, host);
        return ok({ name: host, disconnected: true, bound: false, ...r });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 3. exec —— 单次命令，默认打当前绑定主机；stream=true 则提交即返回、输出走推送流
  server.registerTool(
    "exec",
    {
      title: "执行命令（单次）",
      description:
        "在目标主机上执行单次命令（独立 exec 通道）。默认同步返回 host/exitCode/stdout/stderr。stream=true 时立刻返回 streamId，stdout/stderr 分块经 subscriptions/listen 的推送流下发（notifications/sshmcp.exec），结束时推 notifications/sshmcp.exit。省略 name 时打当前绑定主机。与交互式 shell 的 cwd/env 互不共享。",
      inputSchema: {
        command: z.string().describe("要执行的命令"),
        name: z.string().optional().describe("host 别名；省略=当前绑定主机"),
        timeoutMs: z.number().int().positive().optional().describe("超时毫秒，默认 60000"),
        cwd: z.string().optional().describe("执行前切换的工作目录"),
        env: z.record(z.string(), z.string()).optional().describe("额外环境变量"),
        rawExec: z.boolean().optional().describe("true=原样执行（不经 bash -l -c 包装）"),
        stream: z
          .boolean()
          .optional()
          .describe("true=提交即返回 streamId，输出经推送流分块下发（需先 POST subscriptions/listen）"),
      },
    },
    async ({ command, name, timeoutMs, cwd, env, rawExec, stream }) => {
      try {
        const host = pickHost(ctx, gb, name);
        const key = sessionKey();

        if (stream) {
          if (!hub) throw new Error("推送中枢未初始化");
          const streamId = `ex_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const listeners = hub.listeners(key);
          void pool
            .exec(host, {
              command,
              timeoutMs,
              cwd,
              env,
              rawExec,
              onChunk: (s, text) =>
                hub.emit(key, "notifications/sshmcp.exec", {
                  streamId,
                  host,
                  stream: s,
                  chunk: text,
                  at: Date.now(),
                }),
            })
            .then((r) =>
              hub.emit(key, "notifications/sshmcp.exit", {
                streamId,
                host,
                exitCode: r.exitCode,
                durationMs: r.durationMs,
                truncated: r.truncated,
                totalBytes: r.totalBytes,
              }),
            )
            .catch((e: Error) =>
              hub.emit(key, "notifications/sshmcp.error", { streamId, host, error: e.message }),
            );
          return ok({
            host,
            streaming: true,
            streamId,
            listeners,
            hint: listeners === 0 ? "当前没有打开的 subscriptions/listen 流，输出无处可推" : undefined,
          });
        }

        const r = await pool.exec(host, { command, timeoutMs, cwd, env, rawExec });
        return ok({ host, ...r });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 4. shell_open —— 持久 PTY，默认打当前绑定主机
  server.registerTool(
    "shell_open",
    {
      title: "打开交互式终端",
      description:
        "在目标主机上开一个持久 PTY 虚拟终端，返回 shellId / host 与当前屏幕。省略 name 时打当前绑定主机。后续用 shell_write / shell_read 交互，环境（cwd/env/后台进程）在会话内保持。",
      inputSchema: {
        name: z.string().optional().describe("host 别名；省略=当前绑定主机"),
        rows: z.number().int().positive().optional().describe("行数，默认 30"),
        cols: z.number().int().positive().optional().describe("列数，默认 120"),
        term: z.string().optional().describe("终端类型，默认 xterm-256color"),
        env: z.record(z.string(), z.string()).optional(),
      },
    },
    async ({ name, rows, cols, term, env }) => {
      try {
        const host = pickHost(ctx, gb, name);
        const shell = await pool.openShell(host, { rows, cols, term, env });
        const read = await shell.read({ mode: "screen" });
        return ok({
          shellId: shell.shellId,
          host,
          rows: shell.rows,
          cols: shell.cols,
          screen: read.data,
          cursor: read.cursor,
        });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 5. shell_write
  server.registerTool(
    "shell_write",
    {
      title: "向终端写字符",
      description:
        "向交互式终端写入原始字符（不含隐式回车）。命令需自带 '\\n'；Ctrl+C 用 '\\x03'，Ctrl+D 用 '\\x04'，方向键用 '\\x1b[A' 等。",
      inputSchema: {
        shellId: z.string().describe("shell_open 返回的 shellId"),
        data: z.string().describe("要写入的原始字符"),
      },
    },
    async ({ shellId, data }) => {
      try {
        const r = pool.getShell(shellId).write(data);
        return ok({ shellId, ...r });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 6. shell_read
  server.registerTool(
    "shell_read",
    {
      title: "读终端内容",
      description:
        "读取交互式终端。mode=screen 返回渲染后的当前整屏（适合 top/vim）；mode=raw 返回自 since 游标以来的增量。默认非阻塞立即返回；waitMs>0 才有界等待；expect 为正则，等待其出现。",
      inputSchema: {
        shellId: z.string().describe("shellId"),
        mode: z.enum(["screen", "raw"]).optional().describe("默认 screen"),
        since: z.number().int().nonnegative().optional().describe("(raw 模式) 上次返回的 cursor，取其后增量"),
        waitMs: z.number().int().nonnegative().optional().describe("有界等待毫秒，默认 0=不等待"),
        expect: z.string().optional().describe("正则：等待其出现在输出中"),
      },
    },
    async ({ shellId, mode, since, waitMs, expect }) => {
      try {
        const r = await pool.getShell(shellId).read({ mode: mode ?? "screen", since, waitMs, expect });
        return ok(r);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 7. shell_close
  server.registerTool(
    "shell_close",
    {
      title: "关闭终端",
      description: "关闭指定交互式终端会话并回收资源（不影响同主机的其它会话）。",
      inputSchema: { shellId: z.string().describe("shellId") },
    },
    async ({ shellId }) => {
      try {
        const stopped = subs?.stopShell(shellId) ?? 0;
        const closed = pool.closeShell(shellId);
        return ok({ shellId, closed, subscriptionsStopped: stopped });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 8. session_list —— 带当前绑定
  server.registerTool(
    "session_list",
    {
      title: "列出会话",
      description: "列出当前所有已连接主机、活动的终端会话，以及本 MCP 会话绑定的主机。",
      inputSchema: {},
    },
    async () => {
      try {
        return ok({
          boundHost: ctx.boundHost ?? null,
          fallbackHost: gb.lastHost ?? null,
          sessionId: ctx.sessionId ?? null,
          ...pool.list(),
        });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 9. host_list
  server.registerTool(
    "host_list",
    {
      title: "列出所有主机",
      description:
        "列出所有已登记的主机（含未连接的）及其连接状态、会话数。用于 AI 知道有哪些可用主机别名。",
      inputSchema: {},
    },
    async () => {
      try {
        return ok({ hosts: pool.listHosts(), boundHost: ctx.boundHost ?? null });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 10. session_close —— 显式停止：断开当前绑定主机 + 解绑
  server.registerTool(
    "session_close",
    {
      title: "关闭会话（显式停止）",
      description:
        "退出当前 MCP 会话绑定的主机会话：断开 SSH 长连接、关闭其所有 shell，并解除绑定。之后需重新 host_connect 才能执行命令。",
      inputSchema: {
        name: z.string().optional().describe("要关闭的 host 别名；省略=当前绑定主机"),
      },
    },
    async ({ name }) => {
      try {
        const host = name ?? ctx.boundHost ?? gb.lastHost;
        if (!host) {
          return ok({ closed: false, reason: "当前 MCP 会话未绑定任何主机，无需关闭" });
        }
        const r = await pool.disconnect(host);
        if (ctx.boundHost === host) ctx.boundHost = undefined;
        if (gb.lastHost === host) gb.lastHost = undefined;
        suppressHost(gb, host);
        return ok({ closed: true, name: host, bound: false, ...r });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 11. session_minimize —— 最小化：只解绑，连接留在 daemon
  server.registerTool(
    "session_minimize",
    {
      title: "最小化会话（仅解绑）",
      description:
        "解除当前 MCP 会话与主机的绑定，但保留 SSH 连接与 shell 在 daemon 中（可被其它 MCP 会话/CLI 复用）。执行后本会话不再绑定任何主机，需重新 host_connect。",
      inputSchema: {},
    },
    async () => {
      try {
        const prev = ctx.boundHost ?? gb.lastHost;
        ctx.boundHost = undefined;
        gb.lastHost = undefined;
        suppressHost(gb, prev);
        const shells = prev ? pool.shellCount(prev) : 0;
        return ok({
          minimized: true,
          releasedHost: prev ?? null,
          connectionKept: prev ? true : false,
          shellsKept: shells,
          boundHost: null,
        });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 12. shell_subscribe —— 屏幕增量推送（只在真有变化时推，无心跳）
  server.registerTool(
    "shell_subscribe",
    {
      title: "订阅终端增量推送",
      description:
        "订阅某个交互式终端的输出，改由服务端推送流下发（需先 POST subscriptions/listen 建立 SSE 流）。mode=raw(默认) 只推增量字节，与官方 ssh 一致；mode=screen 推渲染整屏（仅变化时）。intervalMs: 500~60000，或 0/省略=事件驱动（内部高频检查，但只在真有变化时透传）。静默期不推任何帧，不发心跳。像 watch 5 这种，只在画面真正变化时才推一次。",
      inputSchema: {
        shellId: z.string().describe("shell_open 返回的 shellId"),
        intervalMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("采样间隔 500~60000ms；0 或省略=事件驱动"),
        mode: z.enum(["raw", "screen"]).optional().describe("raw=增量字节（默认）；screen=渲染整屏"),
        changedOnly: z.boolean().optional().describe("默认 true：无变化不推（无心跳）"),
      },
    },
    async ({ shellId, intervalMs, mode, changedOnly }) => {
      try {
        if (!subs) throw new Error("订阅管理器未初始化");
        const key = sessionKey();
        if (!hub || hub.listeners(key) === 0) {
          return fail(
            "当前会话没有打开的推送流：先 POST /mcp 发送 {\"jsonrpc\":\"2.0\",\"method\":\"subscriptions/listen\"}（带 mcp-session-id）建立 SSE 流，再订阅",
          );
        }
        const r = await subs.start(key, shellId, { intervalMs, mode, changedOnly });
        return ok(r);
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 13. shell_unsubscribe
  server.registerTool(
    "shell_unsubscribe",
    {
      title: "取消终端推送订阅",
      description: "停止某个 subId 的增量推送。传 shellId 则停掉该终端的所有订阅。",
      inputSchema: {
        subId: z.string().optional().describe("shell_subscribe 返回的 subId"),
        shellId: z.string().optional().describe("按终端停掉其全部订阅"),
      },
    },
    async ({ subId, shellId }) => {
      try {
        if (!subs) throw new Error("订阅管理器未初始化");
        let stopped = 0;
        if (subId) stopped += subs.stop(subId) ? 1 : 0;
        if (shellId) stopped += subs.stopShell(shellId);
        return ok({ stopped });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  // 14. subscription_list
  server.registerTool(
    "subscription_list",
    {
      title: "列出推送订阅",
      description: "列出当前进程内所有活跃的终端推送订阅，以及本会话的 SSE 监听流数量。",
      inputSchema: {},
    },
    async () => {
      try {
        return ok({
          listeners: hub?.listeners(sessionKey()) ?? 0,
          subscriptions: subs?.list() ?? [],
        });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );
}
