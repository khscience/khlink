# khLink 接入 Hermes Agent

2026-10-25 起（Android 0.1.264 / 连接器 0.2.96），khLink 多了 Hermes 标签：手机可以看 Hermes 的会话、发消息、看流式回复和工具进度、回答授权、切换模型和专家会诊，并直接用 `/goal`、`/loop`、`/kanban`、`/moa` 等 Hermes 命令。

## 选型：ACP + 只读会话库，不用 OpenAI 兼容接口

Hermes 有三种对外协议：OpenAI 兼容 API（`127.0.0.1:8642`）、TUI 网关 JSON-RPC、ACP（`hermes acp`）。khLink 选 ACP 写、会话库读：

- **`hermes acp` 附着到正在运行的 hermes-gateway**（`GatewayACPAgent`）。票据走 gateway 的本机私有控制套接字，**khLink 不需要读 `HERMES_API_KEY`**，符合“不读取、不传输凭据”。
- **斜杠命令真正执行**：ACP 自己回答 help/model/status/usage/queue/steer 等，其余命令（`/goal`、`/loop`、`/kanban`、`/moa` …）交给 gateway 的 `slash.exec`。实测 REST `/api/sessions/{id}/chat/stream` 不执行斜杠命令，只会让模型解释它。
- **授权**：gateway 的编辑/命令审批变成 ACP `session/request_permission`，连接器转成手机上的等待卡片（选项译成中文：允许这一次 / 本会话内都允许 / 以后都允许 / 拒绝 / 以后都拒绝）。没有手机能回答时（找不到会话）直接拒绝，不让 Hermes 卡住；手机一直不回答，gateway 300 秒后按拒绝处理。
- **模型**：ACP 会话的模型列表里有 `moa:panel`、`moa:quick` 两个专家会诊预设，`session/set_model` 切换，下一条消息起生效。
- **历史读 `~/.hermes/state.db`（只读）**：ACP 的 `session/list` 只列 `source=acp` 的空壳会话，真正有内容的会话 source 是 `local`；所以列表和历史由 `hermes-store.py`（系统 python3 + sqlite3，`mode=ro`）读取。每条历史项的 id 就是消息行号，重复同步只更新、不重复。压缩产生的续接会话折叠到根会话。

## 连接器结构

| 文件 | 作用 |
| --- | --- |
| `fengzhu-connect/src/backends/hermes-transport.js` | 到 Hermes 主机的两种通道：本机 WSL（`wsl.exe -d <发行版> -u <用户> -- bash -lc …`）或开发用的 `ssh <主机> …`。读 `%APPDATA%\FengzhuAgentBridge\hermes.json`，没有这个文件就不启用 Hermes。 |
| `hermes-acp.js` | 常驻 `hermes acp` 子进程，JSON-RPC；`session/cancel` 是通知；未知的服务端请求立即回 -32601。 |
| `hermes-store.py` | 只读列出会话和消息。 |
| `hermes-sync.js` | 轮询（5 秒，运行中 1.5 秒）、历史映射、手机命令、授权、文件回传、流式“正在写”行。 |

`hermes.json` 示例（3060）：

```json
{ "transport": "wsl", "distro": "Ubuntu", "user": "ubuntu", "label": "3060" }
```

可选字段：`hermesBin`（默认 `~/.local/bin/hermes`）、`python`（默认 `python3`）、`home`（Hermes 主目录）。环境变量 `HERMES_TRANSPORT` 可代替文件（JSON）。

## 历史映射要点

- 用户消息、思考、回复、工具调用（按 call_id 更新为完成/失败）、`display_kind` 为 hidden/internal 的不显示。
- 排序：每条存储消息占 100 个位置（`SLOTS`），本地补的命令行在 60 起，“正在写”行在 99。
- **流式**：手机发起的一轮里，ACP 的文字片段约每 1.2 秒写入一个 `-live` 行；存储的回复一到就把它改成 `type: hidden`（手机丢弃，Android 0.1.264 起同时从屏幕上的旧副本里移除）。所有 live 行上传串行执行，避免晚到的旧文字覆盖隐藏。
- **斜杠命令**：Hermes 只存命令的效果（目标的各轮、会诊的问答），不存命令本身；连接器在发送时就补一行用户消息“/goal …”，放在 Hermes 接下来存的内容之前，并用它结清手机的发送回执；Hermes 随后把命令参数当用户消息再存一遍时跳过这一行；ACP 自己回答的命令（/status、/usage、/kanban list 等）把回答也补成一行。
- **图片/文件回传**：工具结果或回复里出现的 WSL 绝对路径（截图、图表、PDF；文档类只认回复里点名的），在第一次看到时复制到 `%LOCALAPPDATA%\khLink\hermes-files`（不能放在连接器配置目录，那里手机读文件会被凭据保护拒绝），作为 `sentFiles` 项显示；同一会话里内容相同的图片只显示一次。
- **手机发图**：图片作为 ACP image 块发出；Hermes 历史里存的是“[The user sent an image~ …描述…]”和缓存路径，连接器去掉这两段，只显示用户的话，并把缓存里的图片读回来放进用户气泡（最多 4 张、每张约 1.4 MB 内）。非图片附件复制到 Hermes 主机 `/tmp/khlink-uploads/` 并在文字里给出路径。
- 运行中再发：普通消息用 `/queue`（停止后接着做）或 `/steer`（插入当前轮）；斜杠命令原样发送（gateway 在忙时也会分派）。

## 手机端

- 标签：Hermes 默认在第四位（替换反重力；已自定义 4 个都不含反重力的，不改动，可在齿轮里加）。
- 输入框上方命令条：目标 /goal、循环 /loop、看板 /kanban、会诊 /moa（弹框填内容，带“查看/暂停/继续/清除”等快捷按钮），状态 /status、用量 /usage、压缩 /compress（点了直接发）。
- 会话顶部“Hermes · 模型”打开模型与专家会诊选择。
- 新建任务选 Hermes 时，工作目录自动换成最近用过的 Linux 目录（留空用家目录）。

## 边界

- Hermes 的代理桌面（Xvnc :20）截图来自 Hermes 自己的工具（browser_exec 等）；手机只展示它产生的图片文件，不直连 VNC。
- 其他界面（CLI、Hermes 桌面版、看板 worker）的任务，支持新版网关执行记录时优先按实际状态判断；长时间没有新消息也会保持“运行中”。网关明确记录中断、取消或失败时保留对应状态，排队或执行状态未知时不推断为已完成。旧版 Hermes、没有网关执行记录的会话仍按最近 3 分钟内的消息推断，可能不够准确；停止按钮只对手机发起的这一轮可靠。
- 归档：Hermes 没有单个会话的归档命令，khLink 只在自己这边记归档；置顶、改名调用 `hermes sessions pin/unpin/rename`。
