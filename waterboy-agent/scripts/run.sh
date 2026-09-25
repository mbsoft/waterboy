#!/bin/bash
# Launched by launchd. Loads optional secrets, then starts the agent.
set -euo pipefail
cd "$(dirname "$0")/.."
DATA_DIR="${IMESSAGE_AGENT_DATA:-$HOME/.imessage-agent}"
# Optional: CLAUDE_CODE_OAUTH_TOKEN=... (from `claude setup-token`), chmod 600.
if [ -f "$DATA_DIR/env" ]; then set -a; . "$DATA_DIR/env"; set +a; fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec "${NODE_BIN:-node}" --disable-warning=ExperimentalWarning --import tsx src/index.ts
