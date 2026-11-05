# 一体化安装包：桌面控制台 + 连接器

2026-10-18 起，khLink 的桌面控制台和后台连接器打成一个 NSIS 安装包。用户下载一次、安装一次，不再需要先装 Node.js、再单独注册连接器。

## 设计

一个安装包，两个进程：

- 桌面控制台：Tauri 窗口/托盘，负责账户登录、二维码配对、设备管理、诊断和「重新连接」。
- 连接器：随包安装的 Node 运行时 + `fengzhu-connect` 源码 + 生产依赖，注册为当前用户的计划任务 `FengzhuAgentBridge`。关闭桌面窗口不影响手机连接。

安装位置：

```text
%LOCALAPPDATA%\khLink\
  kh-link-desktop.exe
  connector\
    node.exe
    src\cli.js
    node_modules\
    connector-task.ps1
```

数据仍在 `%APPDATA%\FengzhuAgentBridge\`（配置、日志、发送回执等），升级或卸载程序不会删除。

## 安装、升级、卸载

- 安装：NSIS 复制桌面和连接器，`POSTINSTALL` 调用 `connector-task.ps1 -Action install`，注册计划任务（登录触发 + 每 2 分钟看门狗、Priority 5）并启动。
- 升级：`PREINSTALL` 先停止正在运行的一体化连接器，避免 `node.exe`/原生模块被占用；`POSTINSTALL` 重新注册并启动。旧的两套安装（桌面 + 源码连接器）升级时会先停掉旧任务及其 Node 进程，再切到包内连接器。
- 卸载：`PREUNINSTALL` 停止并删除计划任务，NSIS 删除安装目录，保留 `%APPDATA%\FengzhuAgentBridge` 数据。
- 任务脚本支持手动执行：`connector-task.ps1 -Action install|start|stop|remove`，以及 `-NoAutoStart`、`-NoStart`、`-NoMcpInstall` 测试开关。

## 构建

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ops\build-combined-installer.ps1
```

脚本会从 `releases\fengzhu-connect-*.tgz` 取最新连接器包，解压到 `.build\connector-payload`（已 gitignore），安装生产依赖，复制当前 `node.exe` 和 `ops\connector-task.ps1`，再以 `src-tauri\tauri.combined.conf.json` 构建带连接器资源和 NSIS 钩子的安装包。

脚本同时复制 `ops\run-program-hidden.vbs`：计划任务通过 `wscript.exe` 隐藏启动 `node.exe`，登录时不会弹出控制台窗口，退出码照常回传给任务计划程序。

Git Bash 里运行时 PATH 中的 GNU tar 会把 `D:\...` 这类路径当成远程主机而解压失败，请在 PowerShell 中运行构建脚本。编译目录默认是 `$env:CARGO_TARGET_DIR`，没有设置时用 `.build\cargo-target`，也可以用 `-CargoTargetDir` 指定。

安装包名为 `khLink_<版本>_x64-setup.exe`，产物在编译目录的 `release\bundle\nsis\` 下。

## 连接器更新（0.1.20 起）

一体化包里的连接器可以单独升级，不必重装整个安装包。桌面端启动时和之后每 6 小时检查一次已签名的更新清单 `update-manifest.json`；`windowsConnector` 比本机新时，“本机状态”里出现“连接器 x → y　更新”。点击后：

1. 校验清单的 Ed25519 签名（公钥同 `releases/update-signing-public.pem`），下载连接器 tgz 并核对 SHA-256。
2. 解压到 `%LOCALAPPDATA%\khLink\connector-update\staged-<版本>`，确认版本号和 `src\cli.js`；`dependencies` 与已装版本不同就拒绝，提示下载新安装包（不在用户电脑上执行 npm）。
3. 连接器报告 `restartSafe=false` 或仍有 `inFlightCommands` 时拒绝，等手机任务结束。
4. `connector-task.ps1 -Action stop`，把包里的顶层目录和文件换进去，旧的放到 `connector-update\previous`；`node.exe`、`node_modules`、`connector-task.ps1`、启动脚本保持不动。
5. 启动任务，60 秒内 `status.json` 必须报告新版本；否则放回旧代码并重启。

只有计划任务实际运行的是安装包里这一份连接器时才提供更新；开发机让任务指向源码连接器时，更新行不显示。新的桌面端版本只提示下载，不自动安装。

## 验证

在 Windows 沙盒中验证过静默安装、检查和卸载：安装后桌面和连接器文件齐全，计划任务指向包内的 `node.exe` 和 `cli.js`，连接器日志正常创建；卸载后任务和安装目录被删除，`%APPDATA%\FengzhuAgentBridge` 保留。

## 边界

- 连接器更新需要用户点击，不会在后台自动替换；依赖变化的连接器版本仍需新安装包。
- 回滚只有单元测试覆盖，没有做过新连接器起不来时的端到端回滚。
- 开发时如果让计划任务指向源码里的连接器，桌面端不会提供连接器更新；`ops\restart-connector.ps1` 只重启源码连接器。
- 连接器任务仍是每用户计划任务，不需要管理员；换用户登录需要各自安装/注册。
