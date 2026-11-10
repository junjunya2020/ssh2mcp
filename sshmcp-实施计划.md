# sshmcp 实施计划 v2（TS · 服务化 · 双通道 · HTTP 直连）

> 需求锁定：**8 个** MCP 工具 · TypeScript · Win/Linux 服务化 · CLI 管主机 · AI 永不见密码 · 先做密钥+密码 · **双通道不可省** · 预留跳板/端口转发/反向转发 · 优先单连接多通道 · 必须 session_list。

---

## ✅ 决策锁定（2026-11-10 第 2 轮）

| 决策点 | 结论 |
|---|---|
| 认证方式 | **先做「密钥 + 密码」**；证书（CA 用户证书 / PKCS#12）暂不做，等确认类型后增量补，不阻塞主线 |
| AI 侧 MCP 接入 | **本地 HTTP/SSE 直连**（daemon 直接开 HTTP，客户端配 url），**不用 stdio bridge** |
| 工具数 | **8 个**：7 个原样 + 新增 `shell_close(shellId)` 显式关单会话 |

> HTTP 直连带来的变化：daemon 同时是 **MCP 服务端**（`/mcp`，MCP Streamable HTTP/SSE）和**管理端**（`/admin`，JSON API 给 CLI）。CLI 不再走本地 IPC，而是带 token 打本机 HTTP。安全基线：**只绑 `127.0.0.1`** + Bearer token（首次生成写入配置，客户端 `mcp.json` 里带 header）。好处：省一层进程、任何支持 HTTP 的 MCP 客户端都能连、多客户端共享同一 daemon；代价：客户端要配 url+token（一次性）。

---

## 0. 一句话架构

一个**常驻 daemon**（系统服务）持有全部 SSH 连接与 PTY 会话，并**同时暴露两个 HTTP 面**：`/mcp`（MCP over HTTP/SSE，给 AI）和 `/admin`（JSON API，给 CLI）。状态活在 daemon 里 → 跨会话/客户端重启不丢，CLI 与 AI 共享同一份清单，密码只在 daemon 内。

```
   WorkBuddy/Claude ──HTTP(/mcp, SSE + Bearer)──┐
                                                ▼
                                     ┌───────────────────────────────┐
   人类 shell ──sshmcp cli──HTTP(/admin)─▶│        sshmcp daemon           │  ← 系统服务
                                     │  绑定 127.0.0.1:<port>          │
                                     │  hosts registry + vault        │
                                     │  ConnectionPool (ssh2)         │
                                     │   ├─ hostA: 1×Client ─┬ exec ch │
                                     │   │                   └ shell ch│ → xterm 屏
                                     │   └─ hostB: 1×Client ─┬ exec ch │
                                     │                       └ shell ch│
                                     │  audit / guard / truncator     │
                                     └───────────────────────────────┘
```

---

## 1. 为什么是「常驻 daemon + HTTP 直连」

| 关注点 | daemon(HTTP) | MCP 进程 stdio 直连 |
|---|---|---|
| 状态跨会话持久 | ✅ 强 | ❌ 进程被杀就没了 |
| CLI 与 AI 共享会话清单 | ✅ 同一 daemon | ❌ 两套内存 |
| 密码只在加密库、AI 不可见 | ✅ 只进 daemon | ⚠️ 需谨慎 |
| 服务化（开机自启、崩溃重启） | ✅ 天然 | ❌ 客户端拉起，谈不上服务 |
| 多客户端共享 | ✅ 多个 AI/人同时连 | ❌ 各自一份 |
| 客户端接入 | 配 url + Bearer header（一次） | 配 command（一次） |

---

## 2. 目录结构

