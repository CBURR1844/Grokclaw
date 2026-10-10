import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

/** Exit facts from one engine command; mirrors the SDK command runner result. */
export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  termination: "exit" | "timeout" | "no-output-timeout" | "signal";
};

export type CommandRunner = (
  argv: string[],
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    input?: string;
    env?: Record<string, string>;
  },
) => Promise<CommandResult>;

export type MachineState = "running" | "stopped" | "absent";

/** One bot computer per lease, on Docker, with its home on a disk that outlives the lease. */
export type DesktopMachines = {
  /** Run or adopt the lease's container and resolve once its desktop accepts clients. */
  start: (machine: { leaseId: string; disk: string }, signal?: AbortSignal) => Promise<void>;
  /** Run argv inside the container as the desktop user. Secrets travel in env, never argv. */
  exec: (
    leaseId: string,
    argv: string[],
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      input?: string;
      env?: Record<string, string>;
    },
  ) => Promise<string>;
  state: (leaseId: string) => Promise<MachineState>;
  /** Idempotent; keeps the disk. */
  remove: (leaseId: string) => Promise<void>;
  /** Leases whose containers, running or stopped, hold this disk. */
  holders: (disk: string) => Promise<string[]>;
  /** Host address of Docker's default bridge, where containers reach this machine. */
  bridgeAddress: () => Promise<string>;
};

const DOCKER = "docker";
const IMAGE_REPOSITORY = "openclaw-local-desktop";
const LABEL = "openclaw.local-desktop";
const HOME = "/home/bot";
const READY_FILE = "/tmp/openclaw-desktop/ready";
const COMMAND_TIMEOUT_MS = 60_000;
// A first build downloads a desktop and a Node runtime; slow links need the headroom.
export const IMAGE_BUILD_TIMEOUT_MS = 30 * 60_000;
const READY_TIMEOUT_SECONDS = 120;

const defaultRunner: CommandRunner = async (argv, options) =>
  await runCommandWithTimeout(argv, {
    timeoutMs: options.timeoutMs,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(options.env ? { env: options.env } : {}),
    maxOutputBytes: 1024 * 1024,
    killProcessTree: true,
  });

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/** Docker names allow [a-zA-Z0-9_.-]; keep a readable prefix and make it unique with a hash. */
function dockerSafeName(value: string): string {
  const readable = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `${readable || "disk"}-${digest(value, 8)}`;
}

function tail(text: string, bytes = 2000): string {
  const trimmed = text.trim();
  return trimmed.length > bytes ? `…${trimmed.slice(-bytes)}` : trimmed;
}

function engineError(action: string, result: CommandResult): Error {
  const detail = tail(result.stderr || result.stdout);
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(detail)) {
    return new Error("Docker is not running. Start Docker, then try again.");
  }
  if (result.termination === "timeout") {
    return new Error(`Docker timed out while trying to ${action}.`);
  }
  return new Error(`Docker could not ${action}${detail ? `: ${detail}` : "."}`);
}

function isMissing(result: CommandResult): boolean {
  return /no such (container|object)/i.test(result.stderr);
}

