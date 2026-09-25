#!/bin/bash
set -euo pipefail
for LABEL in local.waterboy local.imessage-agent; do # current + pre-rename label
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
done
echo "Removed the Waterboy service (data in ~/.imessage-agent kept)."