```
sshmcp/
├─ package.json            # bin: sshmcp（CLI+daemon 同一个可执行）
├─ tsconfig.json           # 编译到 dist/，node>=20
├─ src/
│  ├─ main.ts              # 子命令分发: daemon | host | session | service | version
│  ├─ config.ts            # 配置加载/校验（路径见 §6 平台差异）
│  ├─ store/
│  │  ├─ hosts.ts          # host 注册表 CRUD + 持久化(hosts.json)
│  │  └─ vault.ts          # 凭据加密 (AES-256-GCM)，见 §6
│  ├─ ssh/
│  │  ├─ pool.ts           # host -> ssh2 Client 池；单连接多 channel + 多连接回退
│  │  ├─ exec-channel.ts   # exec 通道：stdout/stderr/exitCode + 截断
│  │  ├─ shell-channel.ts  # shell 通道：xterm 屏 + raw buffer(cursor) + 背压/GC
│  │  └─ hostkey.ts        # known_hosts 校验 (TOFU + 严格模式)
│  ├─ mcp/
│  │  ├─ server.ts         # MCP server（Streamable HTTP/SSE）装配于 /mcp
│  │  └─ tools.ts          # 8 个工具 schema + handler（调用 ssh/*、store/*）
│  ├─ http/
│  │  ├─ app.ts            # express：/mcp(挂 MCP)、/admin(JSON)、鉴权中间件
│  │  └─ admin-routes.ts   # host add/remove/list/test、session list、health
│  ├─ cli/index.ts         # CLI 子命令（打 /admin）
│  └─ security/
│     ├─ guard.ts          # 致命命令拦截（抄 atengk 8 条）
│     ├─ truncator.ts      # 64KB 双端截断 + ANSI 清洗
│     └─ audit.ts          # JSONL 审计（secret 脱敏）
├─ service/
│  ├─ winsw/sshmcp.xml     # Windows 服务包装（WinSW）
│  └─ systemd/sshmcp.service
└─ scripts/install-service.{ps1,sh}
```

---

## 3. 双通道设计（核心，不可省）

**同一 ssh2 `Client`（一条 TCP 连接）上并行两种 channel：**

- **exec 通道**（`client.exec(cmd)`）：每次命令开一个临时 channel，天然带独立 `stdout/stderr/exit` 事件 → 精准 `exitCode`。用完即关。**这是「直接执行」**。
- **shell 通道**（`client.shell({term,rows,cols})`）：持久 PTY，原始字节流 + `@xterm/headless` 渲染屏。**这承载「交互式写/读字符」**。

> 关键结论（源码已印证）：exec 通道与 shell 通道在 SSH 协议层是**两条独立 channel，不共享 cwd/env**。这不是 bug——正好对应你「两种执行方式分开」的设计：exec 追求干净退出码（无状态），shell 追求共享环境（持久）。**互不干扰，正是双通道的价值。**

**单连接多通道 + 多连接回退**：一个 host 复用一条 `Client`，多条 channel 挂其上；`pool.ts` 维护 `host -> {clients:[Client], channels:{exec,shell}}`。
- sshd 默认 `MaxSessions 10`（每连接 channel 上限）。接近上限或开 channel 失败(`Channel open failure`)时 → **自动在同 host 再开一条 Client（`conn#2`）**并把新 channel 挂过去。上限可配 `maxConnPerHost`。
- `session_list` 标注每 host 的 `connections` 数与各连接 channel 计数。
- 心跳：`keepaliveInterval=30s, keepaliveCountMax=3`；断线由 daemon 标记 `disconnected`，下次调用自动重连（凭据从 vault 取）。

---

## 4. 8 个工具详规

统一：host 一律用**别名 `name`** 寻址（CLI 已登记），工具参数里**没有任何密码/密钥字段**。

| # | 工具 | 入参 | 返回 | 通道 |
|---|---|---|---|---|
| 1 | `host_connect` | `name` | `{name,connected,host,port,user,banner,latencyMs}` | 建 Client |
| 2 | `host_disconnect` | `name` | `{name,disconnected,closedChannels}` | 关全部 Client |
| 3 | `exec` | `name, command, timeoutMs?=60000, cwd?, env?, rawExec?=false` | `{exitCode,stdout,stderr,durationMs,truncated,totalBytes}` | exec |
| 4 | `shell_open` | `name, rows?=30, cols?=120, term?='xterm-256color', cwd?, env?` | `{shellId,rows,cols,screen,cursor}` | shell |
| 5 | `shell_write` | `shellId, data` | `{accepted,backpressured}` | shell |
| 6 | `shell_read` | `shellId, mode='screen'\|'raw', since?, waitMs?=0, expect?` | 见下 | shell |
| 7 | `shell_close` | `shellId` | `{shellId,closed}` | shell |
| 8 | `session_list` | — | `{hosts:[…],shells:[…]}` | — |

