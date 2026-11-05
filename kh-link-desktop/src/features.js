// Product feature gates. Keep the desktop, connector and Android gates in sync.
//
// 2026-10-18: Claude Desktop account switching is temporarily disabled after the
// remote-control compliance review. The local profiles, usage observations and
// switches under G:\Apps\ClaudeSwitch are intentionally kept; only the product
// entry points are closed. Remove this gate only together with the connector gate.
//
// 2026-10-31: the whole account switching entry (Claude and Codex) is closed
// while it is being reworked. Its sidebar item only says so; the pages, the
// local profiles and the Codex windows are left untouched.
window.KH_FEATURES = Object.freeze({ claudeAccountSwitch: false, accountSwitch: false });
