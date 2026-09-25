#!/bin/bash
# Launched by launchd when the service is the copy bundled in Waterboy.app (Contents/Resources/agent/run.sh).
# The desktop app writes the LaunchAgent; this runs the prebuilt index.mjs with the app's own Node
# (Electron in ELECTRON_RUN_AS_NODE mode), so Full Disk Access and Automation are granted to Waterboy.
set -euo pipefail
cd "$(dirname "$0")"
DATA_DIR="${IMESSAGE_AGENT_DATA:-$HOME/.imessage-agent}"
# Optional: CLAUDE_CODE_OAUTH_TOKEN=... (from `claude setup-token`), chmod 600.
if [ -f "$DATA_DIR/env" ]; then set -a; . "$DATA_DIR/env"; set +a; fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export ELECTRON_RUN_AS_NODE=1
exec "${WATERBOY_BIN:-../../MacOS/Waterboy}" --disable-warning=ExperimentalWarning index.mjs
