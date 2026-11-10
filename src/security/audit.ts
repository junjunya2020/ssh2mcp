import fs from "node:fs";
import type { AppConfig } from "../types.js";
import { paths } from "../paths.js";

/** 极简 JSONL 审计；secret 一律不落；同时输出一行到 stdout 供前台 daemon 观察 */
export class Audit {
  constructor(private cfg: AppConfig) {}

  log(event: Record<string, unknown>): void {
    const ts = new Date().toISOString();
    try {
      fs.appendFileSync(paths(this.cfg.dataDir).audit, JSON.stringify({ ts, ...event }) + "\n");
    } catch {
      /* 审计失败不阻断业务 */
    }
    // 前台可见的简洁日志（脱敏：secret 字段不在此列；长字段截断）
    try {
      const tag = typeof event.event === "string" ? event.event : "log";
      const parts = Object.entries(event)
        .filter(([k]) => k !== "event")
        .map(([k, v]) => {
          let s = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
          if (k === "command" && s.length > 120) s = s.slice(0, 120) + "…";
          return `${k}=${s}`;
        })
        .join(" ");
      process.stdout.write(`[${ts}] ${tag} ${parts}\n`);
    } catch {
      /* ignore */
    }
  }
}
