#!/usr/bin/env node
/**
 * AI PC MCP Connector — Cross-platform launcher
 *
 * Works on Windows, Linux (including GitHub Codespaces), and macOS.
 *
 * What it does:
 *   1. Copies the protected runtime to ~/.ai-pc-mcp
 *   2. npm-installs dependencies there (once)
 *   3. Runs a watchdog that auto-restarts the MCP server on crash
 *   4. GitHub Codespaces → makes port public via `gh` CLI
 *   5. Everywhere else  → auto-downloads cloudflared, starts a free tunnel,
 *      reads the public URL from cloudflared output
 *   6. Prints the public MCP URL to paste into ChatGPT (No Auth)
 *
 * Usage:
 *   npm start              (all platforms)
 *   node scripts/start.js  (direct)
 */

import { spawn } from "child_process";
import { promisify } from "util";
import { execFile } from "child_process";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import https from "https";
import http from "http";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── constants ───────────────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === "win32";
const IS_MACOS = process.platform === "darwin";
const WORKSPACE_DIR = path.resolve(__dirname, "..");
const PORT = Number(process.env.AI_PC_MCP_PORT || 3001);
const HOST = process.env.AI_PC_MCP_HOST || "0.0.0.0";
const INSTALL_DIR = process.env.CHATGPT_LOCAL_MCP_HOME || process.env.AI_PC_MCP_HOME || path.join(os.homedir(), ".chatgpt-local-mcp");
const LOG_DIR = path.join(INSTALL_DIR, "logs");
const BIN_DIR = path.join(INSTALL_DIR, "bin");
const SERVER_FILE = path.join(INSTALL_DIR, "src", "server.js");
const ENV_FILE = path.join(INSTALL_DIR, ".env");
const SERVER_LOG = path.join(LOG_DIR, "server.log");
const WATCHDOG_LOG = path.join(LOG_DIR, "watchdog.log");
const CF_LOG = path.join(LOG_DIR, "cloudflared.log");

let shutdownRequested = false;
let serverChild = null;

// ─── colours (Windows 10+ supports ANSI in cmd / PowerShell) ─────────────────

const cyan = (s) => `\x1b[1;36m${s}\x1b[0m`;
const green = (s) => `\x1b[1;32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[1;33m${s}\x1b[0m`;
const red = (s) => `\x1b[1;31m${s}\x1b[0m`;

// ─── log mode ────────────────────────────────────────────────────────────────
// Enable with:  npm run start:log   OR   npm start -- --log

const LOG_MODE = process.argv.includes("--log") || process.argv.includes("log");

// ANSI colour palette
const C = {
  reset:   "\x1b[0m",
  dim:     "\x1b[2m",
  bold:    "\x1b[1m",
  red:     "\x1b[31m",
  yellow:  "\x1b[33m",
  green:   "\x1b[32m",
  cyan:    "\x1b[36m",
  magenta: "\x1b[35m",
  bCyan:   "\x1b[1;36m",
  bGreen:  "\x1b[1;32m",
  bYellow: "\x1b[1;33m",
};

// Keep legacy aliases used by printHeader / cleanup / etc.
const DIM   = C.dim;
const RESET = C.reset;

// Per-source style: short label + colour
const SRC_STYLES = {
  SERVER:   { label: "SRV", color: C.bCyan    },
  TUNNEL:   { label: "TUN", color: C.bYellow  },
  WATCHDOG: { label: "WDG", color: C.magenta  },
};
// Keep SRC_COLORS for any legacy references
const SRC_COLORS = {
  SERVER: C.bCyan, TUNNEL: C.bYellow, WATCHDOG: C.magenta,
};

// ── Cloudflared log parsing ───────────────────────────────────────────────────
// cloudflared emits:  "2026-05-30T10:12:02Z INF message…"
const CF_LINE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\s+(INF|ERR|WRN|DBG)\s*/;

// Lines we silently drop — they're noise or already shown elsewhere
const CF_FILTER_RE = [
  /^Thank you for trying Cloudflare Tunnel/,    // long ToS paragraph
  /^precheck component=/,                        // per-check detail rows (shown in table above)
  /^precheck complete\s/,                        // precheck footer
  /^Cannot determine default configuration/,    // missing config-file notice
  /^cloudflared will not automatically update/, // Windows update notice
  /^GOOS:/,                                     // build metadata
  /^Version \d{4}/,                             // build version string
  /^Settings:/,                                 // internal settings dump
  /^Tunnel connection curve preferences/,       // TLS crypto detail
  /^ICMP proxy will use/,                       // repeated ICMP setup (appears 4x)
  /^Generated Connector ID:/,                   // internal UUID
];

