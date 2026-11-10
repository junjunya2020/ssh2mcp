import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AppConfig } from "../types.js";
import { paths, ensureDir } from "../paths.js";

/**
 * known_hosts（TOFU）校验：
 * - 记录 "host:port sha256:<base64>"
 * - 首次连接（TOFU）自动记录并放行
 * - 已记录但指纹不一致 => 一律拒绝（防 MITM）
 * - strictHostKey=true 时，未记录的主机直接拒绝
 */
export class HostKeyVerifier {
  private known = new Map<string, string>();
  private storePath: string;

  constructor(private cfg: AppConfig, knownHostsPath?: string) {
    this.storePath = knownHostsPath ?? paths(cfg.dataDir).knownHosts;
    ensureDir(path.dirname(this.storePath));
    if (fs.existsSync(this.storePath)) {
      for (const line of fs.readFileSync(this.storePath, "utf-8").split("\n")) {
        const [k, v] = line.trim().split(" ");
        if (k && v) this.known.set(k, v);
      }
    }
  }

  /** 返回 ssh2 hostVerifier 回调 */
  verifier(host: string, port: number) {
    const key = `${host}:${port}`;
    return (keyBuf: Buffer, cb?: (ok: boolean) => void): boolean => {
      const fp = "sha256:" + crypto.createHash("sha256").update(keyBuf).digest("base64").replace(/=+$/, "");
      const stored = this.known.get(key);
      let ok: boolean;
      if (!stored) {
        if (this.cfg.strictHostKey) {
          ok = false;
        } else {
          this.known.set(key, fp);
          this.persist();
          ok = true;
        }
      } else {
        ok = stored === fp;
      }
      if (typeof cb === "function") cb(ok);
      return ok;
    };
  }

  private persist(): void {
    const lines = [...this.known.entries()].map(([k, v]) => `${k} ${v}`).join("\n") + "\n";
    fs.writeFileSync(this.storePath, lines, { mode: 0o600 });
  }
}
