/**
 * 服务端推送中枢。
 *
 * 客户端 POST `subscriptions/listen` 拿一条 SSE 流（带会话 id），
 * 之后所有下行都从这条流推给它 —— 一次性命令的输出、交互式屏幕的增量。
 *
 * 铁律：**不发心跳**。只有 SSH 侧真的产生新数据/画面变化才 emit。
 * 静默期一个字节都不推，避免 AI 把心跳误读成"命令有输出"而乱动作。
 */

export interface PushEvent {
  /** 例如 notifications/sshmcp.output、notifications/sshmcp.exec */
  method: string;
  params: Record<string, unknown>;
}

export interface Subscriber {
  id: string;
  /** 会话键：mcp-session-id，或 legacy 共享会话 */
  sessionKey: string;
  write: (evt: PushEvent) => void;
  close: () => void;
}

export class PushHub {
  private subs = new Map<string, Set<Subscriber>>();

  add(sub: Subscriber): void {
    let set = this.subs.get(sub.sessionKey);
    if (!set) {
      set = new Set();
      this.subs.set(sub.sessionKey, set);
    }
    set.add(sub);
  }

  remove(sub: Subscriber): void {
    const set = this.subs.get(sub.sessionKey);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.subs.delete(sub.sessionKey);
  }

  /** 向某会话的所有监听者推送；没有监听者就静默丢弃（不排队、不补发） */
  emit(sessionKey: string, method: string, params: Record<string, unknown>): number {
    const set = this.subs.get(sessionKey);
    if (!set || set.size === 0) return 0;
    let n = 0;
    for (const s of set) {
      try {
        s.write({ method, params });
        n++;
      } catch {
        /* 单个订阅写失败不影响其它 */
      }
    }
    return n;
  }

  listeners(sessionKey: string): number {
    return this.subs.get(sessionKey)?.size ?? 0;
  }

  totalListeners(): number {
    let n = 0;
    for (const s of this.subs.values()) n += s.size;
    return n;
  }

  closeSession(sessionKey: string): void {
    const set = this.subs.get(sessionKey);
    if (!set) return;
    for (const s of set) {
      try {
        s.close();
      } catch {
        /* ignore */
      }
    }
    this.subs.delete(sessionKey);
  }
}
