import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";

/** Core-issued enrollment for one provision; the SDK does not export the type by name. */
export type NodeEnrollment = Awaited<
  ReturnType<
    NonNullable<NonNullable<Parameters<WorkerProvider["provision"]>[2]>["beginNodeEnrollment"]>
  >
>;

/** Runs argv inside the computer as the desktop user; see DesktopMachines.exec. */
export type GuestExec = (
  argv: string[],
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    input?: string;
    env?: Record<string, string>;
  },
) => Promise<string>;

const TOKEN_ENV = "LOCAL_DESKTOP_BOOTSTRAP_TOKEN";
const SETUP_CODE_ENV = "LOCAL_DESKTOP_SETUP_CODE";
// Lives in the container layer, so node identity ends with the lease while the disk stays.
const NODE_STATE_DIR = "/var/lib/openclaw-desktop/node";
const NODE_LOG = `${NODE_STATE_DIR}/node.log`;
// Written by the image's start script.
const SESSION_ENV = "/tmp/openclaw-desktop/session.env";
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 20 * 60_000;

// Runs as `node -` in the guest. Credentials arrive only in its private environment and
// are deleted before any child starts. The runtime is cached on the bot's disk by content
// hash, so reopening a computer on the same Gateway build skips the download and install.
const GUEST_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const plan = JSON.parse(process.env.LOCAL_DESKTOP_PLAN);
const token = process.env.${TOKEN_ENV};
const setupCode = process.env.${SETUP_CODE_ENV};
delete process.env.LOCAL_DESKTOP_PLAN;
delete process.env.${TOKEN_ENV};
delete process.env.${SETUP_CODE_ENV};
process.umask(0o077);
const { bootstrap, mode, displayName, stateDir } = plan;
const runtimeRoot = path.join(process.env.HOME, ".cache", "openclaw-desktop", "runtimes");
const runtimeDir = path.join(runtimeRoot, bootstrap.sha256);
const packageRoot = path.join(runtimeDir, "node_modules", "openclaw");
const cli = path.join(packageRoot, "openclaw.mjs");
const pidFile = path.join(stateDir, "node.pid");
const guestPidFile = path.join(stateDir, "guest.pid");
const RUN_MARKER = "LOCAL_DESKTOP_RUN=" + stateDir;
const setupFile = path.join(stateDir, "setup-code");
const session = Object.fromEntries(
  fs.readFileSync(plan.sessionEnv, "utf8").split("\n").filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const nodeEnv = {
  ...process.env,
  ...session,
  OPENCLAW_STATE_DIR: stateDir,
  PATH: path.join(packageRoot, "dist", "worker-tools", "bin") + ":" + process.env.PATH,
};
// Install and setup subprocesses carry the run marker; the node does not.
const env = { ...nodeEnv, LOCAL_DESKTOP_RUN: stateDir };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const subprocessFailure = (message, result) =>
  new Error(message + " (" + (result.error?.message || result.signal || "exit code " + result.status) + "): " + String(result.stderr || "").trim().slice(-1500));

const downloadOnce = async (archive) => {
  const url = new URL(bootstrap.url);
  const normalize = (value) => value.trim().replace(/^sha256:/i, "").replaceAll(":", "").toLowerCase();
  const pin = bootstrap.tlsFingerprint ? normalize(bootstrap.tlsFingerprint) : undefined;
  if (pin && url.protocol !== "https:") throw new Error("pinned bootstrap download must use https");
  const request = (url.protocol === "https:" ? https : http).request(url, {
    agent: false,
    headers: { authorization: "Bearer " + token },
    ...(pin ? { rejectUnauthorized: false } : {}),
  });
  // Every failure surfaces once, through the response promise; keep the rest observed.
  request.on("error", () => {});
  request.once("response", (response) => response.on("error", () => {}));
  const pending = once(request, "response");
  // The bearer token is written only after the pinned certificate is verified.
  void (async () => {
    if (pin) {
      const [socket] = await once(request, "socket");
      await once(socket, "secureConnect");
      if (normalize(socket.getPeerCertificate().fingerprint256 || "") !== pin) {
        throw new Error("Gateway certificate does not match its pinned fingerprint");
      }
    }
    request.end();
  })().catch((error) => request.destroy(error));
  const [response] = await pending;
  if (response.statusCode !== 200) {
    response.resume();
    throw Object.assign(new Error("HTTP " + response.statusCode), { retry: response.statusCode >= 500 });
  }
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(archive, { mode: 0o600 });
  let bytes = 0;
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > bootstrap.bytes) throw new Error("bootstrap archive is larger than declared");
    hash.update(chunk);
    if (!out.write(chunk)) await once(out, "drain");
  }
  out.end();
  await once(out, "close");
  if (bytes !== bootstrap.bytes || hash.digest("hex") !== bootstrap.sha256) {
    throw new Error("bootstrap archive failed integrity verification");
  }
};

