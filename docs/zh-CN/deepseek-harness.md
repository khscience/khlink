# DeepSeek Harness 桌面端接入

KH Link 从 0.1.227（连接器 0.2.76）起支持把 **DeepSeek Harness 桌面端**作为第五个 Agent 页。与 Codex、Claude 一样，手机和电脑操作的是同一批会话；与 Pi 不同，DSH 不需要 KH Link 另起一个 Web 进程。

## 为什么需要一个小桥接插件

DSH 桌面端启动的本地 Host API 只把带一次性启动令牌的地址交给 Electron 渲染进程，外部进程没有公开入口。连接器会在 DSH 的 Desktop profile 中安装一个很小的桥接插件（`fengzhu-connect/dsh-bridge`）：

1. 插件运行在 DSH 桌面端进程内，读取 `ctx.webServer.port` 和 `ctx.connection.authenticatedUrl()`；
2. 把带启动令牌的 loopback 地址写到 `%LOCALAPPDATA%\KH Link\dsh-desktop-bridge.json`（每 20 秒刷新，DSH 退出时删除）；
3. KH Link 连接器读取该文件，用 `/connect` 换取本地 API 会话，然后通过 DSH 的 Remote API 读取会话、发送、停止、重命名和归档。

插件只发布 Host 地址，不读取会话正文，也不读取任何厂商凭据。令牌只在 `%LOCALAPPDATA%\KH Link` 和连接器内存中，不上传、不写日志、不转发给手机。

## 自动安装

连接器启动时调用 `ensureDshBridge()`：

- 目标目录：`$DSH_HOME/profiles/node_modules/kh-link-dsh-bridge`（`$DSH_HOME` 缺省为 `~/.dsh`）；
- 目标 profile：`$DSH_HOME/profiles/desktop/cordis.patch.yml`，追加一段带注释的：

```yaml
# KH Link desktop bridge (managed by khLink; remove this row to disable)
- insert:
    - id: kh-link-dsh-bridge
      name: kh-link-dsh-bridge
```

文件内容不变时不会重写，避免 DSH 无意义地热重载。DSH 的 HMR 会在运行中挂载新行；没有运行中的 DSH 时，下次启动生效。删除上面那段即可完全停用。

## 手机上的功能

| 功能 | 状态 |
| --- | --- |
| 会话列表、标题、工作目录、运行/等待状态 | 支持 |
| 桌面/手机状态一致 | 支持；审批从 `approval/asked` / `approval/decided` 审计事件映射为“电脑端等待审批”，问题映射为“电脑端等待回答”；连接器重启时会补读已经打开的审批 |
| 历史同步（用户消息、模型文本、思考、工具调用与结果） | 支持 |
| 发送、继续对话 | 支持 |
| 停止当前轮 | 支持（`session/cancel`） |
| 新建会话（指定工作目录） | 支持 |
| 重命名 | 支持 |
| 归档、取消归档 | 支持（`workspace/archiveSession` / `unarchiveSession`），桌面端归档也会同步 |
| 桌面置顶 / 手机置顶 | 支持；读取 DSH `workspace.json` 的 `pinnedSessionIds`，手机“置顶”分组带图钉，手机长按可置顶/取消置顶；长按菜单里还能批量勾选 |
| 最近分组 | 支持；与 Codex/Claude 同一套“最近”规则：运行中、等待回答、刚完成且还没在手机点开；已点开的完成会话只留在“最近对话”。DSH 的运行中会话排在最近最前 |
| 余额 | 支持（Platform 钱包 `account/getBalance`，CNY/USD）；DSH 页顶部用单行摘要同时显示余额、今日花费和起算时间 |
| 今日花费 | 支持；用当天钱包余额差计算人民币。跨天运行从 0 点算；首次当天启动会显示“自 HH:mm”，避免把启动前的花费算进来 |
| 模型与思考强度 | 支持；会话顶部打开 DSH 设置，选择 provider/模型/effort，下一轮生效 |
| 权限模式 | 支持；会话顶部 DSH 设置里选择 read-only / workspace-write / danger-full-access / auto，通过 DSH Host 的 `/permission` 命令立即切换当前会话；新会话默认沿用 DSH 的 workspace-write |
| 图片附件 | 支持（发送给支持图片输入的模型，如 deepseek-flash）；deepseek-v4-pro 不支持图片时会明确报错，不会假装已发送 |
| `ask_user_question` / 审批 | 支持；会话顶部“回答”读取 DSH 桌面窗口里的选项，手机点选后在桌面窗口代答。连接器会先把最小化/后台的 DSH 窗口恢复并置前；只支持当前显示的单题选项/审批按钮，自定义文本答案仍需在桌面输入 |
| 分叉、回滚、手动压缩上下文 | 暂不支持 |

## 排查

- **DSH 页一直灰色/没有会话**：确认电脑上 DSH 桌面端已打开；检查 `%LOCALAPPDATA%\KH Link\dsh-desktop-bridge.json` 是否存在且 `updatedAt` 在 1 分钟内。
- **桥接文件不存在**：查看 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 是否有 `kh-link-dsh-bridge` 行，以及 `$DSH_HOME/profiles/node_modules/kh-link-dsh-bridge` 是否存在；重启连接器会重新安装。DSH 需要重启或等待 HMR。
- **连接 401**：DSH 重启后启动令牌会变化；桥接插件会在新进程里刷新文件，连接器下一次轮询会重新 `/connect`。若仍失败，重启 DSH 桌面端。
- **权限/审批弹窗在电脑端没有反应**：先确认弹窗属于当前 DSH 工作区，且不是被最小化或被其他窗口遮挡；连接器会尝试恢复并置前 DSH 窗口。若卡片在另一个工作区，先在 DSH 切到该工作区再点手机“回答”。手机端权限模式在会话设置里改，不需要等桌面弹窗。
- **不要**把 `dsh-desktop-bridge.json` 发给别人：其中的 URL 等同于本机 DSH 的操作权限。

## 版本

- Android `0.1.227 (228)` 起显示 DSH 页；
- 连接器 `0.2.76` 起包含 `dsh-bridge` 插件和 DSH 后端；
- Android `0.1.311 (312)` / 连接器 `0.2.135` 起，DSH 会话设置可切换权限模式；审批读取前会恢复并置前 DSH 窗口。
