#!/bin/bash
# Installs a per-user LaunchAgent that keeps Waterboy (the iMessage assistant) running.
set -euo pipefail
LABEL="local.waterboy"
LEGACY_LABEL="local.imessage-agent" # before the Waterboy rename; replaced on install
PROJECT="$(cd "$(dirname "$0")/.." && pwd -P)" # physical path, never via a symlink
NODE_BIN="$(command -v node)"
NODE_REAL="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$NODE_BIN")"
DATA_DIR="$HOME/.imessage-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$DATA_DIR/logs" "$HOME/Library/LaunchAgents"
chmod +x "$PROJECT/scripts/run.sh"
[ -f "$PROJECT/config.json" ] || { echo "Create $PROJECT/config.json first (copy config.example.json)."; exit 1; }

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$PROJECT/scripts/run.sh</string></array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_BIN</key><string>$NODE_REAL</string>
    <key>IMESSAGE_AGENT_CONFIG</key><string>$PROJECT/config.json</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$DATA_DIR/logs/agent.log</string>
  <key>StandardErrorPath</key><string>$DATA_DIR/logs/agent.err.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LEGACY_LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LEGACY_LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout returns before the old process has exited (it finishes in-flight replies first);
# bootstrapping too early fails with "Bad request", so wait for it to be gone.
for _ in $(seq 1 40); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl print "gui/$(id -u)/$LEGACY_LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"
echo "Installed $PLIST"
echo
echo "IMPORTANT: grant Full Disk Access to this node binary (System Settings → Privacy & Security → Full Disk Access → +):"
echo "    $NODE_REAL"
echo "  (Cmd+Shift+G in the file picker to paste the path.) Re-grant after upgrading Node."
echo
echo "Logs:    tail -f $DATA_DIR/logs/agent.log $DATA_DIR/logs/agent.err.log"
echo "Restart: launchctl kickstart -k gui/$(id -u)/$LABEL"
