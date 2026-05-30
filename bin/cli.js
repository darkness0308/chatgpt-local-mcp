#!/usr/bin/env node
/**
 * chatgpt-local-mcp — CLI entry point
 *
 * Install globally:  npm install -g chatgpt-local-mcp
 *
 * Usage (run inside any project folder):
 *   chatgpt-local-mcp               # folder-scoped  (AI sees only this folder)
 *   chatgpt-local-mcp --bypass      # full filesystem access
 *   chatgpt-local-mcp --log         # live tool-call logs in terminal
 *   chatgpt-local-mcp --port 3002   # custom port
 *   chatgpt-local-mcp --no-tunnel   # local only (skip cloudflared)
 *   chatgpt-local-mcp --help
 *   chatgpt-local-mcp --version
 */

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { spawn } from "child_process";
import { readFileSync } from "fs";
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
const args = process.argv.slice(2);

// ── ANSI colours ──────────────────────────────────────────────────────────────
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan   = (s) => `\x1b[1;36m${s}\x1b[0m`;
const green  = (s) => `\x1b[1;32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[1;33m${s}\x1b[0m`;
const dim    = (s) => `\x1b[2m${s}\x1b[0m`;

// ── --help ────────────────────────────────────────────────────────────────────
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
${cyan("chatgpt-local-mcp")} ${dim(`v${pkg.version}`)}

  Give ChatGPT (or any MCP client) agentic access to your local project.
  By default, the AI can ${bold("only")} access the folder you run this in.

${bold("Usage:")}
  chatgpt-local-mcp [options]

${bold("Options:")}
  ${cyan("--bypass")}           Allow access to the entire filesystem
                      ${yellow("(removes folder restriction — use with care)")}
  ${cyan("--port")} ${dim("<n>")}         HTTP port (default: 3001)
  ${cyan("--log")}              Stream live tool-call logs in this terminal
  ${cyan("--no-tunnel")}        Skip cloudflared — serve on localhost only
  ${cyan("--version")}          Print version and exit
  ${cyan("--help")}             Show this help

${bold("Examples:")}
  ${dim("# In your project — AI sees only this folder")}
  cd my-project
  chatgpt-local-mcp

  ${dim("# With live logs")}
  chatgpt-local-mcp --log

  ${dim("# Full filesystem access")}
  chatgpt-local-mcp --bypass --log

  ${dim("# Custom port")}
  chatgpt-local-mcp --port 3002

${bold("After startup, paste the /mcp URL into:")}
  ChatGPT → Settings → Connectors → Add connector → MCP
`);
  process.exit(0);
}

// ── --version ─────────────────────────────────────────────────────────────────
if (args.includes("--version") || args.includes("-v")) {
  console.log(pkg.version);
  process.exit(0);
}

// ── parse flags ───────────────────────────────────────────────────────────────
const bypass   = args.includes("--bypass");
const logMode  = args.includes("--log");
const noTunnel = args.includes("--no-tunnel");

const portIdx = args.findIndex((a) => a === "--port");
const port    = portIdx !== -1 ? Number(args[portIdx + 1]) || 3001 : undefined;

// ── security scope ────────────────────────────────────────────────────────────
const cwd = process.cwd();

if (bypass) {
  // Full filesystem access — remove any folder restriction
  delete process.env.AI_PC_MCP_ROOT;
  delete process.env.AI_PC_MCP_DEFAULT_CWD;
  process.env.AI_PC_MCP_BYPASS = "true";
} else {
  // Folder-scoped mode: AI can only access the current working directory
  process.env.AI_PC_MCP_ROOT        = cwd;
  process.env.AI_PC_MCP_DEFAULT_CWD = cwd;
  process.env.AI_PC_MCP_BYPASS      = "false";
}

if (port)     process.env.AI_PC_MCP_PORT      = String(port);
if (noTunnel) process.env.AI_PC_MCP_NO_TUNNEL = "true";

// Signal to start.js that cli.js already printed a header
process.env.CHATGPT_LOCAL_MCP_CLI = "1";

// ── header banner ─────────────────────────────────────────────────────────────
// Strip ANSI codes to get the true visual length for centering.
const visLen = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const BOX_W  = 62; // inner width between ║ chars (total box = 64)

const titleRaw    = `ChatGPT Local MCP  v${pkg.version}`;
const titleStyled = `ChatGPT Local MCP  ${dim(`v${pkg.version}`)}`;
const lp = Math.floor((BOX_W - titleRaw.length) / 2);
const rp = BOX_W - titleRaw.length - lp;

console.log();
console.log(cyan("╔" + "═".repeat(BOX_W) + "╗"));
console.log(cyan("║") + " ".repeat(lp) + titleStyled + " ".repeat(rp) + cyan("║"));
console.log(cyan("╚" + "═".repeat(BOX_W) + "╝"));
console.log();

if (bypass) {
  const root = os.platform() === "win32"
    ? (process.env.SystemDrive || "C:") + "\\"
    : "/";
  console.log(yellow("  ⚠️   Bypass mode — full filesystem access"));
  console.log(yellow(`       Root: ${root}`));
  console.log(yellow("       The AI can read and write anywhere on this machine."));
} else {
  console.log(green("  🔒  Folder-scoped mode"));
  console.log(`       AI access restricted to: ${bold(cwd)}`);
  console.log(dim("       Use --bypass to allow full filesystem access."));
}

if (noTunnel) {
  const p = port || 3001;
  console.log();
  console.log(dim(`  🔌  Tunnel disabled — local only: http://localhost:${p}/mcp`));
}

console.log();

// ── launch ────────────────────────────────────────────────────────────────────
const startScript = resolve(__dirname, "../scripts/start.js");
const nodeArgs    = [startScript];
if (logMode) nodeArgs.push("--log");

const child = spawn(process.execPath, nodeArgs, {
  stdio: "inherit",
  env:   process.env,
});

child.on("exit", (code) => process.exit(code ?? 0));

process.on("SIGINT",  () => { try { child.kill("SIGINT");  } catch {} });
process.on("SIGTERM", () => { try { child.kill("SIGTERM"); } catch {} });
process.on("SIGHUP",  () => { try { child.kill("SIGHUP");  } catch {} });