export function createDesktopMachines(params: {
  /** Directory holding the image's Dockerfile and start script. */
  assetsDir: string;
  /** Keeps two OpenClaw installs on one Docker host from sharing containers or disks. */
  instance: string;
  /** CA bundle the image trusts; defaults to the Gateway's NODE_EXTRA_CA_CERTS. */
  extraCaCertificates?: string;
  run?: CommandRunner;
}): DesktopMachines {
  const run = params.run ?? defaultRunner;
  const instance = digest(params.instance, 8);
  const containerName = (leaseId: string) => `openclaw-desktop-${leaseId}`;
  const diskLabel = (disk: string) => dockerSafeName(disk);
  let image: Promise<string> | undefined;

  const docker = async (
    action: string,
    args: string[],
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
      input?: string;
      env?: Record<string, string>;
    } = {},
  ): Promise<CommandResult> => {
    let result: CommandResult;
    try {
      result = await run([DOCKER, ...args], { timeoutMs: COMMAND_TIMEOUT_MS, ...options });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error("Docker is not installed. Install Docker Engine, then try again.", {
          cause: error,
        });
      }
      throw error;
    }
    options.signal?.throwIfAborted();
    if (result.code !== 0 && /cannot connect to the docker daemon/i.test(result.stderr)) {
      throw engineError(action, result);
    }
    return result;
  };

  const checked = async (...args: Parameters<typeof docker>): Promise<string> => {
    const result = await docker(...args);
    if (result.code !== 0) {
      throw engineError(args[0], result);
    }
    return result.stdout.trim();
  };

  // The tag is the content hash of the build context, so edits rebuild and replays reuse.
  const ensureImage = (signal?: AbortSignal): Promise<string> => {
    image ??= (async () => {
      const context = new Map<string, Buffer>();
      for (const file of await fs.readdir(params.assetsDir)) {
        context.set(file, await fs.readFile(path.join(params.assetsDir, file)));
      }
      const extraCa = params.extraCaCertificates ?? process.env.NODE_EXTRA_CA_CERTS;
      context.set(
        "extra-ca-certificates.pem",
        extraCa ? await fs.readFile(extraCa) : Buffer.alloc(0),
      );
      const hash = createHash("sha256");
      for (const [file, bytes] of [...context].toSorted(([a], [b]) => a.localeCompare(b))) {
        hash.update(`${file}\0${bytes.length}\0`).update(bytes);
      }
      const tag = `${IMAGE_REPOSITORY}:${hash.digest("hex").slice(0, 16)}`;
      const present = await docker("inspect the desktop image", ["image", "inspect", tag], {
        signal,
      });
      if (present.code === 0) {
        return tag;
      }
      const dir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "desktop-image-"));
      try {
        for (const [file, bytes] of context) {
          await fs.writeFile(path.join(dir, file), bytes);
        }
        await checked(
          "build the desktop image",
          ["build", "--quiet", "--label", `${LABEL}.image=1`, "--tag", tag, dir],
          { timeoutMs: IMAGE_BUILD_TIMEOUT_MS, signal },
        );
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
      return tag;
    })().catch((error: unknown) => {
      image = undefined;
      throw error;
    });
    return image;
  };

  const inspect = async (leaseId: string): Promise<{ lease: string; status: string } | null> => {
    const result = await docker("inspect a computer", [
      "container",
      "inspect",
      "--format",
      `{{index .Config.Labels "${LABEL}.lease"}} {{.State.Status}}`,
      containerName(leaseId),
    ]);
    if (result.code !== 0) {
      if (isMissing(result)) {
        return null;
      }
      throw engineError("inspect a computer", result);
    }
    const [lease = "", status = ""] = result.stdout.trim().split(" ");
    return { lease, status };
  };

  const owned = async (leaseId: string) => {
    const found = await inspect(leaseId);
    if (found && found.lease !== leaseId) {
      throw new Error(`Container ${containerName(leaseId)} does not belong to this computer.`);
    }
    return found;
  };

  const logs = async (leaseId: string): Promise<string> => {
    const result = await docker("read computer logs", [
      "logs",
      "--tail",
      "40",
      containerName(leaseId),
    ]);
    return tail(`${result.stdout}\n${result.stderr}`);
  };

  return {
    async start({ leaseId, disk }, signal) {
      const imageTag = await ensureImage(signal);
      const found = await owned(leaseId);
      if (!found) {
        const label = diskLabel(disk);
        const volume = `openclaw-desktop-${instance}-${label}`;
        await checked(
          "create the computer's disk",
          [
            "volume",
            "create",
            "--label",
            `${LABEL}.instance=${instance}`,
            "--label",
            `${LABEL}.disk=${label}`,
            volume,
          ],
          { signal },
        );
        // Non-root desktop with no capabilities; RFB stays on the container loopback and the
        // guest node relays it, so no port is published.
        await checked(
          "start the computer",
          [
            "run",
            "--detach",
            "--init",
            "--name",
            containerName(leaseId),
            "--hostname",
            "computer",
            "--label",
            `${LABEL}.lease=${leaseId}`,
            "--label",
            `${LABEL}.instance=${instance}`,
            "--label",
            `${LABEL}.disk=${label}`,
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--memory",
            "2g",
            "--shm-size",
            "256m",
            "--mount",
            `type=volume,source=${volume},target=${HOME}`,
            imageTag,
          ],
          { signal },
        );
      } else if (found.status !== "running") {
        await checked("restart the computer", ["start", containerName(leaseId)], { signal });
      }
      const ready = await docker(
        "wait for the computer's desktop",
        [
          "exec",
          containerName(leaseId),
          "sh",
          "-c",
          `i=0; until [ -e ${READY_FILE} ]; do i=$((i+1)); [ "$i" -gt ${READY_TIMEOUT_SECONDS * 10} ] && exit 1; sleep 0.1; done`,
        ],
        { timeoutMs: (READY_TIMEOUT_SECONDS + 30) * 1000, signal },
      );
      if (ready.code !== 0) {
        throw new Error(`The computer's desktop did not start: ${await logs(leaseId)}`);
      }
    },

    async exec(leaseId, argv, options) {
      const envNames = Object.keys(options.env ?? {});
      // `--env NAME` copies the value from the docker CLI's own environment.
      const result = await docker(
        "run a command on the computer",
        [
          "exec",
          ...(options.input !== undefined ? ["--interactive"] : []),
          ...envNames.flatMap((name) => ["--env", name]),
          containerName(leaseId),
          ...argv,
        ],
        options,
      );
      if (result.code !== 0) {
        throw new Error(tail(result.stderr || result.stdout) || `exit code ${result.code}`);
      }
      return result.stdout;
    },

    async state(leaseId) {
      const found = await owned(leaseId);
      return !found ? "absent" : found.status === "running" ? "running" : "stopped";
    },

    async remove(leaseId) {
      if (!(await owned(leaseId))) {
        return;
      }
      const result = await docker("remove the computer", ["rm", "--force", containerName(leaseId)]);
      if (result.code !== 0 && !isMissing(result)) {
        throw engineError("remove the computer", result);
      }
    },

    async holders(disk) {
      const output = await checked("list computers", [
        "ps",
        "--all",
        "--filter",
        `label=${LABEL}.instance=${instance}`,
        "--filter",
        `label=${LABEL}.disk=${diskLabel(disk)}`,
        "--format",
        `{{.Label "${LABEL}.lease"}}`,
      ]);
      return output.split("\n").filter(Boolean);
    },

    async bridgeAddress() {
      const output = await checked("read Docker's bridge network", [
        "network",
        "inspect",
        "bridge",
        "--format",
        "{{range .IPAM.Config}}{{.Gateway}} {{end}}",
      ]);
      const address = output.split(" ").find((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value));
      if (!address) {
        throw new Error("Docker's default bridge network has no IPv4 gateway address.");
      }
      return address;
    },
  };
}
