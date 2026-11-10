/** 致命命令守卫（移植自 atengk/mcp-server-ssh 的 8 条规则） */

interface Rule {
  id: string;
  name: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  {
    id: "lethal-rm-root",
    name: "递归强制删除根/当前目录",
    pattern:
      /(?:sudo\s+)?rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(?:--no-preserve-root\s+)?(?:\/|\/\*|\.)(?:\s|$|\*)/i,
  },
  {
    id: "lethal-mkfs",
    name: "块设备格式化",
    pattern: /(?:sudo\s+)?mkfs(?:\.[a-z0-9]+)?\s+\/dev\/(?:sd[a-z]|nvme|vd[a-z]|hd[a-z])/i,
  },
  {
    id: "lethal-dd-disk",
    name: "底层磁盘覆写",
    pattern: /(?:sudo\s+)?dd\s+.*of=\/dev\/(?:sd[a-z]|nvme|vd[a-z]|hd[a-z])/i,
  },
  {
    id: "lethal-overwrite-dev",
    name: "重定向清空磁盘设备",
    pattern: />\s*\/dev\/(?:sd[a-z]|nvme|vd[a-z]|hd[a-z])/i,
  },
  {
    id: "shutdown-reboot",
    name: "关机/重启",
    pattern: /^(?:sudo\s+)?(?:shutdown(?:\s+-[a-zA-Z]+)?(?:\s+now)?|reboot|poweroff|halt|init\s+[06])(?:\s+.*)?$/i,
  },
  {
    id: "fork-bomb",
    name: "Fork 炸弹",
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  },
  {
    id: "lethal-chmod-zero",
    name: "清空根权限",
    pattern: /(?:sudo\s+)?chmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)?(?:000|0)\s+(?:\/|\/\*)/i,
  },
  {
    id: "lethal-mv-root",
    name: "移动/覆盖根目录",
    pattern: /(?:sudo\s+)?mv\s+(?:.*\s)?\/(?:\s|$)/i,
  },
];

export interface GuardResult {
  allowed: boolean;
  ruleId?: string;
  reason?: string;
}

export class SafetyGuard {
  private extra: Rule[];
  private whitelist: RegExp[];
  constructor(opts?: { extraRules?: Rule[]; whitelist?: string[] }) {
    this.extra = opts?.extraRules ?? [];
    this.whitelist = (opts?.whitelist ?? []).map((p) => new RegExp(p, "i"));
  }

  check(command: string): GuardResult {
    const trimmed = command.trim();
    if (!trimmed) return { allowed: true };
    for (const w of this.whitelist) {
      if (w.test(trimmed)) return { allowed: true };
    }
    for (const rule of [...RULES, ...this.extra]) {
      if (rule.pattern.test(trimmed)) {
        return {
          allowed: false,
          ruleId: rule.id,
          reason: `[安全守卫] 命中高危规则 [${rule.id}: ${rule.name}]，已拒绝执行`,
        };
      }
    }
    return { allowed: true };
  }

  assertSafe(command: string): void {
    const r = this.check(command);
    if (!r.allowed) throw new Error(r.reason);
  }
}
