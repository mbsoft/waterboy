#!/usr/bin/env node
/**
 * Stages the Waterboy service (../waterboy-agent) for bundling into the app: `npm run stage-agent [arm64|x64 ...]`.
 *
 * For each architecture, build/agent/<arch>/agent/ gets
 *   index.mjs            the service, compiled from src/ by esbuild (npm packages left external)
 *   mcpServer.mjs        Waterboy's tools as stdio MCP servers, for the ChatGPT (Codex) assistant
 *   alertCard.mjs        draws a live alert card on demand (Settings → Live alerts → Preview)
 *   bin/waterboy-imessage  typing-indicator helper (../waterboy-imessage, Beeper's platform-imessage), thinned
 *                        to that architecture; skipped with a warning if it hasn't been built
 *   node_modules/        production dependencies for that architecture (the Agent SDK's Claude binary is per-arch)
 *   package.json, package-lock.json, run.sh, config.example.json
 * electron-builder copies it to Waterboy.app/Contents/Resources/agent (extraResources in electron-builder.yml).
 * node_modules is only reinstalled when the agent's package-lock.json changes.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const AGENT = path.resolve(__dirname, "../../waterboy-agent");
const HELPER = path.resolve(__dirname, "../../waterboy-imessage/dist/waterboy-imessage");
const OUT = path.resolve(__dirname, "../build/agent");
const arches = process.argv.slice(2).length ? process.argv.slice(2) : ["arm64", "x64"];
const npm = (args, cwd) => execFileSync("npm", args, { cwd, stdio: "inherit" });

for (const a of arches) if (!["arm64", "x64"].includes(a)) throw new Error(`Unknown architecture ${a} (arm64 or x64)`);
if (!fs.existsSync(path.join(AGENT, "node_modules/esbuild"))) throw new Error(`Run npm install in ${AGENT} first.`);

console.log("Building the agent");
npm(["run", "build"], AGENT);

const lock = fs.readFileSync(path.join(AGENT, "package-lock.json"));
const lockHash = crypto.createHash("sha256").update(lock).digest("hex");

for (const arch of arches) {
  // One level down: electron-builder always drops a node_modules at the root of an extraResources folder.
  const dir = path.join(OUT, arch, "agent");
  fs.mkdirSync(dir, { recursive: true });
  const copy = (from, to = path.basename(from)) => fs.copyFileSync(path.join(AGENT, from), path.join(dir, to));
  copy("dist/index.mjs");
  copy("dist/mcpServer.mjs");
  copy("dist/alertCard.mjs");
  copy("package.json");
  copy("package-lock.json");
  copy("config.example.json");
  copy("scripts/run-app.sh", "run.sh");
  fs.chmodSync(path.join(dir, "run.sh"), 0o755);

  const bin = path.join(dir, "bin");
  fs.rmSync(bin, { recursive: true, force: true });
  if (fs.existsSync(HELPER)) {
    fs.mkdirSync(bin);
    execFileSync("/usr/bin/lipo", [HELPER, "-thin", arch === "arm64" ? "arm64" : "x86_64", "-output", path.join(bin, "waterboy-imessage")]);
  } else {
    console.warn(`${arch}: no typing-indicator helper (run waterboy-imessage/build.sh); this build won't show typing`);
  }

  const stamp = path.join(dir, "node_modules/.waterboy-lock");
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === lockHash) {
    console.log(`${arch}: dependencies up to date`);
  } else {
    console.log(`${arch}: installing dependencies`);
    fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
    npm(["ci", "--omit=dev", "--os=darwin", `--cpu=${arch}`, "--ignore-scripts", "--no-audit", "--no-fund"], dir);
    fs.writeFileSync(stamp, lockHash);
  }

  // The SDK runs this binary; without it every reply fails.
  const claude = path.join(dir, `node_modules/@anthropic-ai/claude-agent-sdk-darwin-${arch}/claude`);
  if (!fs.existsSync(claude)) throw new Error(`${arch}: ${claude} is missing`);
  const file = execFileSync("/usr/bin/file", ["-b", claude]).toString();
  const want = arch === "arm64" ? "arm64" : "x86_64";
  if (!file.includes(want)) throw new Error(`${arch}: the Claude binary is ${file.trim()}, expected ${want}`);

  // The ChatGPT assistant runs this one (Codex CLI), also per-arch.
  const triple = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  const codex = path.join(dir, `node_modules/@openai/codex-darwin-${arch}/vendor/${triple}/bin/codex`);
  if (!fs.existsSync(codex)) throw new Error(`${arch}: ${codex} is missing`);
  const codexFile = execFileSync("/usr/bin/file", ["-b", codex]).toString();
  if (!codexFile.includes(want)) throw new Error(`${arch}: the Codex binary is ${codexFile.trim()}, expected ${want}`);
}
console.log(`Staged the agent for ${arches.join(", ")} in ${path.relative(process.cwd(), OUT) || OUT}`);
