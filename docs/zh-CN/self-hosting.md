# 自己部署中转

不想用官方服务，可以把中转（`fengzhu-server`）部署在自己的服务器上。这种方式用一个服务器密码登录，不需要 khLink 账号，也不需要会员。手机 App 和连接器都可以用官方安装包，也可以自己编译。

[English](../self-hosting.md)

## 你需要准备

- 一台 Linux 服务器，装好 Node.js 22 和 nginx，有一个指向它的域名和 HTTPS 证书（例如用 certbot 申请）。
- 一台 Windows 电脑，装好 Node.js 22 和要连接的智能体（例如 Codex）。
- 一部安卓手机。

下面用 `bridge.example.com` 代表你的域名，中转挂在 `/fengzhu-bridge/` 路径下。

## 一、部署中转

1. 在服务器上取代码、编译：

   ```bash
   sudo mkdir -p /opt/fengzhu-agent-bridge && sudo chown "$USER" /opt/fengzhu-agent-bridge
   git clone <本仓库地址> /opt/fengzhu-agent-bridge
   cd /opt/fengzhu-agent-bridge
   npm ci
   npm run build
   ```

2. 建一个运行用的系统用户和数据目录：

   ```bash
   sudo useradd --system --home /var/lib/fengzhu-agent-bridge --shell /usr/sbin/nologin fengzhu-bridge
   sudo install -d -o fengzhu-bridge -g fengzhu-bridge -m 700 /var/lib/fengzhu-agent-bridge
   ```

3. 写配置文件 `/etc/fengzhu-agent-bridge.env`（权限设为 600，只给 root 读）：

   ```ini
   # 签发登录令牌用的密钥，至少 32 字节随机数的 base64：openssl rand -base64 32
   TOKEN_SIGNING_KEY=<随机密钥>
   # 服务器密码，至少 16 个字符。只在第一次启动时读取，之后保存为数据库里的校验值
   FENGZHU_ADMIN_PASSWORD=<你的服务器密码>
   SQLITE_PATH=/var/lib/fengzhu-agent-bridge/fengzhu-bridge.db
   PORT=8110
   ```

   第一次启动成功后，可以把 `FENGZHU_ADMIN_PASSWORD` 从文件里删掉。

4. 安装并启动 systemd 服务：

   ```bash
   sudo cp ops/fengzhu-agent-bridge.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now fengzhu-agent-bridge
   systemctl status fengzhu-agent-bridge
   ```

   中转只监听 `127.0.0.1:8110`，由 nginx 对外提供 HTTPS。

5. 配置 nginx：以 `ops/nginx-bridge.conf` 为模板，把 `server_name` 改成你的域名，并加上 HTTPS（`listen 443 ssl` 和证书路径，或者让 certbot 自动改）。模板里已经包含 WebSocket 转发、登录接口限流和上传大小限制。`/fengzhu-bridge/downloads/` 那一段是官方发布更新用的，自己部署可以删掉。

6. 检查：

   ```bash
   curl https://bridge.example.com/fengzhu-bridge/healthz
   ```

   返回 200 就说明中转可以访问了。

7. （可选）每天备份加密数据库：见 `ops/backup.sh`、`ops/fengzhu-agent-bridge-backup.service` 和 `.timer`。

## 二、配置电脑上的连接器

在 Windows 电脑上，用 PowerShell：

```powershell
git clone <本仓库地址> khlink
cd khlink
npm ci
$env:FENGZHU_BRIDGE_PASSWORD = '<你的服务器密码>'
node fengzhu-connect\src\cli.js setup --server https://bridge.example.com/fengzhu-bridge
Remove-Item Env:FENGZHU_BRIDGE_PASSWORD
powershell -NoProfile -ExecutionPolicy Bypass -File ops\install-connector.ps1 -EnableAutoStart
```

- `setup` 会生成这台电脑的账户密钥，用服务器密码加密后交给中转保存，然后把配置写到 `%APPDATA%\FengzhuAgentBridge\config.json`（受 Windows DPAPI 保护）。服务器密码本身不会保存。
- `install-connector.ps1` 把连接器注册成当前用户的计划任务 `FengzhuAgentBridge`。加上 `-EnableAutoStart` 会在登录时自动启动，并在意外退出后自动重启；不加的话需要手动启动任务。
- 可选参数：`--name <电脑名>`（手机上显示的名字），`--workspace <目录>`（新任务的默认目录）。
- 检查：`node fengzhu-connect\src\cli.js doctor`，其中 `server` 应为 200。

桌面控制台（`kh-link-desktop`）的账号登录只用于官方服务。自己部署时不需要它；它的“二维码直连”不经过任何中转，可以照常使用，见[扫码直连](direct-connection.md)。

## 三、手机登录

1. 安装 App（官方安装包或自己编译的都行）。
2. 在登录页点“使用自己的服务器”。
3. “服务器地址”填 `https://bridge.example.com/fengzhu-bridge`，“服务器密码”填上面的服务器密码，点“登录”。

登录后手机会从中转取回加密的账户密钥，用服务器密码在本机解开。之后就能看到电脑上的会话了。

## 修改服务器密码

手机上：设置 →“服务器密码”。改密码会重新加密账户密钥，已登录的设备不受影响；之后新登录的设备要用新密码。

## 账号登录（可选）

官方服务用的是另一套 v2 账号登录：通过 OAuth 登录外部账号，并按会员资格决定能否远程操作。自己部署也可以接入自己的 OAuth 服务，需要配置 `KHQUANT_OIDC_*` 等环境变量，接口要求见 [身份与权益接口](../khquant-identity-contract.md)。只用服务器密码登录时不需要这些。

## 发布自己的手机版本

如果要把自己编译的 App 发给别人用，请先看根目录 README 的“编译和测试”：改 `applicationId`，处理 `updatePublicKey`，否则会收到装不上的官方更新。
