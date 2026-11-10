import fs from "node:fs";
import type { HostEntry, HostStoreFile } from "../types.js";
import { getConfig } from "../config.js";
import { paths, ensureDir } from "../paths.js";

function storePath(): string {
  const cfg = getConfig();
  return paths(cfg.dataDir).hosts;
}

export function loadHosts(): HostEntry[] {
  const p = storePath();
  if (!fs.existsSync(p)) return [];
  try {
    const f = JSON.parse(fs.readFileSync(p, "utf-8")) as HostStoreFile;
    return f.hosts ?? [];
  } catch {
    return [];
  }
}

function saveHosts(hosts: HostEntry[]): void {
  const cfg = getConfig();
  ensureDir(cfg.dataDir);
  const file: HostStoreFile = { version: 1, hosts };
  fs.writeFileSync(storePath(), JSON.stringify(file, null, 2), { mode: 0o600 });
}

export function getHost(name: string): HostEntry | undefined {
  return loadHosts().find((h) => h.name === name);
}

export interface AddHostInput {
  name?: string;
  host: string;
  port?: number;
  user: string;
  authType: "key" | "password";
  keyPath?: string;
  certPath?: string;
  proxyJump?: string;
  defaultDir?: string;
  description?: string;
}

export function addHost(input: AddHostInput): HostEntry {
  const hosts = loadHosts();
  const name = (input.name ?? "").trim() || input.host.trim(); // 名称默认取 IP/主机名
  if (hosts.some((h) => h.name === name)) {
    throw new Error(`host '${name}' 已存在，请先 remove 或换个名字`);
  }
  if (input.authType === "key" && !input.keyPath) {
    throw new Error("key 认证必须提供 keyPath（--key）");
  }
  const now = new Date().toISOString();
  const entry: HostEntry = {
    name,
    host: input.host,
    port: input.port ?? 22,
    user: input.user,
    authType: input.authType,
    keyPath: input.keyPath,
    certPath: input.certPath,
    proxyJump: input.proxyJump,
    defaultDir: input.defaultDir,
    description: input.description,
    createdAt: now,
    updatedAt: now,
  };
  hosts.push(entry);
  saveHosts(hosts);
  return entry;
}

export function removeHost(name: string): boolean {
  const hosts = loadHosts();
  const next = hosts.filter((h) => h.name !== name);
  if (next.length === hosts.length) return false;
  saveHosts(next);
  return true;
}
