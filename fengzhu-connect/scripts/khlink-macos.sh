#!/bin/bash
# khLink connector for macOS: install, log in, run as a LaunchAgent.
#
#   ./khlink-macos.sh install   copy the connector package this script is in into
#                               ~/Library/Application Support/khLink/connector/app
#                               and install its Node dependencies
#   ./khlink-macos.sh login     log this Mac in to a khLink account (browser)
#   ./khlink-macos.sh start     run the connector now and at every login, and
#                               look for a newer connector every few hours
#   ./khlink-macos.sh update    install a newer connector now, if there is one
#   ./khlink-macos.sh autoupdate [on|off]
#   ./khlink-macos.sh stop      stop it and remove it from login items
#   ./khlink-macos.sh status    show whether it is running and its last log lines
#   ./khlink-macos.sh uninstall stop it and delete the program (keeps account data)
#
# The connector stores its secrets sealed with a key in the login Keychain, so
# login and the connector itself run in the user's GUI session (a LaunchAgent),
# also when this script is started over SSH.
set -euo pipefail

LABEL=com.khlink.connector
LOGIN_LABEL=com.khlink.login
UPDATE_LABEL=com.khlink.update
UPDATE_EVERY=21600
BASE="$HOME/Library/Application Support/khLink/connector"
APP="$BASE/app"
LOGS="$BASE/logs"
DATA="$HOME/Library/Application Support/FengzhuAgentBridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UPDATE_PLIST="$HOME/Library/LaunchAgents/$UPDATE_LABEL.plist"
# The update agent runs this copy: the one inside the app is replaced by an update.
SELF="$BASE/khlink-macos.sh"
DOMAIN="gui/$(id -u)"
HERE="$(cd "$(dirname "$0")" && pwd)"

die() { echo "khLink: $*" >&2; exit 1; }
stamp() { echo "$(date '+%F %T') $*"; }

# bootout returns before the job is gone; bootstrapping right after fails
# with "5: Input/output error".
unload() {
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || return 0
  local i; for i in $(seq 1 30); do launchctl print "$DOMAIN/$1" >/dev/null 2>&1 || return 0; sleep 0.5; done
}
load() {
  local i; for i in 1 2 3 4 5; do launchctl bootstrap "$DOMAIN" "$1" 2>/dev/null && return 0; sleep 1; done
  launchctl bootstrap "$DOMAIN" "$1"
}

find_node() {
  local candidates=() n
  command -v node >/dev/null 2>&1 && candidates+=("$(command -v node)")
  for n in /opt/homebrew/bin/node /usr/local/bin/node "$HOME"/.local/node-*/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node; do
    [ -x "$n" ] && candidates+=("$n")
  done
  for n in ${candidates[@]+"${candidates[@]}"}; do
    local major; major="$("$n" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$major" -ge 22 ]; then echo "$n"; return 0; fi
  done
  return 1
}

agent_path() {
  # Where agent CLIs are usually installed; a LaunchAgent gets only /usr/bin:/bin.
  local node_dir; node_dir="$(dirname "$1")"
  local npm_prefix; npm_prefix="$("$node_dir/npm" prefix -g 2>/dev/null || true)"
  local p="$node_dir"
  for d in "$HOME/.local/bin" "$HOME/.claude/local" "$HOME/.local/npm/bin" "$HOME/.npm-global/bin" "${npm_prefix:+$npm_prefix/bin}" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    [ -n "$d" ] && [ -d "$d" ] && case ":$p:" in *":$d:"*) ;; *) p="$p:$d" ;; esac
  done
  echo "$p"
}

write_plist() { # label, plist path, mode (keep | once | every:SECONDS), program args...
  # The program is Node unless the first argument is /bin/bash.
  local label="$1" file="$2" mode="$3"; shift 3
  local node; node="$(find_node)" || die "需要 Node.js 22 或更新版本"
  local args="" a
  [ "${1:-}" = /bin/bash ] || set -- "$node" "$@"
  for a in "$@"; do args="$args<string>$(printf '%s' "$a" | sed 's/&/\&amp;/g; s/</\&lt;/g')</string>"; done
  local extra=""
  case "$mode" in
    keep) extra='<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>20</integer><key>ProcessType</key><string>Interactive</string>' ;;
    once) extra='<key>RunAtLoad</key><true/>' ;;
    every:*) extra="<key>StartInterval</key><integer>${mode#every:}</integer><key>ProcessType</key><string>Background</string>" ;;
  esac
  mkdir -p "$(dirname "$file")" "$LOGS"
  cat > "$file" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>WorkingDirectory</key><string>$APP</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(agent_path "$node")</string><key>NODE_NO_WARNINGS</key><string>1</string></dict>
  $extra
  <key>StandardOutPath</key><string>$LOGS/$label.log</string>
  <key>StandardErrorPath</key><string>$LOGS/$label.log</string>
