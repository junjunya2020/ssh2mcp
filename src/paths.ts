import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * 数据目录：
 * - 显式环境变量 SSHMCP_DATA_DIR 优先
 * - Windows: %ProgramData%\sshmcp（服务账户可访问）
 * - Linux: /etc/sshmcp 如果可写，否则 ~/.sshmcp（用户态运行）
 */
export function resolveDataDir(): string {
  if (process.env.SSHMCP_DATA_DIR) return path.resolve(process.env.SSHMCP_DATA_DIR);
  if (process.platform === "win32") {
    const pd = process.env.ProgramData || "C:\\ProgramData";
    return path.join(pd, "sshmcp");
  }
  return path.join(os.homedir(), ".sshmcp");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function paths(dataDir: string) {
  return {
    dataDir,
    config: path.join(dataDir, "config.json"),
    hosts: path.join(dataDir, "hosts.json"),
    vault: path.join(dataDir, "vault.enc"),
    masterKey: path.join(dataDir, "master.key"),
    knownHosts: path.join(dataDir, "known_hosts"),
    audit: path.join(dataDir, "audit.jsonl"),
    log: path.join(dataDir, "sshmcp.log"),
  };
}