### `shell_read` 语义（关键，别做成阻塞）
- `mode='screen'`：返回**当前整屏**（xterm 渲染，剥尾空行），带 `cursorX/cursorY`。忽略 `since`。
- `mode='raw'`：返回**自 `since` 游标以来的增量**（UTF-8，StringDecoder 处理跨块）。返回新 `cursor`（单调 totalBytes 偏移）。不传 `since` 则从当前缓冲头起。
- `waitMs`：默认 0 → **立即返回**（非阻塞）。>0 才有界等待「有新数据或超时」。
- `expect`：正则；给了就等到匹配（受 `waitMs` 限制），返回 `matched:true/false`。
- 返回：`{shellId,mode,data,cursor,matched?,active,rows,cols,cursorX?,cursorY?,truncated}`

> 原则：**read 永远不因「命令还没跑完」卡死**——完成判定交给调用方（多读几次 / 用 expect / 发 Ctrl-C 由 `shell_write("\x03")`）。这是 PiloTY/atengk 的教训。

### `shell_close` 语义
显式关闭单个 shell channel（`stream.close()` + 释放 xterm 实例）。区别于 `host_disconnect`（关整条连接）。shell 自然 `exit`/EOF 时 daemon 也会自动 GC，`shell_close` 只是显式手段。

### `session_list` 返回形态
```jsonc
{
  "hosts":  [{ "name":"web", "host":"1.2.3.4", "port":22, "user":"root",
               "state":"connected", "connections":1, "channels":{"exec":0,"shell":1},
               "lastActiveAt":"2026-11-10T22:40:00Z" }],
  "shells": [{ "shellId":"sh_1_…", "host":"web", "rows":30, "cols":120,
               "createdAt":"…", "lastActivityAt":"…", "lastReadAt":"…",
               "foreground":"vim /etc/nginx.conf", "active":true }]
}
```

---

## 5. 虚拟屏选型
用 **`@xterm/headless`**（xterm.js 真核心，Pyrokine 已验证）：CJK 宽字符、alt-screen、光标定位比 pyte 准。每个 shell channel 一个 `Terminal`，`on('data')` 即 `terminal.write()`；另存 `rawBuffer`(Buffer，带 totalBytes 游标) + `StringDecoder`(UTF-8 跨块) + 背压(>1MB pause / <256KB resume)。

---

## 6. 凭据与「AI 永不见密码」+ 平台路径

- `hosts.json`：只存**元数据**（name/host/port/user/authType/keyPath/proxyJump…），**不存任何 secret**。
- `vault.enc`：密码、私钥口令、passphrase 用 **AES-256-GCM** 加密。
- 主密钥来源（按优先级）：① OS keychain（Windows **DPAPI** `CryptProtectData` / Linux **libsecret**）→ ② 降级 `master.key` 权限 0600。Windows 若以 LocalSystem 跑服务无用户 profile，需显式把数据目录指到 `%ProgramData%\sshmcp`（见 §8）。
- MCP 工具只接受 `name`；daemon 内用 name 查 vault 建连。**密码/密钥永远不进 MCP 参数、不进对话、不进日志**（audit 脱敏）。
- CLI 加密码**交互输入**（不回显、不落 shell history）。

---

## 7. CLI 控制面（"服务启动后注册控制命令"，打 /admin）

```
sshmcp host add    --name web --host 1.2.3.4 --port 22 --user root \
                   --auth key --key ~/.ssh/id_ed25519 [--passphrase-prompt]
sshmcp host add    --name db  --host 10.0.0.5 --user app --auth password        # 交互输入密码
sshmcp host add    --name jb  --host 10.0.0.2 --user root --auth key --key ... --proxy-jump bastion
sshmcp host remove --name web
sshmcp host list   [--json]
sshmcp host test   --name web          # 建连并回显 banner/延迟
sshmcp session list                    # 直查 daemon 的活动会话
sshmcp service install|uninstall|start|stop|status
sshmcp daemon [--foreground] [--port 8765]
sshmcp version
```
- CLI 优先打 `/admin`；daemon 未运行时**冷改** `hosts.json`+`vault.enc`，daemon 启动时加载。
- 后期扩展预留子命令：`sshmcp tunnel add --name t1 --type local|remote|dynamic ...`（工具面后续再议）。

---

## 8. 服务化

