# 4 个 MCP-SSH 项目源码对比

> 拉取时间：2026-11-10 · 目录：`refsrc/`
> 目的：验证「有状态会话 + 一次性 exec + 持久 PTY 写/读字符 + 虚拟屏幕」这套设想，看谁能直接抄、抄哪段。

| 项目 | HEAD | 语言 | 核心依赖 | 规模 |
|---|---|---|---|---|
| PiloTY (yiwenlu66) | 61d822b (2026-04-23) | Python | **pexpect + pyte（无 SSH 库）** | core 834 + server 1579 行 |
| mcp-server-ssh (atengk) | a815ca6 (2026-10-30) | TypeScript | ssh2 + MCP SDK | src ~9.2k 行 |
| mcp-ssh-session (DBeidachazi) | b3fce70 (2026-08-25) | Python | **paramiko + pyte** | session_manager 2705 行 |
| mcp-ssh (Pyrokine) | ca40950 (2026-11-09) | TypeScript | ssh2 + **@xterm/headless** | 仓库混杂(含 mcp-chrome)，PTY 核心 ~500 行 |

---

## ⚠️ 先纠正我上一条消息里的两处误判（看完源码后）

1. **PiloTY 不是 SSH 服务端**。它 grep 不到任何 `paramiko/asyncssh/ssh2`。它是**本地 pty**（`pexpect.spawn bash --noprofile --norc`），"连远程"是靠你在 pty 里**手敲 `ssh host`**（`tests/test_ssh.py` 就是 `pty.type("ssh -G localhost ...")`）。所以它证明了"虚拟屏+写读字符"这套，但**没有"连接主机"这个动作**，也没退出码。之前 ★★★★ 给高了。
2. **atengk 的 PTY 没有虚拟屏幕**。`session-service.ts` 只是 `buffer.push(chunk.toString())` 然后 `join("")` + 去 ANSI 返回。`top/vim` 会是一堆重绘乱码。而且它**没有独立的 read 动作**——读被塞进 `ssh_session_send`（写→等→返回本次 buffer）。之前描述里的"流式读写"要降级成"写后收一段原文"。

反过来说：**DBeidachazi 才是四个里最贴你原始设想的**（`invoke_shell` 持久 + pyte 虚拟屏 + 独立 `read_screen`/`send_keys` + 提示符捕获），只是代码臃肿。

---

## 1. PiloTY — 最好的「虚拟屏 + 完成判定」教科书

**实现**
- `core.py:PTY`：`pexpect.spawn("bash", ["--noprofile","--norc"])` 起本地终端，`pyte.HistoryScreen(cols,rows,history=5000)` + `pyte.Stream`，**每个 chunk 都 `stream.feed()`** 维持屏幕；另存一份 raw transcript 落盘。
- **完成判定 = 静默（quiescence）**：`_drain()` 一直读到"连续 `PILOTY_QUIESCENCE_MS`(默认1000ms) 没新输出"或超时为止，返回 `quiescent / timeout / eof / error`。不靠提示符正则（可选 `shell_prompt_regex`）。
- 双表示：`output`（增量文本，可选去 ANSI）+ `screen_snapshot()`（渲染屏，带 cursor_x/y）+ `get_scrollback()`。
- 状态识别 `detect_state_heuristic()`：REPL/EDITOR(nano/vim)/PAGER/PASSWORD/CONFIRM/RUNNING/READY 一张规则表；可选再用 **MCP sampling（让 LLM 看屏判断状态）**。
- 17 个工具：create_session / send_line / send_text / send_password / send_control / wait_for_output / snapshot_screen / snapshot_scrollback / clear_scrollback / wait_for_regex / wait_for_shell_prompt / get_metadata / list_sessions / configure_session / send_signal / transcript / terminate。

**可直接抄的点**
- ✅ `_drain()` 的 quiescence 循环（含"先非阻塞读一次再判断静默"的修正，否则会漏读 idle 期间到达的输出）。
- ✅ `_PyteListenerProxy`——pyte 某些 CSI handler 会带 `private=` 关键字参数、而 Screen 方法签名不一，这个适配器是真实踩过的坑。
- ✅ 状态规则表 + `send_password`（交互式 sudo/ssh 密码）+ `send_signal`（tk/`os.killpg` 发 Ctrl+C 到进程组，比写 `\x03` 更硬）。
- ✅ transcript / state.json 落盘 + `~/.piloty/active` 软链（人类可随时接管看屏）。

**不适合你的点**
- ❌ 无 SSH 连接管理、无退出码、`send_line` 只对"行命令"友好。你要"连接主机"作为独立动作，它给不了。

