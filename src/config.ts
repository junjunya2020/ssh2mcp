import fs from "node:fs";
import crypto from "node:crypto";
import type { AppConfig } from "./types.js";
import { resolveDataDir, ensureDir, paths } from "./paths.js";

let cached: AppConfig | null = null;

export function getConfig(forceReload = false): AppConfig {
  if (cached && !forceReload) return cached;
  const dataDir = resolveDataDir();
  ensureDir(dataDir);
  const p = paths(dataDir);

  if (!fs.existsSync(p.config)) {
    const cfg: AppConfig = {
      version: 1,
      host: "127.0.0.1",
      port: 8765,
      token: crypto.randomBytes(24).toString("base64url"),
      maxConnPerHost: 4,
      maxOutputBytes: 65536,
      safetyGuard: true,
      strictHostKey: false,
      tunnelAutoStart: false,
      dataDir,
    };
    fs.writeFileSync(p.config, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    cached = cfg;
    return cfg;
  }

  const raw = JSON.parse(fs.readFileSync(p.config, "utf-8")) as Partial<AppConfig>;
  const cfg: AppConfig = {
    version: 1,
    host: raw.host ?? "127.0.0.1",
    port: raw.port ?? 8765,
    token: raw.token ?? crypto.randomBytes(24).toString("base64url"),
    maxConnPerHost: raw.maxConnPerHost ?? 4,
    maxOutputBytes: raw.maxOutputBytes ?? 65536,
    safetyGuard: raw.safetyGuard ?? true,
    strictHostKey: raw.strictHostKey ?? false,
    tunnelAutoStart: raw.tunnelAutoStart ?? false,
    dataDir: raw.dataDir ?? dataDir,
  };
  cached = cfg;
  return cfg;
}

export function saveConfig(cfg: AppConfig): void {
  const p = paths(cfg.dataDir);
  ensureDir(cfg.dataDir);
  fs.writeFileSync(p.config, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  cached = cfg;
}
