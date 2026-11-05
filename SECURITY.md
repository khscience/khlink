# Security Policy

## Reporting a vulnerability

Please do not open a public issue for anything involving credentials, authentication
bypass, decryption of relay data, remote execution on the connector's computer,
unauthorized file access, or one user's data reaching another.

Report it through GitHub's private vulnerability reporting on this repository
(Security → Report a vulnerability). Include the affected component and version, steps to
reproduce, the impact you expect, and whether it is already public anywhere.

Reports are handled on a best-effort basis; there is no contractual response time. Fixes
may be prepared privately and published together with a release.

## What is in scope

- The connector (`fengzhu-connect`), the relay (`fengzhu-server`), the Android app, the
  desktop console and the desktop adapter in this repository.
- The official khLink relay and update channel.

Out of scope: issues that only exist in a fork, setups that deliberately disable
security settings, and general advice without a concrete bug in this code.

## Design notes for reviewers

- Agent content is encrypted on the computer and the phone with XChaCha20-Poly1305 under an
  account key the relay never receives; see [protocol/v1.md](protocol/v1.md).
- The connector listens only on 127.0.0.1, apart from the short-lived UDP port of a direct
  QR connection, which only accepts the encrypted handshake answer for a code that is
  still valid.
- The Android app and the desktop console verify app and connector updates against the
  Ed25519 key in `releases/update-signing-public.pem` before installing them.

---

# 安全政策

## 报告漏洞

涉及凭据、绕过登录验证、解密中转数据、在连接器所在电脑上远程执行、越权访问文件、不同用户数据串在一起的问题，请不要发公开 Issue。

请用本仓库 GitHub 的私密漏洞报告（Security → Report a vulnerability）提交，写明受影响的组件和版本、复现步骤、可能的影响，以及是否已在别处公开。

报告会尽力处理，没有合同约定的响应时间。修复可能先私下准备，再随版本一起发布。

## 范围

- 本仓库里的连接器（`fengzhu-connect`）、中转（`fengzhu-server`）、安卓 App、桌面控制台和桌面适配器。
- 官方 khLink 中转和更新渠道。

不在范围内：只存在于 fork 里的问题、故意关闭安全设置的部署、没有具体代码缺陷的泛泛建议。

## 给审查者的设计说明

- 智能体的内容在电脑和手机上用 XChaCha20-Poly1305 加密，密钥中转拿不到，见 [protocol/v1.md](protocol/v1.md)。
- 连接器只监听 127.0.0.1。唯一的例外是扫码直连时短暂打开的 UDP 端口，它只接受仍在有效期内的连接码对应的加密握手答复。
- 手机 App 和桌面控制台在安装 App 或连接器的更新前，都要用 `releases/update-signing-public.pem` 里的 Ed25519 公钥验签。