</dict></plist>
EOF
}

# A rename, so an update run of the old copy keeps reading the file it opened.
install_self() { cp "$APP/scripts/khlink-macos.sh" "$SELF.new" && chmod 755 "$SELF.new" && mv -f "$SELF.new" "$SELF"; }

cmd_install() {
  local src="${1:-$(dirname "$HERE")}"
  [ -f "$src/package.json" ] && [ -d "$src/src" ] || die "找不到连接器程序：$src"
  local node; node="$(find_node)" || die "需要 Node.js 22 或更新版本（https://nodejs.org）"
  mkdir -p "$APP"
  rm -rf "$APP/src" "$APP/scripts"
  (cd "$src" && tar cf - package.json src scripts $( [ -d native ] && echo native ) $( [ -d dsh-bridge ] && echo dsh-bridge )) | (cd "$APP" && tar xf -)
  (cd "$APP" && PATH="$(dirname "$node"):$PATH" npm install --omit=dev --no-audit --no-fund >/dev/null)
  install_self
  echo "已安装 khLink 连接器 $(cd "$APP" && "$node" -p 'require("./package.json").version') 到 $APP"
}

cmd_login() {
  [ -f "$APP/src/cli.js" ] || die "请先运行 install"
  local file="$BASE/$LOGIN_LABEL.plist" log="$LOGS/$LOGIN_LABEL.log"
  write_plist "$LOGIN_LABEL" "$file" once src/cli.js login "$@"
  rm -f "$log"; : > "$log"
  unload "$LOGIN_LABEL"
  load "$file"
  # Follow the login until it ends.
  tail -n +1 -f "$log" &
  local tailer=$!
  while launchctl print "$DOMAIN/$LOGIN_LABEL" 2>/dev/null | grep -q 'state = running'; do sleep 1; done
  sleep 1; kill "$tailer" 2>/dev/null || true
  launchctl bootout "$DOMAIN/$LOGIN_LABEL" 2>/dev/null || true
  rm -f "$file"
  grep -q '连接器已配置' "$log" || die "登录没有完成"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then launchctl kickstart -k "$DOMAIN/$LABEL"; echo "已重启连接器"; fi
}

cmd_start() {
  [ -f "$APP/src/cli.js" ] || die "请先运行 install"
  [ -f "$DATA/config.json" ] || die "请先运行 login"
  write_plist "$LABEL" "$PLIST" keep src/cli.js start
  unload "$LABEL"
  load "$PLIST"
  echo "khLink 连接器已启动，并会在登录 Mac 时自动运行"
  [ -f "$BASE/autoupdate-off" ] || autoupdate_on
}

autoupdate_on() {
  install_self
  write_plist "$UPDATE_LABEL" "$UPDATE_PLIST" "every:$UPDATE_EVERY" /bin/bash "$SELF" update --auto
  unload "$UPDATE_LABEL"
  load "$UPDATE_PLIST"
  echo "已开启自动更新（每 $((UPDATE_EVERY / 3600)) 小时检查一次）"
}

autoupdate_off() { unload "$UPDATE_LABEL"; rm -f "$UPDATE_PLIST"; }

cmd_autoupdate() {
  case "${1:-}" in
    on) rm -f "$BASE/autoupdate-off"; autoupdate_on ;;
    off) : > "$BASE/autoupdate-off"; autoupdate_off; echo "已关闭自动更新，需要时运行 update 手动更新" ;;
    *) if [ -f "$UPDATE_PLIST" ]; then echo "自动更新：开"; else echo "自动更新：关"; fi ;;
  esac
}

# "<version> <pid>" of the connector, from a status file written within the last 15 seconds.
running_connector() {
  "$1" -e 'try { const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (Date.now() - s.updatedAt <= 15000) console.log(`${s.version || ""} ${s.connectorPid || ""}`); } catch {}' "$DATA/status.json"
}

wait_version() { # node, version, seconds, pid of the connector it replaces
  local i now; for i in $(seq 1 "$3"); do
    now="$(running_connector "$1")"
    [ "${now% *}" = "$2" ] && [ "${now#* }" != "${4:-}" ] && return 0
    sleep 1
  done; return 1
}

# The running connector takes the new code: its supervisor swaps only the
# connector process, so a Codex turn in progress keeps running.
reload_connector() {
  if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q 'state = running'; then
    : > "$DATA/reload.request"
  else
    launchctl kickstart "$DOMAIN/$LABEL" 2>/dev/null || load "$PLIST"
  fi
}

UPDATE_NAMES="package.json src scripts native dsh-bridge"
WORK="$BASE/update"