---

## 2. mcp-server-ssh (atengk) — 「连接池 + 双模」工程参考，但 PTY 体验不对味

**实现（这几点做得最扎实）**
- `connection/pool.ts`：ssh2 `Client` 池；`connect/disconnect/list`；默认连接路由；**熔断器**（失败进 60s 冷却，冷却期内 fail-fast 不占 socket）；**ProxyJump 跳板**（forwardOut 隧道）；`~/.ssh/config` 解析 + 凭据瀑布流（alias > 显式参数）；keepalive。
- `exec-service.ts`：`client.exec()`，默认 `bash -l -c '<cmd>'` 继承登录环境；**stdout/stderr 分开收、精准 exitCode + 耗时**；`sudo -S` 走 stdin 注密码（零命令行泄露）；超时 `stream.signal("KILL")`。
- `session-service.ts`：`client.shell({term,cols,rows})` 持久 PTY；`sendInput` = 清空 buffer → `stream.write(input)` →（`expectPattern` 正则)**或** `waitForMs`(默认1000ms)→ 返回 `buffer.join("")` 去 ANSI 截断。**无虚拟屏、无独立 read**。
- `security/guard.ts`：8 条致命命令正则（rm -rf /、mkfs、dd of=/dev/sd*、fork 炸弹、chmod 000 /、shutdown）；`truncator.ts`：64KB 头 8KB/尾 56KB 截断；`audit/` 全量审计；`target-guard.ts` 目标白名单。
- 20 个工具：ping / connect / disconnect / list_targets / list_connections / list_config_hosts / **exec** / batch_exec / **session_start/send/close** / sftp_* / job_* / tunnel_* / system_info。

**抄什么**
- ✅ `pool.ts` 的连接池 + 熔断 + ProxyJump（你要多主机、断线自愈就靠它）。
- ✅ `exec-service` 的"exec 通道拿干净退出码"整套（这正是你"直接执行"该走的路）。
- ✅ `guard.ts` 致命命令拦截 + `truncator` 双端截断（防 `cat` 大文件炸 context）。
- ✅ 关键认知印证：**exec 通道和 shell 通道在同一条 SSH 连接上是两条独立 channel，不共享 cwd/env**——所以你"直接执行"要么接受无状态，要么也塞进持久 shell 用哨兵切输出。

**别学**
- ❌ PTY 返回原文而不是渲染屏；read 融进 send；20 个工具太重（你要极简）。

---

## 3. mcp-ssh-session (DBeidachazi) — 最贴原始设想，但 2700 行巨石

**实现**
- `client.invoke_shell()` 持久 shell，按 `(host,user,port)` 寻址复用。
- **pyte 虚拟屏是真的**：`_session_emulators[key]=(pyte.Screen(100,24), pyte.Stream(screen))`，所有 recv 都 `stream.feed(chunk)`；**但默认关闭，需 `MCP_SSH_INTERACTIVE_MODE=1`**。
- **完成判定最讲究**：先 `_capture_prompt()` 用一次性 marker（`__MCP_PROMPT_MARKER_<hex>__`）跑一条命令把真实提示符抓下来，`_generalize_prompt()` 泛化成带通配的正则，之后每次命令用 `_check_prompt_completion()` 在尾部 4KB 内匹配"提示符出现"判定结束并剥离提示符。比 quiescence 准得多。
- 工具：execute_command / list/close sessions / read_file / write_file / **execute_command_async + get_command_status + interrupt** / **send_input / send_input_by_session** / **read_screen** / **send_keys**（支持 `<ctrl-c>` `<up>` `<esc>` 等 token）。
- 额外：网络设备 enable 模式（Cisco/MikroTik）、sudo、并发锁、诊断、日志轮转。

**抄什么**
- ✅ 独立 `read_screen` + `send_keys` 的**工具切分**——正是你要的"写字符/读字符"两个动作。
- ✅ **`_capture_prompt` + `_generalize_prompt` 的提示符捕获算法**——这是你做 shell 完成判定最该抄的一段（quiescence 只是退路）。
- ✅ `invoke_shell` 持久 + pyte 渲染屏的组合，证明 paramiko 路线完全可行。

**别学**
- ❌ 单文件 2705 行、异步命令/网络设备/多路 feature 堆叠，维护成本高。

---

## 4. mcp-ssh (Pyrokine) — 「PTY 读写原语」设计最干净，抄它

