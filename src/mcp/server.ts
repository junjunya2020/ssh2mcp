import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectionPool } from "../ssh/pool.js";
import { registerTools } from "./tools.js";
import { newSessionCtx } from "./session.js";
import type { GlobalBinding, SessionCtx } from "./session.js";
import type { PushHub } from "../push.js";
import type { SubscriptionManager } from "../subscriptions.js";

/**
 * 每个 MCP 会话一个 McpServer 实例，携带自己的 SessionCtx（绑定主机）。
 * hub/subs 是进程级：推送流按 mcp-session-id 隔离。
 */
export function buildMcpServer(
  pool: ConnectionPool,
  ctx: SessionCtx = newSessionCtx(),
  gb: GlobalBinding = {},
  hub?: PushHub,
  subs?: SubscriptionManager,
): McpServer {
  const server = new McpServer({
    name: "sshmcp",
    version: "0.3.0",
  });
  registerTools(server, pool, ctx, gb, hub, subs);
  return server;
}
