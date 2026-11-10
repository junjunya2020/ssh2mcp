/** ANSI 清洗 + 头尾双端截断 */

const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(text: string): string {
  if (!text) return "";
  return text.replace(ANSI_REGEX, "");
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalBytes: number;
  retainedBytes: number;
}

export class OutputTruncator {
  constructor(
    private maxBytes = 65536,
    private headBytes = 8192,
  ) {}

  truncate(text: string, overrideMax?: number): TruncateResult {
    if (!text) return { text: "", truncated: false, originalBytes: 0, retainedBytes: 0 };
    const limit = overrideMax ?? this.maxBytes;
    const buf = Buffer.from(text, "utf-8");
    const originalBytes = buf.length;
    if (originalBytes <= limit) {
      return { text, truncated: false, originalBytes, retainedBytes: originalBytes };
    }
    const effHead = Math.min(this.headBytes, Math.floor(limit / 8));
    const effTail = limit - effHead;
    const head = buf.subarray(0, effHead).toString("utf-8");
    const tail = buf.subarray(originalBytes - effTail).toString("utf-8");
    const notice = `\n\n[... 输出超 ${Math.round(limit / 1024)}KB，已保留头 ${Math.round(effHead / 1024)}KB + 尾 ${Math.round(effTail / 1024)}KB（原 ${originalBytes} 字节）...]\n\n`;
    const combined = head + notice + tail;
    return {
      text: combined,
      truncated: true,
      originalBytes,
      retainedBytes: Buffer.byteLength(combined, "utf-8"),
    };
  }

  process(raw: string, overrideMax?: number): TruncateResult {
    return this.truncate(stripAnsi(raw), overrideMax);
  }
}
