import { StringDecoder } from "node:string_decoder";
import type { ClientChannel } from "ssh2";
import type { ShellReadResult, ShellSessionInfo } from "../types.js";

// @xterm/headless 的 Terminal 类型
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XtermTerminal = any;

export interface ShellChannelDeps {
  // 延迟注入，避免顶层强依赖具体实现
  createTerminal: (rows: number, cols: number) => XtermTerminal;
}

/**
 * 双通道之「二」：持久 PTY 交互会话。
 * - 原始字节流进入 rawBuffer（带单调 totalBytes 游标）
 * - 同时喂给 xterm headless 渲染成虚拟屏
 * - write 只写字符；read 分 screen / raw 两模式，永不阻塞（除非显式 waitMs/expect）
 */
export class ShellChannel {
  readonly shellId: string;
  readonly hostName: string;
  rows: number;
  cols: number;

  private stream: ClientChannel;
  private term: XtermTerminal;
  private decoder = new StringDecoder("utf8");
  private decoderEnded = false;

  private rawBuffer = Buffer.alloc(0);
  private totalBytes = 0; // 单调递增
  private maxBuffer: number;

  private createdAt = new Date().toISOString();
  private lastActivityAt = this.createdAt;
  private lastReadAt = this.createdAt;

  active = true;

