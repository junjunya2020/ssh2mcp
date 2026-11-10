import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/service.js -> 项目根
const projectRoot = path.resolve(__dirname, "..", "..");

function mainScript(): string {
  return path.join(projectRoot, "dist", "main.js");
}

/** 生成 WinSW 服务 XML 内容 */
export function winswXml(): string {
  const cfg = getConfig();
  const exe = process.execPath; // node.exe
  const main = mainScript();
  return `<service>
  <id>sshmcp</id>
  <name>sshmcp</name>
  <description>Stateful SSH MCP daemon (dual-channel exec + PTY)</description>
  <executable>${exe}</executable>
  <arguments>"${main}" daemon --foreground</arguments>
  <workingdirectory>${projectRoot}</workingdirectory>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>${path.join(cfg.dataDir, "logs")}</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
  <env name="SSHMCP_DATA_DIR" value="${cfg.dataDir}"/>
  <env name="SSHMCP_SERVICE" value="1"/>
</service>
`;
}

export function systemdUnit(): string {
  const cfg = getConfig();
  const exe = process.execPath;
  const main = mainScript();
  return `[Unit]
Description=sshmcp - Stateful SSH MCP daemon (dual-channel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exe} ${main} daemon --foreground
Environment=SSHMCP_DATA_DIR=${cfg.dataDir}
Environment=SSHMCP_SERVICE=1
Restart=always
RestartSec=3
WorkingDirectory=${projectRoot}

[Install]
WantedBy=multi-user.target
`;
}

/** 打印对应平台的服务安装指引，并写出模板文件 */
export function serviceInstallGuide(): void {
  const cfg = getConfig();
  const outDir = path.join(projectRoot, "service", "generated");
  fs.mkdirSync(outDir, { recursive: true });

  if (process.platform === "win32") {
    const xmlPath = path.join(outDir, "sshmcp.xml");
    fs.writeFileSync(xmlPath, winswXml(), "utf-8");
    process.stdout.write(
      `已生成 WinSW 配置: ${xmlPath}\n\n` +
        `安装步骤（管理员 PowerShell）:\n` +
        `  1. 下载 WinSW.exe 并重命名为 sshmcp-service.exe，放到 ${outDir}\n` +
        `  2. 将 sshmcp.xml 复制为 sshmcp-service.xml（与 exe 同目录同名）\n` +
        `  3. cd ${outDir} && .\\sshmcp-service.exe install\n` +
        `  4. .\\sshmcp-service.exe start\n` +
        `  5. 查看状态: sc query sshmcp\n\n` +
        `数据目录: ${cfg.dataDir}\n` +
        `客户端 MCP 配置 (http): {"url":"http://${cfg.host}:${cfg.port}/mcp","headers":{"Authorization":"Bearer ${cfg.token}"}}\n`,
    );
  } else {
    const unitPath = path.join(outDir, "sshmcp.service");
    fs.writeFileSync(unitPath, systemdUnit(), "utf-8");
    process.stdout.write(
      `已生成 systemd unit: ${unitPath}\n\n` +
        `安装步骤（root）:\n` +
        `  1. sudo cp ${unitPath} /etc/systemd/system/sshmcp.service\n` +
        `  2. sudo systemctl daemon-reload\n` +
        `  3. sudo systemctl enable --now sshmcp\n` +
        `  4. sudo systemctl status sshmcp\n\n` +
        `数据目录: ${cfg.dataDir}\n` +
        `客户端 MCP 配置 (http): {"url":"http://${cfg.host}:${cfg.port}/mcp","headers":{"Authorization":"Bearer ${cfg.token}"}}\n`,
    );
  }
}

export function serviceStatus(): void {
  if (process.platform === "win32") {
    const r = spawnSync("sc", ["query", "sshmcp"], { encoding: "utf-8" });
    process.stdout.write(r.stdout || r.stderr || "(sc query 无输出)\n");
  } else {
    const r = spawnSync("systemctl", ["status", "sshmcp", "--no-pager"], { encoding: "utf-8" });
    process.stdout.write(r.stdout || r.stderr || "(systemctl 无输出)\n");
  }
}