// Determines display level for a cleaned tunnel message
const CF_GOOD_RE  = /Registered tunnel connection|SUMMARY.*healthy|Your quick Tunnel|trycloudflare\.com/i;
const CF_WARN_RE  = /does not support|certificate|WRN/;

function parseCfLine(raw) {
  const m = raw.match(CF_LINE_RE);
  if (!m) return { text: raw, level: "info", skip: false };
  const cfLevel = m[1];
  const text = raw.slice(m[0].length).trimEnd();
  if (CF_FILTER_RE.some((re) => re.test(text))) return { text, level: "info", skip: true };
  let level = "info";
  if      (cfLevel === "ERR")        level = "error";
  else if (cfLevel === "WRN" || CF_WARN_RE.test(text)) level = "warn";
  else if (CF_GOOD_RE.test(text))    level = "success";
  return { text, level, skip: false };
}

// ── Log rendering ─────────────────────────────────────────────────────────────
const LEVEL_ICON  = { info: "·", warn: "⚠", error: "✗", success: "✓" };
const LEVEL_COLOR = {
  info:    C.reset,
  warn:    C.yellow,
  error:   C.red,
  success: C.bGreen,
};

// Buffer lines that arrive before the live banner is shown (avoids interleaving)
const startupLogBuffer = [];
let   logBannerShown   = false;

function logLine(source, rawText, _level = "info") {
  if (!rawText.trim() || !LOG_MODE) return;

  let text  = rawText;
  let level = _level;

  if (source === "TUNNEL") {
    const parsed = parseCfLine(rawText);
    if (parsed.skip) return;
    text  = parsed.text;
    level = parsed.level;
  }

  const now = new Date();
  const hms = now.toTimeString().slice(0, 8);
  const ms  = String(now.getMilliseconds()).padStart(3, "0");
  const ts  = `${hms}.${ms}`;

  const { label, color } = SRC_STYLES[source] || { label: source.slice(0, 3).toUpperCase(), color: C.reset };
  const icon     = LEVEL_ICON[level]  || "·";
  const msgColor = LEVEL_COLOR[level] || C.reset;

  const line =
    `${C.dim}${ts}${C.reset}` +
    ` ${color}[${label}]${C.reset}` +
    ` ${msgColor}${icon} ${text}${C.reset}`;

  if (logBannerShown) {
    process.stdout.write(line + "\n");
  } else {
    startupLogBuffer.push(line);
  }
}