const download = async (archive) => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadOnce(archive);
    } catch (error) {
      const network = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"].includes(error.code);
      if (attempt >= 3 || !(network || error.retry)) {
        throw new Error("Could not download OpenClaw from the Gateway at " + new URL(bootstrap.url).origin + ": " + error.message, { cause: error });
      }
      fs.rmSync(archive, { force: true });
      await sleep(1000 * attempt);
    }
  }
};

const verifyRuntime = (root) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "openclaw", "package.json"), "utf8"));
  if (manifest.name !== "openclaw" || manifest.version !== bootstrap.openclawVersion) {
    throw new Error("installed OpenClaw does not match the Gateway version " + bootstrap.openclawVersion);
  }
  const probe = spawnSync(process.execPath, [path.join(root, "node_modules", "openclaw", "openclaw.mjs"), "--version"], { env, encoding: "utf8", timeout: 60000 });
  const expected = "OpenClaw " + bootstrap.openclawVersion;
  const version = String(probe.stdout || "").trim();
  if (probe.status !== 0 || (version !== expected && !version.startsWith(expected + " "))) {
    throw subprocessFailure("installed OpenClaw failed its version check", probe);
  }
};

const install = async () => {
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(path.join(runtimeRoot, "stage-"));
  try {
    const archive = path.join(stage, "openclaw.tgz");
    const target = path.join(stage, "runtime");
    await download(archive);
    fs.mkdirSync(target, { mode: 0o700 });
    // npm 12 requires an install-script policy; trust only the verified archive.
    fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ private: true, allowScripts: { ["file:" + archive]: true } }));
    const npm = spawnSync("npm", ["install", "--prefix", target, "--omit=dev", "--no-save", "--package-lock=false", "--no-audit", "--no-fund", "--ignore-scripts=false", archive], { cwd: stage, env, encoding: "utf8", timeout: 600000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 });
    if (npm.status !== 0) throw subprocessFailure("npm could not install OpenClaw", npm);
    verifyRuntime(target);
    fs.renameSync(target, runtimeDir);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
};

const processes = () => {
  try { return fs.readdirSync("/proc").filter((entry) => /^[0-9]+$/.test(entry)).map(Number); } catch { return []; }
};
const procFile = (pid, name) => {
  try { return fs.readFileSync("/proc/" + pid + "/" + name, "utf8"); } catch { return ""; }
};

// A Gateway that dies mid-open leaves its guest run going in the container, and core replays the
// open. The newest run wins: it stops the earlier run and everything that run started, which all
// carry the run marker, before touching the runtime cache or the node.
const stopEarlierRun = async () => {
  let earlier;
  try { earlier = Number(fs.readFileSync(guestPidFile, "utf8").trim()); } catch {}
  if (earlier > 1 && earlier !== process.pid && procFile(earlier, "cmdline") === procFile("self", "cmdline")) {
    try { process.kill(earlier, "SIGKILL"); } catch {}
  }
  for (let pass = 0; pass < 100; pass++) {
    const left = processes().filter((pid) => pid !== process.pid && procFile(pid, "environ").split("\0").includes(RUN_MARKER));
    if (left.length === 0) break;
    for (const pid of left) try { process.kill(pid, "SIGKILL"); } catch {}
    await sleep(100);
  }
  fs.writeFileSync(guestPidFile, process.pid + "\n");
};

