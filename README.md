# sshmcp

有状态 SSH MCP 守护进程：**双通道**（一次性 `exec` + 持久 PTY 虚拟屏），通过 **HTTP/SSE** 暴露给 AI，用 CLI 管理主机，**AI 永远看不到密码**。

- 目标机**零侵入**：只需要原生 OpenSSH，不装任何 agent。
- 状态活在 daemon 里：跨 AI 会话/客户端重启不丢，CLI 与 AI 共享同一份会话清单。
- 单连接多通道（ssh2 原生），channel 到顶自动多连接回退。

## 架构

```
AI (MCP over HTTP/SSE) ─┐
                        ├─▶ sshmcp daemon (系统服务, 绑定 127.0.0.1)
人类 CLI (/admin) ──────┘      ├ hosts registry + 加密 vault
                               ├ ConnectionPool (ssh2)
                               │   └ 1×Client per host ─┬ exec 通道 (退出码)
                               │                        └ shell 通道 (xterm 虚拟屏)
                               └ guard / truncator / audit
```

## 安装

```bash
npm install
npm run build
```

## 快速开始

### Windows（双击即可）

- **`start-daemon.bat`** — 前台启动守护进程，日志实时打印（Ctrl+C 停止）。可带端口：`start-daemon.bat 8899`。
- **`start-oneshot.bat`** — **一次性模式**（见下），临时、随机、免登录，退出即清理。
- **`manage.bat`** — 管理控制台：**不带参数**进入交互菜单（加主机/删主机/列表/测试/会话/配置/自检/连接 CF）；**带参数**则原样透传给 CLI，例如 `manage.bat host add --name web --host 1.2.3.4 --user root --auth key --key %USERPROFILE%\.ssh\id_ed25519`。

> 菜单逻辑在 TypeScript（`sshmcp menu`）里，bat 只做透传，不在 bat 写复杂逻辑。

### 一次性模式 vs 正常模式

| | 正常模式 `start-daemon.bat` | 一次性模式 `start-oneshot.bat` |
|---|---|---|
| 本地端口 | 固定（默认 8765，可配） | **随机**（每次不同） |
| Key | 固定（`sshmcp config` 可查） | **随机**（仅在控制台打印一次，不落盘） |
| 公网入口 | 手动/默认开 CF 隧道；可选 quick 或**自定义域名(named)** | **强制免登录临时域名**（每次新 URL，出现登录也强制临时） |
| 持久化 | hosts/vault/known_hosts/审计 | **仅 known_hosts**（主机密钥）；其余全在临时目录，退出即删 |
| 运行方式 | 可前台或系统服务 | **只能前台**；`SSHMCP_SERVICE=1` 时直接拒绝 |
| 清理 | — | 退出时杀隧道、删临时目录，不留凭据 |

> 一次性模式复用正常模式已登记的主机与密钥（只读载入），不会改动主配置。

正常模式自定义域名：`manage.bat → 10 → 5` 设定 `https://你的域名`（需自己把域名 CNAME 到 CF tunnel，并 `cloudflared service install <token>` 或设 `SSHMCP_CF_TUNNEL=<tunnel名>`）。一次性模式永远走临时域名，忽略这些设置。

### 命令行（跨平台）

```bash
npm install && npm run build

# 登记主机（密码仅进加密库，交互式输入不回显）
sshmcp host add --name web --host 1.2.3.4 --user root --auth key --key ~/.ssh/id_ed25519
sshmcp host add --name db  --host 10.0.0.5 --user app --auth password

# 前台试跑
sshmcp daemon --foreground

# 交互菜单
sshmcp menu

# 注册为系统服务（开机自启 + 崩溃重启）
sshmcp service install
```


客户端 MCP 配置（支持 HTTP 的客户端，如 WorkBuddy/Claude）：

```jsonc
{
  "mcpServers": {
    "sshmcp": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <sshmcp config 里的 token>" }
    }
  }
}
```

`sshmcp config` 可打印当前 url / token / 数据目录。

## 14 个工具（有状态：会话绑定主机 + 推送下行）

| 工具 | 说明 |
|---|---|
| `host_connect(name)` | 建立/复用连接，**并绑定为当前 MCP 会话的默认主机**（再调一次即切换） |
| `host_disconnect(name?)` | 关闭连接及其所有 shell，并解绑（省略=当前绑定） |
| `exec(command, name?, timeoutMs?, cwd?, env?, rawExec?, stream?)` | 单次命令，返回 `host`/exitCode/stdout/stderr；`stream=true` 则提交即返回 `streamId`，输出走推送流 |
| `shell_open(name?, rows?, cols?, term?, env?)` | 开持久 PTY，返回 shellId/host + 首屏；省略 name 打当前绑定主机 |
| `shell_write(shellId, data)` | 写原始字符（`\n` 回车、`\x03` Ctrl+C …） |
| `shell_read(shellId, mode?, since?, waitMs?, expect?)` | `screen` 取整屏 / `raw` 取增量，默认非阻塞（拉取式，兼容不支持推送的客户端） |
| `shell_subscribe(shellId, intervalMs?, mode?, changedOnly?)` | **推送式读取**：增量经 SSE 下发。`intervalMs` 500~60000 或 0=事件驱动；`mode=raw`（增量字节，同官方 ssh）/`screen`（整屏） |
| `shell_unsubscribe(subId?/shellId?)` | 取消推送订阅 |
| `shell_close(shellId)` | 关闭单个终端（连带停其订阅） |
| `subscription_list()` | 列出活跃订阅与监听流数量 |
| `session_list()` | 列出主机与会话，含本会话 `boundHost` |
| `host_list()` | 列出所有已登记主机（含未连接） |
| `session_close(name?)` | **显式停止**：断开当前绑定主机的 SSH 长连接 + 关其所有 shell + 解绑 |
| `session_minimize()` | **最小化会话**：只解绑，连接与 shell 留在 daemon 里可复用 |

