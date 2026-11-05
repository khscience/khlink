# Contributing

Thanks for helping improve khLink.

## Issues

- Search existing issues first.
- For a bug, include the app, connector and desktop console versions, Windows version, the
  agent and its version, whether you use the official service or your own relay, steps to
  reproduce, what you expected and what happened, and logs with tokens, passwords and
  local paths removed.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Pull requests

- Discuss protocol changes, large features and anything that touches more than one
  component (app, connector, relay, desktop) in an issue first.
- Keep a pull request to one topic and explain what changes for the user.
- Add or update tests. Before opening the pull request, run the checks that apply:
  `npm test`, `./gradlew testDebugUnitTest` in `android/`, `cargo test` in
  `kh-link-desktop/src-tauri` and `desktop-adapter`.
- Changes to the encrypted protocol must stay compatible with released apps and
  connectors, or come with a migration plan.
- Never include credentials, real user data, screenshots of private conversations or
  personal paths.
- Most documentation is in Chinese under `docs/zh-CN/`; English is welcome too.

By submitting a contribution you confirm you have the right to license it under the MIT
license of this repository.

---

# 参与贡献

感谢你帮助改进 khLink。

## Issue

- 先搜一下有没有人提过。
- 报告缺陷时请写明：手机 App、连接器、桌面控制台的版本，Windows 版本，智能体及版本，用的是官方服务还是自己的中转，复现步骤，预期和实际结果，以及删掉令牌、密码和本机路径后的日志。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要发公开 Issue。

## Pull Request

- 协议改动、大功能、同时涉及多个部分（App、连接器、中转、桌面）的改动，请先开 Issue 讨论。
- 一个 PR 只做一件事，说明对用户有什么变化。
- 补上或更新测试。提交前跑相关的检查：`npm test`、`android/` 里的 `./gradlew testDebugUnitTest`、`kh-link-desktop/src-tauri` 和 `desktop-adapter` 里的 `cargo test`。
- 加密协议的改动要兼容已经发布的 App 和连接器，否则要附迁移方案。
- 不要提交凭据、真实用户数据、私人对话的截图或个人电脑路径。
- 文档大多是中文，放在 `docs/zh-CN/`；也欢迎英文文档。

提交贡献即表示你确认有权按本仓库的 MIT 许可证授权这些内容。
