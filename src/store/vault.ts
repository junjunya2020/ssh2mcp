import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import type { HostSecret, VaultFile } from "../types.js";
import { getConfig } from "../config.js";
import { paths, ensureDir } from "../paths.js";

const ALGO = "aes-256-gcm";

let keyCache: Buffer | null = null;

/**
 * 主密钥：优先文件 ~/.sshmcp/master.key (0600)。
 * 说明：DPAPI / libsecret 作为后续增强（M6），当前用受 0600 保护的本地密钥文件，
 * 已满足「secret 不明文落盘 + AI 永不见」的核心要求。
 */
function getMasterKey(): Buffer {
  if (keyCache) return keyCache;
  const cfg = getConfig();
  const p = paths(cfg.dataDir);
  ensureDir(cfg.dataDir);
  if (fs.existsSync(p.masterKey)) {
    keyCache = fs.readFileSync(p.masterKey);
    return keyCache;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(p.masterKey, key, { mode: 0o600 });
  keyCache = key;
  return key;
}

function vaultPath(): string {
  const cfg = getConfig();
  return paths(cfg.dataDir).vault;
}

function loadVault(): VaultFile {
  const p = vaultPath();
  if (!fs.existsSync(p)) return { version: 1, entries: {} };
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as VaultFile;
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveVault(v: VaultFile): void {
  const cfg = getConfig();
  ensureDir(cfg.dataDir);
  fs.writeFileSync(vaultPath(), JSON.stringify(v, null, 2), { mode: 0o600 });
}

function encrypt(plain: string): { iv: string; tag: string; data: string } {
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: enc.toString("base64"),
  };
}

function decrypt(blob: { iv: string; tag: string; data: string }): string {
  const key = getMasterKey();
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(blob.data, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf-8");
}

export function setSecret(name: string, secret: HostSecret): void {
  const v = loadVault();
  v.entries[name] = encrypt(JSON.stringify(secret));
  saveVault(v);
}

export function getSecret(name: string): HostSecret | undefined {
  const v = loadVault();
  const blob = v.entries[name];
  if (!blob) return undefined;
  try {
    return JSON.parse(decrypt(blob)) as HostSecret;
  } catch {
    return undefined;
  }
}

export function removeSecret(name: string): void {
  const v = loadVault();
  if (v.entries[name]) {
    delete v.entries[name];
    saveVault(v);
  }
}

/** 自检：加解密往返 */
export function selfTest(): boolean {
  const sample = { password: "p@ss-" + os.platform(), passphrase: "x" };
  const name = "__selftest__";
  setSecret(name, sample);
  const back = getSecret(name);
  removeSecret(name);
  return JSON.stringify(back) === JSON.stringify(sample);
}
