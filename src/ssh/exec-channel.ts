import type { Client, ClientChannel } from "ssh2";
import { StringDecoder } from "node:string_decoder";
import type { ExecResult } from "../types.js";
import { SafetyGuard } from "../security/guard.js";
import { OutputTruncator } from "../security/truncator.js";

export interface ExecOptions {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  rawExec?: boolean;
  timeoutMs?: number;
  /** 流式输出回调：每个数据块触发一次（用于 SSE 推送，逐块下发不攒包） */
  onChunk?: (stream: "stdout" | "stderr", text: string) => void;
}

/**
 * 在既有 SSH 连接上开一条 exec 通道执行单次命令。
 * 双通道之「一」：每次命令一条独立 channel，天然拿到 stdout/stderr/exitCode。
 */
export function execOnClient(
  client: Client,
  opts: ExecOptions,
  guard: SafetyGuard,
  truncator: OutputTruncator,
): Promise<ExecResult> {
  const { command, cwd, env, rawExec, timeoutMs = 60000 } = opts;
  const start = Date.now();

  let finalCommand = command;
  if (cwd) {
    const escapedCwd = cwd.replace(/'/g, "'\\''");
    finalCommand = `cd '${escapedCwd}' && ${finalCommand}`;
  }
  if (!rawExec) {
    const escaped = finalCommand.replace(/'/g, "'\\''");
    finalCommand = `bash -l -c '${escaped}'`;
  }

  // safety check on the *original* command
  const g = guard.check(command);
  if (!g.allowed) {
    return Promise.reject(new Error(g.reason));
  }

  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    client.exec(finalCommand, { env }, (err: Error | undefined, stream: ClientChannel) => {
      if (err) return reject(new Error(`exec 通道创建失败: ${err.message}`));

      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let exitCode: number | null = null;

      timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            stream.close();
            (stream as unknown as { signal?: (s: string) => void }).signal?.("KILL");
          } catch {
            /* ignore */
          }
          reject(new Error(`命令执行超时 (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      const outDecoder = new StringDecoder("utf8");
      const errDecoder = new StringDecoder("utf8");

      stream.on("data", (c: Buffer) => {
        outChunks.push(Buffer.from(c));
        if (opts.onChunk) {
          const t = outDecoder.write(c);
          if (t) opts.onChunk("stdout", t);
        }
      });
      stream.stderr.on("data", (c: Buffer) => {
        errChunks.push(Buffer.from(c));
        if (opts.onChunk) {
          const t = errDecoder.write(c);
          if (t) opts.onChunk("stderr", t);
        }
      });
      stream.on("exit", (code: number | null) => {
        exitCode = code;
      });
      stream.on("close", () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        const stdout = truncator.process(Buffer.concat(outChunks).toString("utf-8"));
        const stderr = truncator.process(Buffer.concat(errChunks).toString("utf-8"));
        resolve({
          exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          durationMs: Date.now() - start,
          truncated: stdout.truncated || stderr.truncated,
          totalBytes: stdout.originalBytes + stderr.originalBytes,
        });
      });
      stream.on("error", (e: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(new Error(`命令数据流异常: ${e.message}`));
      });
    });
  });
}
