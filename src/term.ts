/**
 * @xterm/headless 的 Terminal 封装（唯一强依赖点）。
 * 单独成文件，方便替换/降级。
 */
import headless from "@xterm/headless";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createTerminal(rows: number, cols: number): any {
  // @xterm/headless 的 Terminal 构造签名：(options)
  return new headless.Terminal({ rows, cols, allowProposedApi: true, scrollback: 5000 });
}
