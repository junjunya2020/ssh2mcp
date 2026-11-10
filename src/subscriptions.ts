import type { ConnectionPool } from "./ssh/pool.js";
import type { PushHub } from "./push.js";

/** 采样间隔：0.5s 下限，60s 上限；0 = 事件驱动（内部高频检查，但只在真有变化时推） */
const MIN_INTERVAL = 500;
const MAX_INTERVAL = 60000;
const EVENT_INTERVAL = 200;

export interface SubOptions {
  intervalMs?: number;
  /** raw = 只推增量字节（和官方 ssh 一致）；screen = 推渲染后的整屏（变化时才推） */
  mode?: "raw" | "screen";
  /** 默认 true：画面/增量没变化就一个字节都不推（无心跳） */
  changedOnly?: boolean;
}

interface ActiveSub {
  id: string;
  sessionKey: string;
  shellId: string;
  timer: NodeJS.Timeout;
  cursor: number;
  lastScreen: string;
  opts: Required<SubOptions>;
}

/**
 * 交互式终端的推送订阅管理器。
 *
 * 关键点：静默期**不推任何东西**（没有心跳帧），
 * 只有 SSH 侧真有新数据或屏幕真有变化时才 emit 一次增量。
 * 这样 `watch 5` 只在每 5 秒真有变化时透传一次，AI 不会被空帧误导。
 */
export class SubscriptionManager {
  private subs = new Map<string, ActiveSub>();
  private seq = 0;

  constructor(
    private pool: ConnectionPool,
    private hub: PushHub,
  ) {}

  async start(sessionKey: string, shellId: string, opts: SubOptions = {}): Promise<{
    subId: string;
    shellId: string;
    cursor: number;
    intervalMs: number;
    mode: "raw" | "screen";
    changedOnly: boolean;
    listeners: number;
  }> {
    const shell = this.pool.getShell(shellId); // 不存在会抛错
    const intervalMs = opts.intervalMs === undefined ? 0 : opts.intervalMs;
    if (intervalMs !== 0 && (intervalMs < MIN_INTERVAL || intervalMs > MAX_INTERVAL)) {
      throw new Error(`intervalMs 必须在 ${MIN_INTERVAL}~${MAX_INTERVAL} 之间（0 表示事件驱动）`);
    }

    const first = await shell.read({ mode: "raw" });
    const subId = `sub_${++this.seq}_${Date.now()}`;
    const sub: ActiveSub = {
      id: subId,
      sessionKey,
      shellId,
      timer: undefined as unknown as NodeJS.Timeout,
      cursor: first.cursor,
      lastScreen: "",
      opts: {
        intervalMs,
        mode: (opts.mode ?? "raw") as "raw" | "screen",
        changedOnly: opts.changedOnly ?? true,
      },
    };

    const tick = async () => {
      const cur = this.subs.get(subId);
      if (!cur) return;
      try {
        let raw = "";
        let cursor = cur.cursor;
        try {
          const r = await shell.read({ mode: "raw", since: cur.cursor });
          raw = r.data;
          cursor = r.cursor;
        } catch {
          /* 读失败下一轮重试 */
        }
        let screen = "";
        try {
          screen = (await shell.read({ mode: "screen" })).data;
        } catch {
          /* ignore */
        }

        const screenChanged = screen !== cur.lastScreen;
        const rawChanged = raw.length > 0;
        cur.cursor = cursor;
        cur.lastScreen = screen;

        const changed = rawChanged || screenChanged;
        if (cur.opts.changedOnly && !changed) return; // 静默：不推、无心跳

        this.hub.emit(cur.sessionKey, "notifications/sshmcp.output", {
          subId: cur.id,
          shellId: cur.shellId,
          mode: cur.opts.mode,
          cursor,
          // 增量字节永远带（和官方 ssh 一致）；screen 模式额外带整屏
          ...(rawChanged ? { delta: raw } : {}),
          ...(cur.opts.mode === "screen" && screenChanged ? { screen } : {}),
          screenChanged,
          at: Date.now(),
        });
      } catch (e) {
        // shell 没了 → 通知一次并自毁
        this.hub.emit(cur.sessionKey, "notifications/sshmcp.closed", {
          subId: cur.id,
          shellId: cur.shellId,
          reason: (e as Error).message,
        });
        this.stop(cur.id);
      }
    };

    const period = intervalMs === 0 ? EVENT_INTERVAL : intervalMs;
    sub.timer = setInterval(() => void tick(), period);
    sub.timer.unref?.();
    this.subs.set(subId, sub);

    return {
      subId,
      shellId,
      cursor: first.cursor,
      intervalMs,
      mode: sub.opts.mode,
      changedOnly: sub.opts.changedOnly,
      listeners: this.hub.listeners(sessionKey),
    };
  }

  stop(subId: string): boolean {
    const s = this.subs.get(subId);
    if (!s) return false;
    clearInterval(s.timer);
    this.subs.delete(subId);
    return true;
  }

  stopShell(shellId: string): number {
    let n = 0;
    for (const [id, s] of [...this.subs]) {
      if (s.shellId === shellId) {
        clearInterval(s.timer);
        this.subs.delete(id);
        n++;
      }
    }
    return n;
  }

  stopSession(sessionKey: string): number {
    let n = 0;
    for (const [id, s] of [...this.subs]) {
      if (s.sessionKey === sessionKey) {
        clearInterval(s.timer);
        this.subs.delete(id);
        n++;
      }
    }
    return n;
  }

  list(): Array<{ subId: string; shellId: string; intervalMs: number; mode: string }> {
    return [...this.subs.values()].map((s) => ({
      subId: s.id,
      shellId: s.shellId,
      intervalMs: s.opts.intervalMs,
      mode: s.opts.mode,
    }));
  }
}
