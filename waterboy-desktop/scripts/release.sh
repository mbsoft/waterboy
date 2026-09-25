#!/bin/bash
# Signed + notarized release of Waterboy (desktop app + the bundled service): `npm run release`.
#
#   1. checks a "Developer ID Application" certificate and notarization credentials are present
#   2. runs the app's and the agent's tests, and stages the agent for each architecture (scripts/stage-agent.js)
#   3. builds .dmg and .zip for Apple silicon and Intel (electron-builder signs and notarizes the app,
#      with the service in Contents/Resources/agent)
#   4. notarizes and staples each .dmg (electron-builder only notarizes the .app inside it)
#   5. verifies signatures and Gatekeeper acceptance, and writes SHA256SUMS.txt
#
# Credentials come from the environment, or from ./release.env (git-ignored) if it exists:
#   Signing:      a Developer ID Application identity in the login keychain, or
#                 CSC_LINK (path/base64 of a .p12) + CSC_KEY_PASSWORD
#   Notarizing:   APPLE_API_KEY (path to AuthKey_XXXX.p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER   (recommended)
#             or  APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
#             or  APPLE_KEYCHAIN_PROFILE (from `xcrun notarytool store-credentials`)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f release.env ]; then set -a; . ./release.env; set +a; fi

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- preflight ----------

[ "$(uname)" = "Darwin" ] || die "Releases have to be built on macOS."
node_ok() { node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; }
# Switch to the .nvmrc version (22) when the shell's node is older and nvm is installed.
if ! node_ok && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # npm run (e.g. Homebrew's npm) sets npm_config_prefix, which nvm refuses to work with.
  unset npm_config_prefix
  set +u; . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null; nvm use >/dev/null || true; set -u
  # nvm swaps its PATH entry in place, so another node earlier in PATH (e.g. Homebrew's node@20) would still win.
  [ -n "${NVM_BIN:-}" ] && export PATH="$NVM_BIN:$PATH"
fi
node_ok || die "Node 22+ required (nvm install 22)."
echo "Using Node $(node -v)"

say "Checking signing identity"
if [ -n "${CSC_LINK:-}" ]; then
  [ -n "${CSC_KEY_PASSWORD:-}" ] || die "CSC_LINK is set but CSC_KEY_PASSWORD isn't."
  echo "Using the certificate in CSC_LINK."
else
  identity=$(security find-identity -v -p codesigning | grep -o '"Developer ID Application: [^"]*"' | head -1 || true)
  [ -n "$identity" ] || die 'No "Developer ID Application" certificate in the keychain. Create one at
  https://developer.apple.com/account/resources/certificates (type: Developer ID Application),
  install it, or set CSC_LINK/CSC_KEY_PASSWORD. ("Apple Development" certificates can'"'"'t be notarized.)'
  echo "Using $identity"
  export CSC_NAME="${identity//\"/}"
  CSC_NAME="${CSC_NAME#Developer ID Application: }"
fi

say "Checking notarization credentials"
notary_args=()
if [ -n "${APPLE_API_KEY:-}" ]; then
  [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] || die "APPLE_API_KEY needs APPLE_API_KEY_ID and APPLE_API_ISSUER."
  [ -f "$APPLE_API_KEY" ] || die "APPLE_API_KEY should be the path to your AuthKey_XXXX.p8 file."
  notary_args=(--key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
  echo "Using App Store Connect API key $APPLE_API_KEY_ID."
elif [ -n "${APPLE_ID:-}" ]; then
  [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] || die "APPLE_ID needs APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID."
  notary_args=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
  echo "Using Apple ID $APPLE_ID."
elif [ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  notary_args=(--keychain-profile "$APPLE_KEYCHAIN_PROFILE")
  [ -n "${APPLE_KEYCHAIN:-}" ] && notary_args+=(--keychain "$APPLE_KEYCHAIN")
  echo "Using notarytool keychain profile $APPLE_KEYCHAIN_PROFILE."
else
  die "No notarization credentials. Set APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER (see the top of this script)."
fi

version=$(node -p 'require("./package.json").version')
say "Building Waterboy $version"

# ---------- test + build ----------

npm test
say "Testing the agent"
(cd ../waterboy-agent && npm run typecheck && npm test)
say "Building the typing-indicator helper"
../waterboy-imessage/build.sh
say "Staging the agent"
npm run stage-agent
rm -rf dist
npx electron-builder --mac --publish never

# ---------- notarize the DMGs ----------

shopt -s nullglob
dmgs=(dist/*.dmg)
[ ${#dmgs[@]} -gt 0 ] || die "No .dmg was produced."
for dmg in "${dmgs[@]}"; do
  say "Notarizing $(basename "$dmg")"
  xcrun notarytool submit "$dmg" "${notary_args[@]}" --wait --timeout 30m
  xcrun stapler staple "$dmg"
done

# ---------- verify ----------

say "Verifying"
for app in dist/mac*/"Waterboy.app"; do
  codesign --verify --deep --strict --verbose=1 "$app"
  spctl --assess --type execute --verbose=2 "$app"
  xcrun stapler validate "$app"
  # The bundled service: its launcher, code, and the Claude binary for this architecture (still Anthropic-signed).
  agent="$app/Contents/Resources/agent"
  [ -x "$agent/run.sh" ] && [ -f "$agent/index.mjs" ] || die "$app has no bundled agent."
  claude=$(ls "$agent"/node_modules/@anthropic-ai/claude-agent-sdk-darwin-*/claude)
  codesign --verify --strict "$claude"
  # ChatGPT assistant: the tool server and the Codex CLI (still OpenAI-signed).
  [ -f "$agent/mcpServer.mjs" ] || die "$app has no mcpServer.mjs."
  # Typing-indicator helper: built here, so signed with our identity.
  [ -x "$agent/bin/waterboy-imessage" ] || die "$app has no typing-indicator helper."
  codesign --verify --strict "$agent/bin/waterboy-imessage"
  codex=$(ls "$agent"/node_modules/@openai/codex-darwin-*/vendor/*/bin/codex)
  codesign --verify --strict "$codex"
  ELECTRON_RUN_AS_NODE=1 "$app/Contents/MacOS/Waterboy" -e 'require("node:sqlite")' 2>/dev/null \
    || [ "$(uname -m)" != "$(lipo -archs "$app/Contents/MacOS/Waterboy")" ] || die "$app can't run the service (ELECTRON_RUN_AS_NODE disabled?)."
done
for dmg in "${dmgs[@]}"; do
  xcrun stapler validate "$dmg"
  spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
done

(cd dist && shasum -a 256 ./*.dmg ./*.zip > SHA256SUMS.txt)

say "Done"
ls -lh dist/*.dmg dist/*.zip
echo
echo "Distribute the .dmg files (Apple silicon: arm64, Intel: x64). Checksums: dist/SHA256SUMS.txt"
