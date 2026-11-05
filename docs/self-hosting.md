# Self-hosting the relay

You can run the relay (`fengzhu-server`) on your own server instead of using the official
service. You then sign in with a single server password: no khLink account and no
membership. The official app and installers work with your relay, and so do your own builds.

[中文](zh-CN/self-hosting.md)

## What you need

- A Linux server with Node.js 22 and nginx, a domain pointing at it and an HTTPS
  certificate (for example from certbot).
- A Windows computer with Node.js 22 and the agents you want to use (for example Codex).
- An Android phone.

Below, `bridge.example.com` stands for your domain and the relay is served under
`/fengzhu-bridge/`.

## 1. Deploy the relay

1. Get the code and build it on the server:

   ```bash
   sudo mkdir -p /opt/fengzhu-agent-bridge && sudo chown "$USER" /opt/fengzhu-agent-bridge
   git clone <this repository> /opt/fengzhu-agent-bridge
   cd /opt/fengzhu-agent-bridge
   npm ci
   npm run build
   ```

2. Create a system user and the data directory:

   ```bash
   sudo useradd --system --home /var/lib/fengzhu-agent-bridge --shell /usr/sbin/nologin fengzhu-bridge
   sudo install -d -o fengzhu-bridge -g fengzhu-bridge -m 700 /var/lib/fengzhu-agent-bridge
   ```

3. Write `/etc/fengzhu-agent-bridge.env` (mode 600, readable by root only):

   ```ini
   # Signs access tokens; at least 32 random bytes in base64: openssl rand -base64 32
   TOKEN_SIGNING_KEY=<random key>
   # The server password, 16 characters or more. Read on the first start only and then
   # kept in the database as a verifier
   FENGZHU_ADMIN_PASSWORD=<your server password>
   SQLITE_PATH=/var/lib/fengzhu-agent-bridge/fengzhu-bridge.db
   PORT=8110
   ```

   After the first successful start you can remove `FENGZHU_ADMIN_PASSWORD` from the file.

4. Install and start the systemd service:

   ```bash
   sudo cp ops/fengzhu-agent-bridge.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now fengzhu-agent-bridge
   systemctl status fengzhu-agent-bridge
   ```

   The relay listens on `127.0.0.1:8110` only; nginx serves it over HTTPS.

5. Configure nginx from `ops/nginx-bridge.conf`: set `server_name` to your domain and add
   HTTPS (`listen 443 ssl` and the certificate paths, or let certbot edit it). The template
   already forwards WebSockets, rate-limits the login endpoints and sets the upload limit.
   The `/fengzhu-bridge/downloads/` block serves official updates and can be removed.

6. Check it:

   ```bash
   curl https://bridge.example.com/fengzhu-bridge/healthz
   ```

   A 200 means the relay is reachable.

7. Optional daily backups of the encrypted database: `ops/backup.sh` with
   `ops/fengzhu-agent-bridge-backup.service` and `.timer`.

## 2. Set up the connector on the computer

In PowerShell on the Windows computer:

```powershell
git clone <this repository> khlink
cd khlink
npm ci
$env:FENGZHU_BRIDGE_PASSWORD = '<your server password>'
node fengzhu-connect\src\cli.js setup --server https://bridge.example.com/fengzhu-bridge
Remove-Item Env:FENGZHU_BRIDGE_PASSWORD
powershell -NoProfile -ExecutionPolicy Bypass -File ops\install-connector.ps1 -EnableAutoStart
```

- `setup` creates this computer's account key, hands the relay a copy encrypted with the
  server password, and writes the configuration to
  `%APPDATA%\FengzhuAgentBridge\config.json` (protected with Windows DPAPI). The server
  password itself is not stored.
- `install-connector.ps1` registers the connector as the per-user scheduled task
  `FengzhuAgentBridge`. With `-EnableAutoStart` it starts at logon and restarts after a
  crash; without it you start the task yourself.
- Options: `--name <computer name>` (shown on the phone), `--workspace <folder>` (default
  folder for new tasks).
- Check: `node fengzhu-connect\src\cli.js doctor` should report `server` 200.

The desktop console's account login (`kh-link-desktop`) is for the official service only
and is not needed here. Its direct QR connection uses no relay at all and works as usual;
see [direct connection](zh-CN/direct-connection.md) (Chinese).

## 3. Sign in on the phone

1. Install the app (official or your own build).
2. On the login screen tap "使用自己的服务器" (use your own server).
3. Enter `https://bridge.example.com/fengzhu-bridge` as "服务器地址" (server address) and the
   server password as "服务器密码", then tap "登录" (sign in).

The phone fetches the encrypted account key from the relay and unlocks it locally with the
server password. The computer's sessions then appear.

## Changing the server password

On the phone: Settings → "服务器密码". The account key is re-encrypted with the new
password; devices that are already signed in stay signed in, and new devices use the new
password.

## Account login (optional)

The official service uses a second login system (v2): OAuth with an external account, with
membership deciding who may act remotely. A self-hosted relay can use your own OAuth
service through the `KHQUANT_OIDC_*` environment variables; the requirements are in
[the identity contract](khquant-identity-contract.md) (Chinese). None of this is needed for
password login.

## Publishing your own app build

Before you hand your own app build to other people, read "Building and testing" in the
root README: change the `applicationId` and deal with `updatePublicKey`, or users will be
offered official updates they cannot install.
