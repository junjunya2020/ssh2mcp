/**
 * MCP 会话上下文。
 *
 * 一个 Streamable HTTP 会话 = 一个 McpServer 实例 = 一份 SessionCtx。
 * boundHost 就是「当前 MCP 会话绑定的主机」，exec / shell_open 不传 name 时用它。
 *
 * GlobalBinding 是跨会话兜底：客户端若在轮次之间重建会话（没有 mcp-session-id），
 * 仍能沿用上一次 host_connect 的主机，避免"莫名其妙丢了连接"。
 * 每次 exec 的返回里都带 host 字段，模型永远知道自己打到了哪台。
 */
export interface SessionCtx {
  sessionId?: string;
  boundHost?: string;
  createdAt: number;
  lastSeen: number;
}

export interface GlobalBinding {
  lastHost?: string;
  /** 用户显式关闭/最小化过的主机：不再被"长连接自动继承"捡回来 */
  suppressed?: string[];
}

export function suppressHost(gb: GlobalBinding, host: string | undefined): void {
  if (!host) return;
  gb.suppressed ??= [];
  if (!gb.suppressed.includes(host)) gb.suppressed.push(host);
}

export function unsuppressHost(gb: GlobalBinding, host: string): void {
  if (!gb.suppressed) return;
  gb.suppressed = gb.suppressed.filter((h) => h !== host);
}

export function isSuppressed(gb: GlobalBinding, host: string): boolean {
  return !!gb.suppressed?.includes(host);
}

export function newSessionCtx(): SessionCtx {
  const now = Date.now();
  return { createdAt: now, lastSeen: now };
}
