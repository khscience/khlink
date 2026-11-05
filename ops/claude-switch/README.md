# KH Link 本地 Claude 账号切换

设计与验收以 [主文档](../../docs/zh-CN/claude-account-switch.md) §3.5 为准。
目前只支持已核对的 Windows 商店版 Claude Desktop 2.37337.1.0，以及 G 盘的两个本人 profile。
已集成 KH Link 桌面控制台 0.1.7：左侧「Claude 账号」管理两个已登记账号，点击「切换到此账号」即可正常退出、同步并启动。新增账号的首次登录与初始接管仍由本人完成。

## 工作方式

每次本人确认并正常退出 Desktop 后，把当前 profile 的 Code 索引变化同步至共享副本和另一个 profile，
再切换原 MSIX 数据 Junction。正文继续使用原来的本机 Claude Code projects，索引文件不改写。
只同步本机配置明确选中的 account/org 目录，其他历史目录不合并。

- 新会话、标题、续聊后的元数据和归档状态，在下次切换时同步。
- 删除的索引保留事务备份后从其他副本撤出，避免重新出现；工具不删除正文。
- 定时任务、Chat/Cowork、用量、登录、Magpie 不参与同步。
- 远程/暂存导入/待自动启动等未验证会话、冲突、未知版本和目录链接，会阻止切换。
- Desktop 或 profile 辅助进程仍在运行时禁止同步；独立 npm CLI 不会被关闭或修改。
- 底层脚本不关闭或启动应用；控制台按钮负责官方正常 Exit 和启动。本人点击切换即授权这次正常退出；请先保存工作。运行中任务的退出确认、目录信任和登录均需本人处理，工具不代点。
- 不发送消息、不点击续聊或信任；首次验收由本人打开旧会话并手动续聊。

## 本机首次初始化

配置只保存在 G 盘，account/org 目录来自已确认的本机会话索引，不从凭据推算，不进 Git。
本次配置位于 G:\Apps\ClaudeSwitch\shared\config.json。

只读预览：

    node ops\claude-switch\session-share.cjs plan --config G:\Apps\ClaudeSwitch\shared\config.json --from primary --initialize

获得本次许可、正常退出、进程检查通过后初始化：

    node ops\claude-switch\session-share.cjs init --config G:\Apps\ClaudeSwitch\shared\config.json --from primary --owner-confirmed-exit

参数只是操作人记录，不能代替真实的本人许可。工具会检查官方包版本、当前 Junction 和进程。
写入前的文件保存在 G:\Apps\ClaudeSwitch\shared\transactions\<事务号>\before，逐文件校验摘要后才写入。
首次源索引另存于 G:\Apps\ClaudeSwitch\p0\20261015-code-sharing\source-index-backup；
最早的完整备份 backup\20261014-2303\Claude 保持不变。

## 以后切换

本人保存工作并允许本次正常退出，等待 Desktop/profile 辅助进程退出后：

    & ops\claude-switch\switch-profile.ps1 -From primary -To secondary -OwnerConfirmedExit

回原账号时对调 From 和 To，并取得那一次的新许可。同步失败时原 Junction 保持不变。
成功后再正常打开已安装的官方 Desktop。文件一致不等于已通过官方客户端的续聊验收。

不要直接改 Junction 绕过同步。非活动 profile 有独立改动时，工具会保留两边并报告冲突，
不能按 mtime 强行覆盖。Chrome Native Host 占用由本人正常断开或退出 Chrome，不杀进程。

## 回退和异常恢复

正常退出并再次确认后，使用当前活动 profile、初始化配置和本机记录的事务号：

    node ops\claude-switch\session-share.cjs rollback --config G:\Apps\ClaudeSwitch\shared\config.json --from secondary --transaction <事务号> --owner-confirmed-exit

有中断事务时用 recover 替代 rollback，省去 --transaction。回退前核对所有目标是否仍等于事务前或事务后摘要，
已有新变化就停止，不覆盖新工作。整个应用数据回退仍按主文档 §4.3 执行。

如果进程意外退出留下 operation.lock / switch.lock，先确认其他同步进程已退出，
再仅移除对应锁文件并恢复事务；不自动清锁。备份阶段中断、日志尚未写成时，保留目录并人工核对，
不能补一个成功标记。应用自行重启、其他工具同时改文件时，可能需要停止并人工恢复。

## 本地验证

    node --test ops\claude-switch\session-share.test.cjs

测试只使用 G 盘 test-fixtures 内的合成文件，覆盖双向更新/归档/删除、白名单隔离、
冲突、路径穿越、链接、旧快照、异常回退和新数据保护，不加载真实账号配置。

## 置顶与用量

- 置顶成员、显示顺序和置顶区排序方式都随切换同步。仅处理共享 Code ID，其他 Chat/Cowork 与未登记的账号不动。
- 官方程序将同一份 UI 偏好保存在 native 配置、Local Storage 镜像和 IndexedDB 的 Code pin-state 中；同步覆盖这几处，记录事务，写后验证。native 配置只改白名单 UI 值，其他字节保持原样。
- IndexedDB 使用官方 LevelDB 日志格式做精确键缓存撤出，让官方程序从已同步的偏好重新加载。校验 CRC、完整记录、原文件摘要；中断可回退，已出现新数据则拒绝覆盖。当前只核实过 WAL 布局；若后续出现 SST 压缩布局，停止切换并提示更新，绝不换用错误比较器打开数据库。
- 每个账号的 5 小时/本周比例与重置时刻，来自官方程序已经取得并保存在本地的 usage 响应、历史样本或官方状态栏回调。没有网络客户端，不发模型消息，不读 Cookie/Token。
- usage 缓存只读取目标组织的精确响应体；二进制响应时间前缀的读取到 HTTP 头开始前停止。缓存的创建时间不代表数据新鲜度，使用原始响应时间；超过 30 分钟或已到重置时刻标记历史。
- 0% 用量且官方没有给重置时间时显示「尚未开始本轮计时」。不人为计算下一周期。

## 运行与构建

安装包携带这些脚本及 classic-level 依赖，运行需本机 Node.js。数据、事务和地址提示都位于 G:\Apps\ClaudeSwitch，安装包不含任何 profile、登录文件或真实账号映射。异常日志只返回可操作的错误，不输出原始缓存或登录数据。

测试：`node --test ops/claude-switch/*.test.cjs kh-link-desktop/test/flows.test.cjs`。