// Dump buffered startup logs with a clear visual separator
function flushStartupLogs() {
  if (!LOG_MODE || !startupLogBuffer.length) return;
  const bar = `${C.dim}${"-".repeat(64)}${C.reset}`;
  process.stdout.write(`\n${bar}\n`);
  process.stdout.write(`${C.dim} startup logs (${startupLogBuffer.length} lines captured before tunnel was ready)${C.reset}\n`);
  process.stdout.write(`${bar}\n`);
  for (const line of startupLogBuffer) process.stdout.write(line + "\n");
  startupLogBuffer.length = 0;
  process.stdout.write(`${bar}\n\n`);
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function printHeader() {
  // Skip when launched via `chatgpt-local-mcp` CLI — it already showed the scope banner.
  if (process.env.CHATGPT_LOCAL_MCP_CLI) return;
  console.log();
  console.log(cyan("╔══════════════════════════════════════════════════════════════╗"));
  console.log(cyan("║              ChatGPT Local MCP — Folder AI Bridge            ║"));
  console.log(cyan("╚══════════════════════════════════════════════════════════════╝"));
  console.log();
}

async function installRuntime() {
  console.log(`📦 Installing protected runtime in: ${INSTALL_DIR}`);
  await fs.mkdir(path.join(INSTALL_DIR, "src"), { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.mkdir(BIN_DIR, { recursive: true });

  await fs.copyFile(
    path.join(WORKSPACE_DIR, "src", "server.js"),
    SERVER_FILE
  );
  await fs.copyFile(
    path.join(WORKSPACE_DIR, "package.json"),
    path.join(INSTALL_DIR, "package.json")
  );
}

async function npmInstall() {
  const nodeModules = path.join(INSTALL_DIR, "node_modules");
  if (fsSync.existsSync(nodeModules)) {
    console.log("✅ Dependencies already installed.");
    return;
  }
  console.log("📥 Installing npm dependencies in protected runtime...");
  await new Promise((resolve, reject) => {
    // On Windows the npm script is npm.cmd; shell:true covers both platforms.
    const child = spawn("npm", [
      "install", "--omit=dev", "--no-audit", "--no-fund",
    ], {
      cwd: INSTALL_DIR,
      stdio: "inherit",
      shell: true,         // needed on Windows so npm.cmd is found
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install failed (exit ${code})`));
    });
    child.on("error", reject);
  });
}

// ─── env file ─────────────────────────────────────────────────────────────────
// Use | as path separator — safe on all OS (| is illegal in file paths).

async function writeEnvFile(publicUrl) {
  // ACCESS_ROOT: use what cli.js set (folder-scoped cwd or bypass), falling back to drive root.
  const accessRoot = process.env.AI_PC_MCP_ROOT || (IS_WINDOWS
    ? (process.env.SystemDrive || "C:") + "\\"
    : "/");

  // DEFAULT_CWD: same — use cli.js value if present, otherwise the workspace dir.
  const defaultCwd = process.env.AI_PC_MCP_DEFAULT_CWD || WORKSPACE_DIR;

  // Build protected paths list, separated by | (safe on Windows and Linux).
  const protectedPaths = [
    INSTALL_DIR,
    SERVER_FILE,
    path.join(WORKSPACE_DIR, "scripts", "start.js"),
    path.join(WORKSPACE_DIR, "package.json"),
  ].join("|");

  const lines = [
    `AI_PC_MCP_HOME=${INSTALL_DIR}`,
    `AI_PC_MCP_ENV_FILE=${ENV_FILE}`,
    `AI_PC_MCP_PORT=${PORT}`,
    `AI_PC_MCP_HOST=${HOST}`,
    `AI_PC_MCP_ROOT=${accessRoot}`,
    `AI_PC_MCP_DEFAULT_CWD=${defaultCwd}`,
    `AI_PC_MCP_BYPASS=${process.env.AI_PC_MCP_BYPASS || "false"}`,
    `CHATGPT_LOCAL_MCP_HOME=${INSTALL_DIR}`,
    publicUrl ? `AI_PC_MCP_PUBLIC_URL=${publicUrl}` : null,
    `AI_PC_MCP_PROTECTED_PATHS=${protectedPaths}`,
    `AI_PC_MCP_ALLOW_NO_AUTH=true`,
    `AI_PC_MCP_COMMAND_TIMEOUT_MS=${process.env.AI_PC_MCP_COMMAND_TIMEOUT_MS || 30000}`,
    `AI_PC_MCP_MAX_READ_BYTES=${process.env.AI_PC_MCP_MAX_READ_BYTES || 4194304}`,
    `AI_PC_MCP_MAX_OUTPUT_BYTES=${process.env.AI_PC_MCP_MAX_OUTPUT_BYTES || 2097152}`,
  ].filter(Boolean);

  await fs.writeFile(ENV_FILE, lines.join("\n") + "\n", "utf8");
}

// ─── health check ─────────────────────────────────────────────────────────────

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: "127.0.0.1", port: PORT, path: "/health", timeout: 2000 },
      (res) => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(maxSeconds = 30) {
  console.log("Waiting for server...");
  for (let i = 0; i < maxSeconds; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await healthCheck()) {
      console.log("Server is healthy.");
      return true;
    }
  }
  return false;
}

// ─── watchdog ─────────────────────────────────────────────────────────────────

function launchServer() {
  if (shutdownRequested) return;

  const logStream = fsSync.createWriteStream(SERVER_LOG, { flags: "a" });

  serverChild = spawn(process.execPath, [SERVER_FILE], {
    cwd: INSTALL_DIR,
    env: {
      ...process.env,
      AI_PC_MCP_HOME: INSTALL_DIR,
      AI_PC_MCP_ENV_FILE: ENV_FILE,
      AI_PC_MCP_PORT: String(PORT),
      AI_PC_MCP_HOST: HOST,
      AI_PC_MCP_ALLOW_NO_AUTH: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Write each chunk to the log file AND, in --log mode, also to the terminal.
  const handleServerChunk = (chunk, level) => {
    logStream.write(chunk);
    if (LOG_MODE) {
      chunk.toString().split(/\r?\n/).forEach((line) => logLine("SERVER", line, level));
    }
  };
  serverChild.stdout.on("data", (chunk) => handleServerChunk(chunk, "info"));
  serverChild.stderr.on("data", (chunk) => handleServerChunk(chunk, "error"));

  const pid = serverChild.pid;
  const ts = () => new Date().toISOString();
  const wdLog = (msg) => {
    fsSync.appendFileSync(WATCHDOG_LOG, `[${ts()}] ${msg}\n`);
    if (LOG_MODE) logLine("WATCHDOG", msg, "info");
  };

  wdLog(`started server (pid=${pid})`);

  serverChild.on("exit", (code, signal) => {
    logStream.end();
    if (shutdownRequested) return;
    wdLog(`server exited (code=${code}, signal=${signal}); restarting in 2s`);
    setTimeout(launchServer, 2000);
  });

  serverChild.on("error", (err) => {
    wdLog(`server error: ${err.message}`);
  });
}

// ─── cloudflared tunnel ───────────────────────────────────────────────────────

function cfBinaryUrl() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
  if (IS_WINDOWS) return `${base}/cloudflared-windows-${arch}.exe`;
  if (IS_MACOS)   return `${base}/cloudflared-darwin-${arch}`;
  return `${base}/cloudflared-linux-${arch}`;
}

function cfBinaryPath() {
  return path.join(BIN_DIR, IS_WINDOWS ? "cloudflared.exe" : "cloudflared");
}

function downloadFile(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 12) return reject(new Error("Too many redirects"));

    const out = fsSync.createWriteStream(dest);

    const cleanup = (err) => {
      out.close();
      fs.unlink(dest).catch(() => {});
      reject(err);
    };

    https.get(url, { timeout: 120_000 }, (res) => {
      const { statusCode, headers } = res;

      if ([301, 302, 307, 308].includes(statusCode) && headers.location) {
        out.close();
        fs.unlink(dest).catch(() => {});
        return downloadFile(headers.location, dest, hops + 1).then(resolve, reject);
      }

      if (statusCode !== 200) {
        res.resume();
        return cleanup(new Error(`HTTP ${statusCode} for ${url}`));
      }

      res.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", cleanup);
      res.on("error", cleanup);
    }).on("error", cleanup);
  });
}

async function ensureCloudflared() {
  const cfPath = cfBinaryPath();
  if (fsSync.existsSync(cfPath)) return cfPath;

  console.log("📥 Downloading cloudflared tunnel binary...");
  try {
    await downloadFile(cfBinaryUrl(), cfPath);
    if (!IS_WINDOWS) await fs.chmod(cfPath, 0o755);
    console.log(green("✅ cloudflared downloaded."));
    return cfPath;
  } catch (err) {
    console.log(yellow(`⚠️  Could not download cloudflared: ${err.message}`));
    return null;
  }
}

async function startCloudflaredTunnel() {
  const cfPath = await ensureCloudflared();
  if (!cfPath) return null;

  return new Promise((resolve) => {
    const logStream = fsSync.createWriteStream(CF_LOG, { flags: "a" });

    const child = spawn(cfPath, ["tunnel", "--url", `http://localhost:${PORT}`], {
      stdio: ["ignore", "pipe", "pipe"],
      // Don't inherit parent env completely; give cloudflared a clean slate.
      env: {
        HOME: os.homedir(),
        USERPROFILE: os.homedir(),
        PATH: process.env.PATH || "",
        ...(IS_WINDOWS ? { SystemRoot: process.env.SystemRoot || "C:\\Windows" } : {}),
      },
    });

    let done = false;
    const urlRe = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const handleData = (chunk) => {
      const text = chunk.toString();
      logStream.write(text);
      // Stream tunnel output to terminal in --log mode.
      if (LOG_MODE) {
        text.split(/\r?\n/).forEach((line) => logLine("TUNNEL", line, "info"));
      }
      if (!done) {
        const m = text.match(urlRe);
        if (m) finish({ url: m[0], process: child });
      }
    };

    child.stdout.on("data", handleData);
    child.stderr.on("data", handleData);
    child.on("exit", () => finish(null));
    child.on("error", (err) => {
      logStream.write(`cloudflared error: ${err.message}\n`);
      finish(null);
    });

    // Give cloudflared 40 s to establish and print the URL.
    setTimeout(() => finish(null), 40_000);
  });
}

// ─── Codespaces helpers ───────────────────────────────────────────────────────

function getCodespacesUrl() {
  if (process.env.AI_PC_MCP_PUBLIC_URL)
    return process.env.AI_PC_MCP_PUBLIC_URL.replace(/\/$/, "");

  if (process.env.CODESPACE_NAME && process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN)
    return `https://${process.env.CODESPACE_NAME}-${PORT}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}`;

  return null;
}

async function makeCodespacesPortPublic() {
  if (!process.env.CODESPACE_NAME) return;
  console.log(`🌐 Making Codespaces port ${PORT} public...`);
  try {
    await execFileAsync(
      "gh",
      ["codespace", "ports", "visibility", `${PORT}:public`, "-c", process.env.CODESPACE_NAME],
      { timeout: 15_000 }
    );
    console.log(green(`✅ Port ${PORT} is public.`));
  } catch {
    console.log(yellow(
      `⚠️  Could not auto-public port ${PORT}. Open VS Code Ports tab → set to Public.`
    ));
  }
}

// ─── connection info ──────────────────────────────────────────────────────────

function printConnectionInfo(publicUrl) {
  const mcpUrl     = `${publicUrl}/mcp`;
  const bypass     = process.env.AI_PC_MCP_BYPASS === "true";
  const scopeLabel = bypass
    ? "Full filesystem (bypass mode)"
    : (process.env.AI_PC_MCP_ROOT || "folder-scoped");

  // ── separator lines ────────────────────────────────────────────────────────
  const HEAVY = C.bGreen + "═".repeat(64) + C.reset;
  const LIGHT = C.dim    + "─".repeat(64) + C.reset;

  // ── URL box: │  <url>  │  (2-space padding each side) ────────────────────
  const urlInner  = mcpUrl.length + 4;          // 2 left + 2 right padding
  const urlHRule  = "─".repeat(urlInner);
  const arrow     = `${C.cyan}›${C.reset}`;

  console.log();

  // ── "Ready" title ──────────────────────────────────────────────────────────
  console.log(HEAVY);
  console.log(`  ${C.bGreen}✓${C.reset}  ${C.bold}ChatGPT Local MCP${C.reset} — Ready`);
  console.log(HEAVY);
  console.log();

  // ── info rows (label column = 9 chars, aligned) ───────────────────────────
  console.log(`  ${C.dim}Dashboard${C.reset}  ${arrow}  ${publicUrl}/`);
  console.log(`  ${C.dim}Stats    ${C.reset}  ${arrow}  ${publicUrl}/stats`);
  console.log(`  ${C.dim}Scope    ${C.reset}  ${arrow}  ${scopeLabel}`);
  console.log();

  // ── connect instructions ───────────────────────────────────────────────────
  console.log(LIGHT);
  console.log(`  ${C.bold}📋  ChatGPT › Settings › Connectors › Add connector › MCP${C.reset}`);
  console.log(`  ${C.dim}    Authentication: No Auth${C.reset}`);
  console.log(LIGHT);
  console.log();

  // ── MCP URL in its own prominent box ─────────────────────────────────────
  console.log(`  ${C.bCyan}┌${urlHRule}┐${C.reset}`);
  console.log(`  ${C.bCyan}│${C.reset}  ${C.bGreen}${mcpUrl}${C.reset}  ${C.bCyan}│${C.reset}`);
  console.log(`  ${C.bCyan}└${urlHRule}┘${C.reset}`);
  console.log();

  // ── runtime paths ─────────────────────────────────────────────────────────
  console.log(`  ${C.dim}Runtime  ›  ${INSTALL_DIR}${C.reset}`);
  console.log(`  ${C.dim}Logs     ›  ${SERVER_LOG}${C.reset}`);
  if (fsSync.existsSync(CF_LOG)) console.log(`  ${C.dim}         ›  ${CF_LOG}${C.reset}`);

  if (!LOG_MODE) {
    console.log();
    console.log(`  ${C.dim}💡 Tip: run with --log to stream live tool-call logs.${C.reset}`);
  }

  console.log();
  console.log(C.dim + "─".repeat(64) + C.reset);
  console.log();
}

// ─── shutdown ─────────────────────────────────────────────────────────────────

function cleanup(cfProcess) {
  shutdownRequested = true;
  console.log("\nShutting down…");
  if (serverChild) { try { serverChild.kill(); } catch {} }
  if (cfProcess)   { try { cfProcess.kill(); }   catch {} }
  process.exit(0);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  printHeader();

  // Node.js version gate
  const [major] = process.version.replace("v", "").split(".").map(Number);
  if (major < 18) {
    console.error(red("❌ Node.js 18 or higher is required. Please upgrade Node.js."));
    process.exit(1);
  }

  await installRuntime();
  await npmInstall();

  // Determine public URL before server starts (placeholder if cloudflare needed).
  const codespaceUrl = getCodespacesUrl();
  await writeEnvFile(codespaceUrl || "");

  // ── Start watchdog ──────────────────────────────────────────────────────────
  console.log("🛡️  Starting watchdog. It restarts the MCP server if it exits.");
  launchServer();

  // Wait for server to respond to /health.
  const healthy = await waitForServer(30);
  if (!healthy) {
    console.error(red("❌ Server did not become healthy."));
    try {
      const tail = fsSync.readFileSync(SERVER_LOG, "utf8").split("\n").slice(-25).join("\n");
      console.error(tail);
    } catch {}
    cleanup(null);
  }

  // ── Public URL ──────────────────────────────────────────────────────────────
  let publicUrl = `http://localhost:${PORT}`;
  let cfProcess = null;

  if (codespaceUrl) {
    // ─── GitHub Codespaces ───────────────────────────────────────────────────
    publicUrl = codespaceUrl;
    await makeCodespacesPortPublic();
  } else if (process.env.AI_PC_MCP_NO_TUNNEL === "true") {
    // ─── No tunnel requested (--no-tunnel flag) ──────────────────────────────
    console.log(yellow("🔌 Tunnel disabled. MCP server is available locally only."));
    console.log(yellow(`   Add this to ChatGPT only if it can reach your machine directly.`));
  } else {
    // ─── Local / Windows: use cloudflared free tunnel ────────────────────────
    console.log("🌐 Starting cloudflared tunnel...");
    const result = await startCloudflaredTunnel();

    if (result && result.url) {
      publicUrl = result.url;
      cfProcess = result.process;
      console.log(green(`✅ Tunnel established: ${publicUrl}`));
      // Update env file so the server knows its public URL.
      await writeEnvFile(publicUrl);
    } else {
      console.log(yellow(`⚠️  cloudflared tunnel unavailable. Using local URL: http://localhost:${PORT}`));
      console.log(yellow("   The MCP server is running locally. Expose it with ngrok or another tunnel."));
    }
  }

  printConnectionInfo(publicUrl);

  // ── Live log banner ─────────────────────────────────────────────────────────
  if (LOG_MODE) {
    // Flush anything captured before the tunnel was ready, clearly separated.
    flushStartupLogs();

    // Now switch to live streaming mode.
    logBannerShown = true;

    const bar = `${C.bCyan}${"━".repeat(64)}${C.reset}`;
    console.log(bar);
    console.log(`${C.bCyan} 📋 LIVE LOGS${C.reset}  ${C.dim}— new entries stream below in real-time  (Ctrl+C to stop)${C.reset}`);
    console.log(
      `  ${C.dim}HH:MM:SS.mmm${C.reset}` +
      `  ${SRC_STYLES.SERVER.color}[SRV]${C.reset} server` +
      `  ${SRC_STYLES.TUNNEL.color}[TUN]${C.reset} tunnel` +
      `  ${SRC_STYLES.WATCHDOG.color}[WDG]${C.reset} watchdog` +
      `    ${C.bGreen}✓${C.reset} ok  ${C.yellow}⚠${C.reset} warn  ${C.red}✗${C.reset} error`
    );
    console.log(bar);
    console.log();
  }

  // ── Keep alive + graceful shutdown ─────────────────────────────────────────
  const onSignal = () => cleanup(cfProcess);
  process.on("SIGINT",  onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP",  onSignal);   // Handles terminal close on Linux/macOS

  // On Windows, Ctrl+C sends SIGINT — but keep an interval to prevent the
  // event loop from draining while child processes remain alive.
  setInterval(() => {}, 60_000);
}

main().catch((err) => {
  console.error(red(`❌ Fatal error: ${err.message}`));
  process.exit(1);
});