  private pendingChars = 0;
  private paused = false;
  private waiters = new Set<() => void>();
  private parseChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    shellId: string,
    hostName: string,
    stream: ClientChannel,
    rows: number,
    cols: number,
    deps: ShellChannelDeps,
    maxBuffer = 4 * 1024 * 1024,
  ) {
    this.shellId = shellId;
    this.hostName = hostName;
    this.stream = stream;
    this.rows = rows;
    this.cols = cols;
    this.maxBuffer = maxBuffer;
    this.term = deps.createTerminal(rows, cols);

    stream.on("data", (data: Buffer) => this.onData(data));
    stream.on("close", () => this.onClose());
    stream.on("error", () => this.onClose());
  }

  private onData(data: Buffer): void {
    if (!this.active || this.decoderEnded) return;
    this.lastActivityAt = new Date().toISOString();
    this.appendRaw(data);
    this.appendScreen(this.decoder.write(data));
    this.notifyWaiters();
  }

  private onClose(): void {
    if (!this.active) return;
    this.endDecoder();
    this.active = false;
    this.notifyWaiters();
  }

  private endDecoder(): void {
    if (this.decoderEnded) return;
    this.decoderEnded = true;
    this.appendScreen(this.decoder.end());
  }

  private appendRaw(data: Buffer): void {
    const next = Buffer.concat([this.rawBuffer, data]);
    this.totalBytes += data.length;
    if (next.length > this.maxBuffer) {
      this.rawBuffer = next.subarray(next.length - this.maxBuffer);
    } else {
      this.rawBuffer = next;
    }
  }

  private appendScreen(text: string): void {
    if (!text || this.disposed) return;
    this.pendingChars += text.length;
    if (!this.paused && this.pendingChars >= 1024 * 1024) {
      this.paused = true;
      try {
        this.stream.pause();
      } catch {
        /* ignore */
      }
    }
    this.parseChain = new Promise<void>((resolve) => {
      try {
        this.term.write(text, () => {
          if (this.disposed) return resolve();
          this.pendingChars -= text.length;
          if (this.paused && this.pendingChars <= 256 * 1024 && this.active) {
            this.paused = false;
            try {
              this.stream.resume();
            } catch {
              /* ignore */
            }
          }
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  /** 等待首屏数据到达（用于 shell_open 后立即取屏，避免竞态）；已有数据则立即返回 */
  waitForFirstData(timeoutMs = 1500): Promise<void> {
    if (this.totalBytes > 0 || !this.active) return Promise.resolve();
    return this.waitFor(undefined, timeoutMs);
  }

  write(data: string): { accepted: boolean; backpressured: boolean } {    if (!this.active) throw new Error(`shell ${this.shellId} 已关闭`);
    this.lastActivityAt = new Date().toISOString();
    const ok = this.stream.write(data);
    return { accepted: true, backpressured: !ok };
  }

  async read(opts: {
    mode: "screen" | "raw";
    since?: number;
    waitMs?: number;
    expect?: string;
  }): Promise<ShellReadResult> {
    const mode = opts.mode;
    const waitMs = opts.waitMs ?? 0;

    // 若有等待条件，先做有界等待
    if (waitMs > 0 || opts.expect) {
      await this.waitFor(opts.expect, waitMs);
    }

    this.lastReadAt = new Date().toISOString();

    if (mode === "screen") {
      await this.parseChain;
      const screen = this.getScreen();
      const cursor = this.getCursor();
      return {
        shellId: this.shellId,
        mode,
        data: screen,
        cursor: this.totalBytes,
        active: this.active,
        rows: this.rows,
        cols: this.cols,
        cursorX: cursor.x,
        cursorY: cursor.y,
      };
    }

    // raw 增量
    const since = opts.since ?? this.totalBytes - this.rawBuffer.length;
    const bufferStart = this.totalBytes - this.rawBuffer.length;
    let truncated = false;
    let start = since;
    if (since < bufferStart) {
      truncated = true;
      start = bufferStart;
    }
    if (start > this.totalBytes) start = this.totalBytes;
    const offset = start - bufferStart;
    const slice = this.rawBuffer.subarray(offset);
    return {
      shellId: this.shellId,
      mode,
      data: slice.toString("utf-8"),
      cursor: this.totalBytes,
      active: this.active,
      rows: this.rows,
      cols: this.cols,
      truncated,
    };
  }

  private waitFor(expect: string | undefined, waitMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.waiters.delete(check);
        clearTimeout(timer);
        resolve();
      };
      const check = () => {
        if (done) return;
        if (rx) {
          if (rx.test(this.rawBuffer.toString("utf-8"))) finish();
        } else {
          // 无 expect：任何新数据到达即可返回
          finish();
        }
      };
      let rx: RegExp | undefined;
      if (expect) {
        try {
          rx = new RegExp(expect);
        } catch {
          rx = undefined;
        }
      }
      this.waiters.add(check);
      const timer = setTimeout(finish, waitMs > 0 ? waitMs : 1000);
      // expect 模式立即检查一次（可能缓冲里已有匹配）
      if (rx) check();
    });
  }

  private notifyWaiters(): void {
    for (const w of this.waiters) {
      try {
        w();
      } catch {
        /* ignore */
      }
    }
  }

  private getScreen(): string {
    try {
      const buffer = this.term.buffer.active;
      const start = buffer.viewportY;
      const end = start + this.rows;
      const lines: string[] = [];
      for (let i = start; i < end; i++) {
        const line = buffer.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
      return lines.join("\n");
    } catch {
      return this.rawBuffer.toString("utf-8");
    }
  }

  private getCursor(): { x?: number; y?: number } {
    try {
      return { x: this.term.buffer.active.cursorX, y: this.term.buffer.active.cursorY };
    } catch {
      return {};
    }
  }

  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    try {
      this.stream.setWindow(rows, cols, 0, 0);
    } catch {
      /* ignore */
    }
    try {
      this.term.resize(cols, rows);
    } catch {
      /* ignore */
    }
  }

  close(): void {
    if (!this.active) {
      this.dispose();
      return;
    }
    try {
      this.stream.close();
    } catch {
      /* ignore */
    }
    this.active = false;
    this.dispose();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const w of this.waiters) {
      try {
        w();
      } catch {
        /* ignore */
      }
    }
    this.waiters.clear();
    try {
      this.term.dispose?.();
    } catch {
      /* ignore */
    }
  }

  info(): ShellSessionInfo {
    return {
      shellId: this.shellId,
      hostName: this.hostName,
      rows: this.rows,
      cols: this.cols,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      lastReadAt: this.lastReadAt,
      active: this.active,
    };
  }
}
