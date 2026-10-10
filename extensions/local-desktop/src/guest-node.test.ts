import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
  useAutoCleanupTempDirTracker,
} from "openclaw/plugin-sdk/test-env";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { launchGuestNode, type GuestExec, type NodeEnrollment } from "./guest-node.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const VERSION = "2026.9.9";
const ARCHIVE = Buffer.from("synthetic openclaw archive");
const SHA = createHash("sha256").update(ARCHIVE).digest("hex");
const TOKEN = "synthetic-bootstrap-token";
const SETUP_CODE = "synthetic-setup-code";

let receipts: FixtureReceiptChannel;
const servers: Array<http.Server> = [];
const nodePids: number[] = [];
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
afterEach(async () => {
  for (const pid of nodePids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
});

/**
 * A computer stand-in: a home directory, the start script's session file, a node state
 * directory, a fake `npm` that installs a fixture OpenClaw package, and an exec that runs
 * argv on this host with the container paths mapped into the temp directory.
 */
function guest() {
  const root = tempDirs.make("local-desktop-guest-");
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const fixturePackage = path.join(root, "package");
  const stateDir = path.join(root, "node");
  const sessionEnv = path.join(root, "session.env");
  const npmCalls = path.join(root, "npm-calls");
  for (const dir of [home, bin, fixturePackage]) {
    fs.mkdirSync(dir);
  }
  fs.writeFileSync(sessionEnv, "DISPLAY=:1\nDBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/bus\n");
  fs.writeFileSync(
    path.join(fixturePackage, "package.json"),
    JSON.stringify({ name: "openclaw", version: VERSION }),
  );
  fs.writeFileSync(
    path.join(fixturePackage, "openclaw.mjs"),
    `import fs from "node:fs";
import path from "node:path";
${fixtureReceiptClientSource(receipts.endpoint)}
const args = process.argv.slice(2);
const state = process.env.OPENCLAW_STATE_DIR;
if (args[0] === "--version") {
  console.log("OpenClaw ${VERSION}");
} else if (args[0] === "plugins") {
  fs.appendFileSync(path.join(state, "plugins-enabled"), args.slice(2).join(" ") + "\\n");
} else {
  // Like OpenClaw, the node rewrites its command line.
  process.title = "openclaw-node";
  const targetFile = args[args.indexOf("--target-file") + 1];
  fs.writeFileSync(path.join(state, "launch-" + process.pid + ".json"), JSON.stringify({
    args,
    cwd: process.cwd(),
    setupCode: args.includes("--target-file") ? fs.readFileSync(targetFile, "utf8") : undefined,
    display: process.env.DISPLAY,
    leaked: Object.keys(process.env).filter((name) => name.startsWith("LOCAL_DESKTOP_")),
  }));
  sendReceipt("node-" + process.pid, "launched");
  await awaitRelease("node-" + process.pid, "stop");
}
`,
  );
  // `holdInstall()` makes the next install wait, like a slow npm, until something kills it.
  const holdFile = path.join(root, "hold-install");
  const npmScript = path.join(root, "npm.mjs");
  fs.writeFileSync(
    npmScript,
    `import fs from "node:fs";
import path from "node:path";
${fixtureReceiptClientSource(receipts.endpoint)}
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(npmCalls)}, args.join(" ") + "\\n");
if (fs.existsSync(${JSON.stringify(holdFile)})) {
  fs.rmSync(${JSON.stringify(holdFile)});
  sendReceipt(${JSON.stringify(holdFile)}, "installing");
  await awaitRelease(${JSON.stringify(holdFile)}, "never");
}
const target = args[args.indexOf("--prefix") + 1];
fs.cpSync(${JSON.stringify(fixturePackage)}, path.join(target, "node_modules", "openclaw"), { recursive: true });
`,
  );
  const npm = path.join(bin, "npm");
  fs.writeFileSync(npm, `#!/bin/sh\nexec node ${JSON.stringify(npmScript)} "$@"\n`);
  fs.chmodSync(npm, 0o755);
  const holdInstall = () => {
    fs.writeFileSync(holdFile, "");
    return holdFile;
  };

  const exec: GuestExec = async (argv, options) => {
    const planned = JSON.parse(options.env?.LOCAL_DESKTOP_PLAN ?? "{}") as Record<string, unknown>;
    const result = await runCommandWithTimeout(argv, {
      timeoutMs: options.timeoutMs,
      ...(options.input !== undefined ? { input: options.input } : {}),
      env: {
        ...options.env,
        LOCAL_DESKTOP_PLAN: JSON.stringify({ ...planned, stateDir, sessionEnv }),
        HOME: home,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `exit ${String(result.code)}`);
    }
    return result.stdout;
  };

  const runtimes = path.join(home, ".cache", "openclaw-desktop", "runtimes");
  const launchedPid = () => {
    const pid = Number(fs.readFileSync(path.join(stateDir, "node.pid"), "utf8"));
    nodePids.push(pid);
    return pid;
  };
  const launchRecord = (pid: number) =>
    JSON.parse(fs.readFileSync(path.join(stateDir, `launch-${pid}.json`), "utf8")) as {
      args: string[];
      cwd: string;
      setupCode?: string;
      display?: string;
      leaked: string[];
    };
  const npmRuns = () =>
    fs.existsSync(npmCalls) ? fs.readFileSync(npmCalls, "utf8").trim().split("\n") : [];
  return { exec, stateDir, runtimes, launchedPid, launchRecord, npmRuns, holdInstall };
}

/** Bootstrap artifact server; records each request's authorization header. */
async function gateway(options: { tls?: boolean; body?: Buffer } = {}) {
  const seen: Array<string | undefined> = [];
  const handler: http.RequestListener = (request, response) => {
    seen.push(request.headers.authorization);
    response.end(options.body ?? ARCHIVE);
  };
  const server = options.tls
    ? https.createServer({ cert: PROXY_FIXTURE_CERTIFICATE, key: PROXY_FIXTURE_KEY }, handler)
    : http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { url: `${options.tls ? "https" : "http"}://127.0.0.1:${port}/artifact`, seen };
}

function enrollment(
  url: string,
  overrides: Partial<NodeEnrollment["nodeBootstrap"]> = {},
  mode: "connect" | "resume" = "connect",
): NodeEnrollment {
  return {
    displayName: "Cloud worker computer-main",
    waitForDeviceId: async () => "device-1",
    nodeBootstrap: {
      url,
      token: TOKEN,
      sha256: SHA,
      bytes: ARCHIVE.length,
      openclawVersion: VERSION,
      enabledPluginIds: ["device-pair"],
      ...overrides,
    },
    ...(mode === "connect"
      ? { mode, setupCode: SETUP_CODE, setupId: "setup-1" }
      : { mode, deviceId: "device-1" }),
  } as NodeEnrollment;
}

describe("guest node bootstrap", () => {
  it("installs the Gateway's exact build over a pinned connection and connects the node", async () => {
    const computer = guest();
    const server = await gateway({ tls: true });
    const pin = new X509Certificate(PROXY_FIXTURE_CERTIFICATE).fingerprint256;

    await launchGuestNode(computer.exec, enrollment(server.url, { tlsFingerprint: pin }));
    const pid = computer.launchedPid();
    await receipts.waitFor(`node-${pid}`, "launched");

    expect(server.seen).toEqual([`Bearer ${TOKEN}`]);
    const launch = computer.launchRecord(pid);
    expect(launch.args).toEqual([
      "connect",
      "--target-file",
      path.join(computer.stateDir, "setup-code"),
      "--ephemeral",
      "--display-name",
      "Cloud worker computer-main",
    ]);
    expect(launch.setupCode).toBe(`${SETUP_CODE}\n`);
    expect(launch.display).toBe(":1");
    expect(launch.leaked).toEqual([]);
    expect(launch.cwd).toBe(path.join(computer.runtimes, SHA));
    expect(fs.readFileSync(path.join(computer.stateDir, "plugins-enabled"), "utf8")).toBe(
      "device-pair cua-computer\n",
    );
    expect(fs.statSync(path.join(computer.stateDir, "setup-code")).mode & 0o777).toBe(0o600);
  });

  // The guest recognizes earlier runs through /proc; it only ever runs in a Linux computer.
  it.runIf(process.platform === "linux")(
    "reuses the cached runtime and replaces the node a replay started earlier",
    async () => {
      const computer = guest();
      const server = await gateway();
      fs.mkdirSync(path.join(computer.runtimes, "stale-build"), { recursive: true });

      await launchGuestNode(computer.exec, enrollment(server.url));
      const first = computer.launchedPid();
      await receipts.waitFor(`node-${first}`, "launched");
      await launchGuestNode(computer.exec, enrollment(server.url, {}, "resume"));
      const second = computer.launchedPid();
      await receipts.waitFor(`node-${second}`, "launched");

      await receipts.waitForExit(`node-${first}`);
      expect(second).not.toBe(first);
      expect(computer.launchRecord(second).args).toEqual([
        "node",
        "run",
        "--ephemeral",
        "--display-name",
        "Cloud worker computer-main",
      ]);
      expect(server.seen).toHaveLength(1);
      expect(computer.npmRuns()).toHaveLength(1);
      expect(fs.readdirSync(computer.runtimes)).toEqual([SHA]);
      receipts.release(`node-${second}`, "stop");
      await receipts.waitForExit(`node-${second}`);
    },
  );

  it.runIf(process.platform === "linux")(
    "stops an earlier run that is still installing before the replay installs",
    async () => {
      const computer = guest();
      const server = await gateway();
      const held = computer.holdInstall();

      const orphan = launchGuestNode(computer.exec, enrollment(server.url));
      const orphanFailed = expect(orphan).rejects.toThrow(
        "Could not start OpenClaw on the computer",
      );
      await receipts.waitFor(held, "installing");
      await launchGuestNode(computer.exec, enrollment(server.url));
      const node = computer.launchedPid();
      await receipts.waitFor(`node-${node}`, "launched");

      await orphanFailed;
      await receipts.waitForExit(held);
      expect(computer.npmRuns()).toHaveLength(2);
      expect(fs.readdirSync(computer.runtimes)).toEqual([SHA]);
      expect(computer.launchRecord(node).leaked).toEqual([]);
      receipts.release(`node-${node}`, "stop");
      await receipts.waitForExit(`node-${node}`);
    },
  );

  it("installs nothing and starts nothing when the archive fails verification", async () => {
    const computer = guest();
    const server = await gateway({ body: Buffer.from("tampered openclaw archive!") });

    await expect(launchGuestNode(computer.exec, enrollment(server.url))).rejects.toThrow(
      `Could not start OpenClaw on the computer: Could not download OpenClaw from the Gateway at ${new URL(server.url).origin}: bootstrap archive failed integrity verification`,
    );
    expect(computer.npmRuns()).toEqual([]);
    expect(fs.readdirSync(computer.runtimes)).toEqual([]);
    expect(fs.existsSync(path.join(computer.stateDir, "node.pid"))).toBe(false);
  });

  it("never sends the token to a Gateway whose certificate does not match the pin", async () => {
    const computer = guest();
    const server = await gateway({ tls: true });

    // The whole error is the refusal; nothing else in the script fails after it.
    await expect(
      launchGuestNode(
        computer.exec,
        enrollment(server.url, { tlsFingerprint: `sha256:${"00".repeat(32)}` }),
      ),
    ).rejects.toThrow(
      new Error(
        `Could not start OpenClaw on the computer: Could not download OpenClaw from the Gateway at ${new URL(server.url).origin}: Gateway certificate does not match its pinned fingerprint`,
      ),
    );
    expect(server.seen).toEqual([]);
  });
});