**实现（PTY 核心就在 `pty-manager.ts` ~450 行）**
- 底层用 `client.exec(command, { pty:{rows,cols,term:'xterm-256color'} })`——注意是 **exec+pty**（跑一条命令，如 `top`/`tmux`/`bash`），不是 `shell()`。
- **`@xterm/headless`**（xterm.js 的真核心）做渲染屏，比 pyte 准（CJK 宽字符、alt-screen 更靠谱）。
- **双缓冲**：`rawBuffer`(Buffer，字节精确，UTF-8 用 `StringDecoder` 处理跨块切分) + xterm `terminal.buffer` 屏幕。`read(mode='screen'|'raw')`，raw 可 `clear`（读后清）。
- **独立 write / read / resize / close / list**，写返回 `accepted/backpressured`。
- **背压**：pending 字符 ≥1MB `stream.pause()`，≤256KB `stream.resume()`；`idleSweeper` 1h 未读自动回收；closed 保留 5min。
- 工具组：ssh_pty_start/write/read/resize/close/list（另有大量 file/forward/connection 工具和无关的 mcp-chrome 目录，忽略）。

**抄什么**
- ✅ **整个 `pty-manager.ts` 的骨架**——这就是你要的"虚拟屏 + 写字符 + 读字符（screen/raw 双模）"最干净的实现：独立 read/write、字节精确 rawBuffer、StringDecoder、背压、idle GC。
- ✅ `read(mode=screen|raw)` 的双模语义——全屏 TUI 读 screen、文本流读 raw。
- ✅ xterm/headless 优于 pyte 的选型（TS 栈）。

**注意**
- ⚠️ exec+pty 需要给一条命令；要"登录级交互 shell"得显式跑 `bash`/`tmux`，不像 `shell()` 那样天然是登录会话。对你"连上就是一台虚拟屏"的目标，用 `shell()` 更顺（atengk/DBeidachazi 那样）。

---

## 三个共性难题（四家都在解，你也会撞上）

1. **命令完成判定**——三种流派：
   - quiescence 静默（PiloTY）：简单、对 TUI/持续输出友好；但慢命令中途静默会**提前返回**，且总要多等 1s。
   - 提示符捕获+正则（DBeidachazi）：对 shell 最准，代价是处理复杂 PS1/颜色/多行提示符（marker 技巧先抓一次）。
   - 写后 sleep / expectPattern（atengk）：最原始、最不稳。
   → 你要"写字符/读字符分离"，**正解是把完成判定从 write 里拿出来**：`read` 只取增量或取屏、**不阻塞**；另给可选 `wait_for(prompt|regex|quiet)`。别把"等结束"塞进 write。
2. **渲染屏**：pyte（Python、轻、好改）vs @xterm/headless（真 xterm 核心、最准）。要虚拟屏这层必须有，别用去 ANSI 的原文糊弄（TUI 会烂）。
3. **UTF-8 跨块切分**：多字节字符被 TCP 分块切断会乱码。Pyrokine 用 `StringDecoder` 明确处理，这是隐蔽但必踩的坑。

---

## 结论：你的"极简自写"该怎么拼

**没有任何一个是你要的那个极简形态**，但零件全齐、且都被生产验证过：

| 你的动作 | 直接抄谁 |
|---|---|
| `host_connect` / `host_disconnect` | atengk `pool.ts`（连接池+熔断+ProxyJump+ssh config） |
| `exec`（一次性，要退出码） | atengk `exec-service.ts`（exec 通道，stdout/stderr/exitCode 分离 + 64KB 截断 + 致命命令拦截） |
| `shell_open`（持久，出虚拟屏） | Pyrokine `pty-manager.ts` 骨架（xterm 屏+StringDecoder+背压） 或 DBeidachazi 的 `invoke_shell`+pyte |
| `shell_write(chars)` / `shell_read(mode=screen\|raw)` | Pyrokine 的独立 write/read 双模；完成判定参考 DBeidachazi `_capture_prompt` |
| 安全 | atengk `guard.ts` + `truncator.ts` |

**技术栈二选一**
- Python：`paramiko + pyte`（DBeidachazi 已验证）。改起来最快、最贴合你"极简可控"。
- TS：`ssh2 + @xterm/headless`（Pyrokine/atengk）。屏最准。

**建议工具面（7 个，别贪多）**：`host_connect` / `host_disconnect` / `exec` / `shell_open` / `shell_write` / `shell_read(mode,since,wait?,expect?)` / `session_list`。

**把握度**：可行性与"照抄可行性"可断言（源码已读完、依赖已确认）。未核验：① 你这套机器 OpenSSH 版本对并发 channel 的限制；② 你当前 WorkBuddy 客户端会不会在轮次间杀 MCP 进程（直接决定"有状态"能否成立）——这两条要自己实测。
