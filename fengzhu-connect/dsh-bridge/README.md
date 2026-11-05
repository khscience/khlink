# kh-link-dsh-bridge

DeepSeek Harness 桌面端的 KH Link 桥接插件。

## 它做什么

DSH 桌面端启动的本地 Host API 只把带启动令牌的地址交给 Electron 渲染进程。KH Link 连接器需要连到**同一个正在运行的桌面 Host**（同一批会话、正在跑的轮次），所以本插件在 Host 进程内把该地址写到：

```
%LOCALAPPDATA%\KH Link\dsh-desktop-bridge.json
```

文件包含 `url`（带一次性启动令牌）、`port`、`pid` 和版本，每 20 秒刷新；Host 关闭或插件卸载时删除。令牌只在本机用户目录内，不会上传到任何服务器；连接器也不会把令牌写进日志或转发给手机。

## 安装位置

连接器会把本目录复制到：

```
$DSH_HOME/profiles/node_modules/kh-link-dsh-bridge
```

并在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 加入一行：

```yaml
- insert:
    - id: kh-link-dsh-bridge
      name: kh-link-dsh-bridge
```

DSH 的 HMR 会在运行中挂载该插件，无需重启桌面端。删除该行即可完全停用。

## 边界

- 插件只读取 `ctx.webServer.protocol/port` 与 `ctx.connection.authenticatedUrl()`；不读取会话正文、不读取任何厂商凭据。
- 文件权限依赖 Windows 用户目录 ACL；同一 Windows 用户下的其他进程仍可能读取，这与连接器本身的信任级别一致。
- 该插件依赖 DSH 桌面端提供的 `webServer`、`connection` 服务；版本不匹配时只记录一条警告，不影响 DSH 本身。
