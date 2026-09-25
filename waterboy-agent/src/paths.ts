/**
 * Where things are, whether the service runs from source (tsx, this file in src/) or from the build
 * (esbuild bundles everything into dist/index.mjs and dist/mcpServer.mjs, which the desktop installer
 * ships as Waterboy.app/Contents/Resources/agent/). The only module that looks at its own location,
 * so the rest of the code can move freely.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** src/ when running from source; the directory holding index.mjs and mcpServer.mjs when built. */
const here = path.dirname(fileURLToPath(import.meta.url));

/** Running the esbuild output (the bundled service) rather than the TypeScript sources. */
export const isBuilt = fs.existsSync(path.join(here, "mcpServer.mjs"));

/** The agent's root: the waterboy-agent project from source; the build directory when built. */
export const agentRoot = isBuilt ? here : path.resolve(here, "..");

/** How to start src/mcpServer.ts (Waterboy's tools as MCP servers) as a separate process. */
export function toolServerEntry(): { args: string[]; cwd: string } {
  return isBuilt
    ? { args: [path.join(here, "mcpServer.mjs")], cwd: here }
    : { args: ["--import", "tsx", path.join(here, "mcpServer.ts")], cwd: agentRoot };
}

/** Where the waterboy-imessage helper can be, most specific first (bundled bin/, then the source checkout's build). */
export function helperCandidates(): string[] {
  return [
    path.join(agentRoot, "bin", "waterboy-imessage"), // Waterboy.app: Contents/Resources/agent/bin
    path.resolve(agentRoot, "../waterboy-imessage/dist/waterboy-imessage"), // source checkout
    path.resolve(here, "../../waterboy-imessage/dist/waterboy-imessage"), // waterboy-agent/dist build in a checkout
  ];
}
