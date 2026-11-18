# macOS 连接器（第一版，2026-11-14 起）

Mac 上不装桌面控制台，只运行 khLink 连接器（`fengzhu-connect`）。手机远程使用 Mac 上的命令行智能体：Codex CLI、Claude Code CLI 和 Hermes。Claude/Codex 桌面 App 的界面遥控在 Windows 上靠 UI Automation 实现，Mac 版暂时没有。

## 组成

| 部分 | Windows | macOS |
| --- | --- | --- |
| 账号登录、共享密钥交接 | 桌面控制台（Rust） | `node src/cli.js login`（`src/account-login.js`） |
| 配置与本地密文 | DPAPI | AES-256-GCM，主密钥存在登录钥匙串（`src/mac-secret-store.js`，服务名 `khLink`） |
| 配置目录 | `%APPDATA%\FengzhuAgentBridge` | `~/Library/Application Support/FengzhuAgentBridge` |
| 程序目录 | `%LOCALAPPDATA%\khLink\connector` | `~/Library/Application Support/khLink/connector/app` |
| 常驻方式 | 计划任务 | LaunchAgent `com.khlink.connector`（登录 Mac 后自动运行，退出后 20 秒重启） |
| 连接器自动更新 | 桌面控制台（`connector_update.rs`） | LaunchAgent `com.khlink.update` 每 6 小时运行 `khlink-macos.sh update --auto`（`src/self-update.js`） |
| 桌面 App 遥控、锁屏提醒、桌面适配器 | 有 | 关闭 |

## 安装

要求 macOS（Apple 芯片或 Intel）和 Node.js 22 或更新版本。连接器发布包 `fengzhu-connect-<版本>.tgz` 里带了脚本 `scripts/khlink-macos.sh`：

```bash
mkdir -p /tmp/khlink && tar xzf fengzhu-connect-<版本>.tgz -C /tmp/khlink
bash /tmp/khlink/package/scripts/khlink-macos.sh install
bash /tmp/khlink/package/scripts/khlink-macos.sh login
bash /tmp/khlink/package/scripts/khlink-macos.sh start
```

装好以后脚本也在 `~/Library/Application Support/khLink/connector/khlink-macos.sh`，还可以用 `status`、`update`、`autoupdate on|off`、`stop`、`uninstall`（卸载时保留账号数据）。

- `login` 会打开浏览器登录 khQuant 账号并授权，服务器端授权会话 **5 分钟**内有效。账号里已经有别的电脑时，这台 Mac 要等另一台电脑上的连接器把共享密钥交过来，所以**至少要有一台老电脑的连接器在线**（同 [多台电脑](multi-pc.md)）。
- 回调地址是 Mac 本机的 `127.0.0.1:<随机端口>`。如果在别的电脑浏览器上授权，需要先把这个端口转发到 Mac，例如 `ssh -L <端口>:127.0.0.1:<端口> <mac>`。
- 钥匙串在纯 SSH 会话里是锁着的，所以脚本通过 LaunchAgent 在 Mac 的图形会话里运行 `login` 和连接器，从 SSH 执行也可以。Mac 必须有用户登录着；只开机、停在登录界面时连接器不会运行。
- LaunchAgent 的 PATH 会自动加上 Node 所在目录，以及 `~/.local/bin`、`~/.local/npm/bin`、`~/.npm-global/bin`、`/opt/homebrew/bin`、`/usr/local/bin`。智能体装在别的地方时，装好后要重新运行 `start`。

## 自动更新

`start` 同时注册 LaunchAgent `com.khlink.update`，每 6 小时检查一次；`update` 立即检查，`autoupdate off` 关闭（`start` 之后也保持关闭），`autoupdate on` 重新打开。日志在 `~/Library/Application Support/khLink/connector/logs/com.khlink.update.log`。

- 与 Windows 用同一份签名更新清单的 `windowsConnector`（就是通用的连接器包）。同时读 GitHub、jsDelivr 和中转服务器三处清单，验 Ed25519 签名，取版本最新的一份（防 CDN 缓存滞后）；下载后核对 SHA-256，解压到 `connector/update/staged-<版本>`。
- 电脑上有任务在运行或消息在发送（状态文件 `restartSafe=false` 或 `inFlightCommands>0`）时不更新，等下一次检查。
- 替换 `package.json src scripts native dsh-bridge`，`node_modules` 保留；依赖变了才重新 `npm install`。然后写 `reload.request`，由 supervisor 只换连接器进程（Codex 宿主不断）。
- 90 秒内状态文件没出现新版本（且进程号换了）就放回旧版本并重启 LaunchAgent。
- 更新任务运行的是 `connector/khlink-macos.sh` 这份拷贝，每次成功更新后换成新包里的脚本。
- 0.2.165 及更早装的 Mac 没有这个功能，要用新包手动执行一次 `install` 和 `start`。

## 智能体

- Codex：使用 PATH 里的 `codex`（`codex app-server`），登录状态由 Codex 自己管理。
- Claude Code：使用官方 `claude` 命令行，登录要用户在 Mac 终端里运行 `claude` 自己完成。khLink 不读取凭据。
- Hermes：使用 `~/.local/bin/hermes`。

## 已知边界

- 不支持 Claude/Codex 桌面 App 遥控，不支持锁屏提醒和保持唤醒。
- 暂时没有图形安装包；更新在后台进行，没有提示界面。
- 只在 macOS 26.3（Apple 芯片，Node 22.17）上实测过。