cmd_update() {
  local auto=false force="" a
  for a in "$@"; do case "$a" in --auto) auto=true ;; --force) force=--force ;; esac; done
  [ -f "$APP/src/cli.js" ] || die "请先运行 install"
  local node; node="$(find_node)" || die "需要 Node.js 22 或更新版本"
  local work="$WORK"
  mkdir -p "$work"
  # One update at a time (the timer and a manual run); a lock older than 30 minutes is stale.
  if ! mkdir "$work/lock" 2>/dev/null; then
    [ -n "$(find "$work/lock" -maxdepth 0 -mmin +30 2>/dev/null)" ] || { stamp "已有一次更新在进行"; return 0; }
    rm -rf "$work/lock"; mkdir "$work/lock"
  fi
  trap 'rm -rf "$WORK/lock"' EXIT

  local result
  result="$(cd "$APP" && "$node" src/cli.js update-stage --app "$APP" --work "$work" $force 2>&1 | tail -n 1)" || true
  field() { "$node" -e 'try { const v = JSON.parse(process.argv[1])[process.argv[2]]; console.log(v === undefined ? "" : String(v)); } catch { console.log(""); }' "$result" "$1"; }
  local available version staged deps busy installed
  available="$(field available)"; version="$(field version)"; staged="$(field staged)"
  deps="$(field depsChanged)"; busy="$(field busy)"; installed="$(field installed)"
  if [ -z "$available" ]; then stamp "检查更新失败：$result"; $auto && return 0; return 1; fi
  if [ "$available" != true ]; then stamp "已是最新版本 $installed"; return 0; fi
  if [ -n "$busy" ]; then stamp "有新版本 $version，$busy"; return 0; fi
  [ -d "$staged" ] || die "更新包不存在：$staged"
  stamp "更新 $installed → $version"

  local previous="$work/previous" n ok=true
  rm -rf "$previous"; mkdir -p "$previous"
  for n in $UPDATE_NAMES; do [ -e "$APP/$n" ] && mv "$APP/$n" "$previous/$n"; done
  for n in $UPDATE_NAMES; do [ -e "$staged/$n" ] && mv "$staged/$n" "$APP/$n"; done
  rm -rf "$staged"
  if [ "$deps" = true ]; then
    cp -R "$APP/node_modules" "$previous/node_modules" 2>/dev/null || true
    (cd "$APP" && PATH="$(dirname "$node"):$PATH" npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1) || ok=false
  fi
  # Not started with `start` (no LaunchAgent): nothing to restart or wait for.
  local old_pid; old_pid="$(running_connector "$node")"; old_pid="${old_pid#* }"
  if $ok && [ -f "$PLIST" ]; then reload_connector; wait_version "$node" "$version" 90 "$old_pid" || ok=false; fi
  if $ok; then
    install_self
    rm -rf "$previous"
    stamp "已更新到 $version"
    return 0
  fi

  # The new connector did not come up: put the previous one back and restart it.
  stamp "$version 没有正常启动，恢复 $installed"
  for n in $UPDATE_NAMES node_modules; do
    if [ -e "$previous/$n" ]; then rm -rf "${APP:?}/$n"; mv "$previous/$n" "$APP/$n"
    elif [ "$n" != node_modules ]; then rm -rf "${APP:?}/$n"; fi
  done
  rm -rf "$previous"
  if [ -f "$PLIST" ]; then
    unload "$LABEL"; load "$PLIST"
    wait_version "$node" "$installed" 90 || stamp "$installed 也还没上线，请运行 status 查看"
  fi
  return 1
}

cmd_stop() {
  autoupdate_off
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then unload "$LABEL"; echo "已停止 khLink 连接器"; else echo "khLink 连接器没有在运行"; fi
  rm -f "$PLIST"
}

cmd_status() {
  if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E 'state = |pid = ' | head -2; then :; else echo "未运行"; fi
  cmd_autoupdate
  [ -f "$LOGS/$UPDATE_LABEL.log" ] && tail -n 2 "$LOGS/$UPDATE_LABEL.log"
  local log; log="$(ls -t "$DATA/logs"/connector-*.log 2>/dev/null | head -1 || true)"
  [ -n "$log" ] && tail -n 8 "$log"
}

cmd_uninstall() { cmd_stop; rm -rf "$APP" "$BASE/update" "$SELF"; echo "已删除程序；账号数据保留在 ~/Library/Application Support/FengzhuAgentBridge"; }

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  login) shift; cmd_login "$@" ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_start ;;
  status) cmd_status ;;
  update) shift; cmd_update "$@" ;;
  autoupdate) shift; cmd_autoupdate "$@" ;;
  uninstall) cmd_uninstall ;;
  *) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
