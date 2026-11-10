#!/usr/bin/env node
import { runDaemon } from "./daemon.js";
import { runCli } from "./cli/index.js";
import { runMenu } from "./cli/menu.js";
import { serviceInstallGuide, serviceStatus } from "./service.js";

function parseFlags(args: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "daemon") {
    const f = parseFlags(rest);
    await runDaemon({
      port: f.port ? Number(f.port) : undefined,
      foreground: !!f.foreground,
      oneshot: !!f.oneshot,
    });
    return;
  }

  // 交互式管理菜单（给 manage.bat 无参调用）
  if (cmd === "menu") {
    await runMenu();
    return;
  }

  if (cmd === "service") {
    const action = rest[0];
    if (action === "install") {
      serviceInstallGuide();
      return;
    }
    if (action === "status") {
      serviceStatus();
      return;
    }
    process.stdout.write("用法: sshmcp service install|status （start/stop 请用系统服务管理器）\n");
    return;
  }

  // 其余交给 CLI
  await runCli(process.argv.slice(2));
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