### 传输协议（新版 Streamable HTTP，2026）

- 每个 `POST /mcp` **必须带 `mcp-session-id`**；只有 `initialize` 可以不带。**不支持老的 HTTP+SSE 双端点协议，不带会话 id 一律 400，不做兼容回退。**
- 普通 JSON-RPC：响应为 JSON（`Mcp-Session-Id` 头回传会话 id）。
- 下行推送：客户端 `POST /mcp`，body 为 `{"jsonrpc":"2.0","method":"subscriptions/listen"}`，响应变成 `text/event-stream` 长流，后续所有事件都从这条流推下来：

| 推送方法 | 触发时机 |
|---|---|
| `notifications/sshmcp.stream_ready` | 流建立时的一次性 ack（含 sessionId / boundHost / 订阅数），**之后不再发** |
| `notifications/sshmcp.output` | 订阅的终端真有变化时：`{subId, shellId, mode, cursor, delta?, screen?, screenChanged}` |
| `notifications/sshmcp.exec` | `exec(stream=true)` 的输出分块：`{streamId, host, stream, chunk}` |
| `notifications/sshmcp.exit` | 流式命令结束：`{streamId, exitCode, durationMs, totalBytes}` |
| `notifications/sshmcp.error` | 流式命令异常：`{streamId, error}` |
| `notifications/sshmcp.closed` | 订阅的 shell 消失 |

> **不发心跳。** 静默期一个字节都不推 —— 只有 SSH 侧真有新数据或屏幕真有变化才透传。
> 这样 `watch 5` 就是每 5 秒真变化时推一次，AI 不会被空帧误导成"命令有输出"。

### 状态语义

- 一个 MCP 会话（`mcp-session-id`）绑定**一台**主机；`host_connect` 换别名即切换，旧主机若无活跃 shell 会被断开释放（有 shell 则只解绑，不误杀）。
- SSH 连接在 daemon 里**长驻**，直到 `session_close` / `host_disconnect` / MCP 会话销毁（DELETE 或空闲 12h）才退出；会话销毁时同时停掉它的所有推送订阅。
- 每次 `exec` 返回都带 `host` 字段，模型永远知道自己打到了哪台。

> 双通道互不共享 cwd/env：`exec` 追求干净退出码（无状态），`shell_*` 追求共享环境（持久）。这是设计使然。

## CLI

```
sshmcp host add|remove|list|test
sshmcp session list
sshmcp config
sshmcp menu
sshmcp daemon [--port 8765] [--foreground]
sshmcp daemon --oneshot --foreground      # 一次性模式（随机端口/key，免登录临时隧道）
sshmcp service install|status
sshmcp vault-selftest
sshmcp cf status|start|stop|auto on|off|mode quick|mode named <https-url>
```

## 数据与安全

- 数据目录：Windows `%ProgramData%\sshmcp`，Linux `~/.sshmcp`（可用 `SSHMCP_DATA_DIR` 覆盖）。
- `hosts.json` 只有元数据；密码/口令在 `vault.enc`（AES-256-GCM），主密钥 `master.key`(0600)。
- HTTP 仅绑 `127.0.0.1` + Bearer token。
- known_hosts TOFU 校验；`config.json` 里 `strictHostKey:true` 可强制只信任已知主机。
- 危险命令守卫（rm -rf /、mkfs、dd of=/dev/sd*、fork 炸弹等）；输出 64KB 双端截断。
- 审计写 `audit.jsonl`（不含 secret）。

## 限制（已核实）

- **不支持 OpenSSH CA 用户证书**（`*-cert-v01@openssh.com`）/ PKCS#12：`ssh2` 底层不支持。当前支持**私钥**与**密码**。若日后需要证书，需换传输实现（Go/系统 ssh），会牺牲部分单连接多通道。
- 单 host 最多 `maxConnPerHost` 条连接（默认 4），超出排队/报错。

## 自测

```bash
npx tsc -p tsconfig.json
node scripts/e2e-pool.mjs   # pool + xterm 虚拟屏 + 双通道 + 守卫（本地假 ssh server）
node scripts/e2e-http.mjs   # HTTP MCP 11 工具 + 会话绑定 + 鉴权（本地假 ssh server）
```
