/** 共享类型定义 */

export type AuthType = "key" | "password";

/** host 元数据（不含任何 secret） */
export interface HostEntry {
  name: string;
  host: string;
  port: number;
  user: string;
  authType: AuthType;
  /** key 认证：私钥文件路径 */
  keyPath?: string;
  /** 预留：证书路径（当前版本不实现 CA 证书认证） */
  certPath?: string;
  /** 预留：跳板机（后续版本） */
  proxyJump?: string;
  /** 默认工作目录（可选） */
  defaultDir?: string;
  /** 描述 */
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/** vault 中存储的 secret（AES-256-GCM 加密后落盘） */
export interface HostSecret {
  /** password 认证：密码 */
  password?: string;
  /** key 认证：私钥口令/passphrase */
  passphrase?: string;
}

export interface HostStoreFile {
  version: 1;
  hosts: HostEntry[];
}

export interface VaultFile {
  version: 1;
  /** name -> { iv, tag, data } base64 */
  entries: Record<string, EncryptedBlob>;
}

export interface EncryptedBlob {
  iv: string;
  tag: string;
  data: string;
}

/** 配置 */
export interface AppConfig {
  version: 1;
  /** HTTP 监听地址（永远建议 127.0.0.1） */
  host: string;
  port: number;
  /** MCP/HTTP Bearer token */
  token: string;
  /** 单 host 最大并发连接数（多连接回退上限） */
  maxConnPerHost: number;
  /** 单次输出截断字节 */
  maxOutputBytes: number;
  /** 致命命令守卫开关 */
  safetyGuard: boolean;
  /** host key 严格模式：true=只接受 known_hosts 内已知主机 */
  strictHostKey: boolean;
  /** daemon 启动时是否自动拉起一个全新的免登录 CF 隧道（每次启动都是新 URL） */
  tunnelAutoStart?: boolean;
  /** quick=免登录临时隧道（每次新域名）；named=自定义域名（需 CF 绑 DNS，走 token 配置） */
  tunnelMode?: "quick" | "named";
  /** named 模式的自定义公网地址，如 https://mcp.example.com */
  tunnelCustomUrl?: string;
  dataDir: string;
}

// ---- 运行时会话对象（不落盘） ----

export interface ShellSessionInfo {
  shellId: string;
  hostName: string;
  rows: number;
  cols: number;
  createdAt: string;
  lastActivityAt: string;
  lastReadAt: string;
  active: boolean;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  totalBytes: number;
}

export interface ShellReadResult {
  shellId: string;
  mode: "screen" | "raw";
  data: string;
  cursor: number;
  matched?: boolean;
  active: boolean;
  rows: number;
  cols: number;
  cursorX?: number;
  cursorY?: number;
  truncated?: boolean;
}
