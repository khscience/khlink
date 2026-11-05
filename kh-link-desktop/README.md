# KH Link Desktop

独立的 Windows 控制台。它负责 khQuant OAuth 登录、KH Link 双会员展示、手机二维码配对、设备管理、连接器状态、诊断和托盘常驻，不包含 Codex 对话界面，也不依赖风筑本地中心。

0.1.6 将二维码直连改为手机扫描一次后自动连接，电脑无需扫描手机码或点击确认。生成连接码时保留账户连接，验证手机自动回传的握手后才切换；取消准备保留原连接。需要连接器 0.2.40、Android 0.1.189。使用步骤见 [桌面连接流程](../docs/zh-CN/desktop-connection-flow.md)。

0.1.20 起桌面控制台与连接器合成一个安装包，并能从已签名的更新清单单独升级包内连接器，见 [一体化安装包](../docs/zh-CN/combined-installer.md)。

二维码直连通过 WebRTC 数据通道通信。同一 Wi-Fi／热点内可离线配对；不同网络尝试 STUN／ICE 穿透，不配置 TURN 中继。限制见 [直连说明](../docs/zh-CN/direct-connection.md)。

开发构建：

```powershell
cd src-tauri
cargo build
```

正式打包前需部署 `khquant-wordpress-plugin`、配置服务端 OAuth 环境变量，并补充代码签名证书和正式图标。