// A replayed provision replaces the node it started earlier in this container. OpenClaw rewrites
// its process title, so the node is recognized by the state directory in its environment.
const stopPrevious = async () => {
  let pid;
  try { pid = Number(fs.readFileSync(pidFile, "utf8").trim()); } catch { return; }
  const alive = () => procFile(pid, "environ").split("\0").includes("OPENCLAW_STATE_DIR=" + stateDir);
  if (pid > 1 && alive()) {
    try { process.kill(-pid, "SIGTERM"); } catch {}
    for (let waited = 0; waited < 10000 && alive(); waited += 100) await sleep(100);
    if (alive()) try { process.kill(-pid, "SIGKILL"); } catch {}
  }
  fs.rmSync(pidFile, { force: true });
};

(async () => {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  await stopEarlierRun();
  if (fs.existsSync(runtimeDir)) verifyRuntime(runtimeDir);
  else await install();
  for (const entry of fs.readdirSync(runtimeRoot)) {
    if (entry !== bootstrap.sha256) fs.rmSync(path.join(runtimeRoot, entry), { recursive: true, force: true });
  }
  await stopPrevious();
  const plugins = [...new Set([...bootstrap.enabledPluginIds, "cua-computer"])];
  const enabled = spawnSync(process.execPath, [cli, "plugins", "enable", ...plugins], { env, encoding: "utf8", timeout: 60000 * plugins.length });
  if (enabled.status !== 0) throw subprocessFailure("could not enable plugins " + plugins.join(", "), enabled);
  let args = ["node", "run"];
  if (mode === "connect") {
    if (!setupCode) throw new Error("enrollment setup code is missing");
    fs.writeFileSync(setupFile, setupCode + "\n", { mode: 0o600 });
    args = ["connect", "--target-file", setupFile];
  }
  const log = fs.openSync(path.join(stateDir, "node.log"), "a", 0o600);
  const child = spawn(process.execPath, [cli, ...args, "--ephemeral", "--display-name", displayName], { cwd: runtimeDir, env: nodeEnv, detached: true, stdio: ["ignore", log, log] });
  await once(child, "spawn");
  fs.writeFileSync(pidFile, child.pid + "\n");
  child.unref();
  fs.closeSync(log);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
`;

/** Install the Gateway's exact OpenClaw build in the computer and start its node. */
export async function launchGuestNode(
  exec: GuestExec,
  enrollment: NodeEnrollment,
  signal?: AbortSignal,
): Promise<void> {
  const { token, ...bootstrap } = enrollment.nodeBootstrap;
  const plan = {
    bootstrap,
    mode: enrollment.mode,
    displayName: enrollment.displayName,
    stateDir: NODE_STATE_DIR,
    sessionEnv: SESSION_ENV,
  };
  try {
    await exec(["node", "-"], {
      input: GUEST_SCRIPT,
      timeoutMs: enrollment.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
      env: {
        LOCAL_DESKTOP_PLAN: JSON.stringify(plan),
        [TOKEN_ENV]: token,
        ...(enrollment.mode === "connect" ? { [SETUP_CODE_ENV]: enrollment.setupCode } : {}),
      },
    });
  } catch (error) {
    throw new Error(
      `Could not start OpenClaw on the computer: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Last lines of the guest node's log, for a failed enrollment's error message. */
export async function readGuestNodeLog(exec: GuestExec, signal?: AbortSignal): Promise<string> {
  try {
    return (
      await exec(["tail", "-c", "2000", NODE_LOG], {
        timeoutMs: 15_000,
        ...(signal ? { signal } : {}),
      })
    ).trim();
  } catch {
    return "";
  }
}