| 平台 | 方案 | 备注 |
|---|---|---|
| **Linux** | systemd unit（`Restart=always`, `RestartSec=3`, `ExecStart=node .../main.js daemon`，`User=`专用账户） | 标准 |
| **Windows** | **WinSW**（`sshmcp.xml` + `WinSW.exe`）：日志重定向、失败自动重启、开机自启 | 比 NSSM（2017 停更）新且维护中；Shawl（单 Rust 文件、winget）为备选 |

- 安装脚本 `scripts/install-service.ps1/.sh`：放置 wrapper → 注册服务 → 设自动重启策略 → 启动 → 打印 `host add` 示例与 `mcp.json` 片段。
- Windows 专用低权账户需有可加载用户 profile（`LoadUserProfile`）以用 DPAPI；或退到 `%ProgramData%\sshmcp\master.key`(ACL 限服务账户)。
- 端口/路径/日志目录集中在 `config.json`（Windows: `%ProgramData%\sshmcp`；Linux: `/etc/sshmcp` + `/var/lib/sshmcp` 或用户态 `~/.sshmcp`）。

---

## 9. 客户端接入示例（HTTP/SSE）

```jsonc
// WorkBuddy / Claude 等支持 HTTP MCP 的客户端
{
  "mcpServers": {
    "sshmcp": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <config.json 里的 token>" }
    }
  }
}
```
- token 由 daemon 首次启动生成，写在 `config.json`（0600）；`sshmcp service status` 可打印当前 url/token 提示。

---

## 10. 风险与已核事实

### 🔴 事实 1：ssh2 不支持 OpenSSH 用户证书（`*-cert-v01@openssh.com`）
- `ssh2@1.17.0` 仅支持 password / publickey / agent / keyboard-interactive / hostbased，**不支持证书**；上游 `mscdex/ssh2#1495` 长期未合。
- 你的决策：**先做密钥+密码**，证书缓做。→ 当前无阻塞。日后若要证书，只有三条路：改 Go(glider/ssh) 重写传输层 / 调系统 `ssh` 子进程（牺牲单连接多通道）/ 等 ssh2 上游。

### 🟡 事实 2：Windows 上系统 OpenSSH 的 `ControlMaster` 多路复用不支持（仅 Linux）
- 结论：**主线坚持 ssh2**（原生单连接多 channel、跨平台一致），不依赖系统 ssh 的多路复用。

### ✅ 事实 3：daemon 化恰好规避「客户端杀进程导致状态丢失」
- daemon 是系统服务，不受 MCP 客户端生命周期影响；HTTP 会话断了重连即可，daemon 里连接/会话都在。

### 其他默认（可推翻）
- 加密 AES-256-GCM + OS keychain 优先；截断 64KB(头8/尾56)；exec 靠 exit code、shell 不做完成判定（交调用方/expect）；guard 抄 atengk 8 条 + 可配白名单。

---

## 11. 里程碑（每步可独立验收）

- **M0 骨架**：`main.ts` 子命令、config、hosts store、vault（加/解密自测）。
- **M1 连接+exec**：pool + exec-channel + hostkey；`host test`、`exec` 单通道跑通（exitCode/截断）。
- **M2 shell 双通道**：shell-channel + xterm 屏 + write/read(screen|raw,since,wait,expect)/close + 背压/GC。
- **M3 HTTP+MCP**：`http/app.ts`（127.0.0.1+token）、`/mcp` 挂 MCP、8 工具接通、`/admin` 路由、`session_list`。
- **M4 CLI 全量**：host add/remove/list/test、session list。**此时已可日常用。**
- **M5 服务化**：WinSW + systemd + 安装脚本 + 自动重启策略。
- **M6 安全收尾**：guard/truncator/audit、脱敏、host key 严格模式。
- **M7 扩展**：jump host(`proxyJump` 字段已留) → 端口转发(`forwardOut`) → 反向转发(`forwardIn`)，按 ADR 增量加工具。

---

## 12. 交付物（M5 完成时）
- `sshmcp` npm 包 / 单文件 `dist/main.js`
- `sshmcp.xml`(WinSW) + `sshmcp.service`(systemd) + 一键安装脚本
- README：客户端 HTTP `mcp.json` 片段、`host add` 各认证示例、故障排查
- ADR：双通道、daemon+HTTP、凭据加密、证书短板处理
