import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktopMachines, type CommandResult, type CommandRunner } from "./docker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type Call = { argv: string[]; env?: Record<string, string>; input?: string; context?: string[] };

function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "", termination: "exit" };
}

function failed(stderr: string): CommandResult {
  return { code: 1, stdout: "", stderr, termination: "exit" };
}

/** Fake docker: answers by subcommand and records every call, including the build context. */
function fakeDocker(answer: (args: string[]) => CommandResult | undefined) {
  const calls: Call[] = [];
  const run: CommandRunner = async (argv, options) => {
    const args = argv.slice(1);
    const call: Call = { argv: args, ...(options.env ? { env: options.env } : {}) };
    if (options.input !== undefined) {
      call.input = options.input;
    }
    if (args[0] === "build") {
      call.context = fs.readdirSync(args.at(-1)!).toSorted();
    }
    calls.push(call);
    return answer(args) ?? ok();
  };
  return { calls, run };
}

function machinesWith(run: CommandRunner, extraCaCertificates?: string) {
  const assetsDir = tempDirs.make("local-desktop-assets-");
  fs.writeFileSync(path.join(assetsDir, "Dockerfile"), "FROM scratch\n");
  fs.writeFileSync(path.join(assetsDir, "desktop-start.sh"), "#!/bin/sh\n");
  return createDesktopMachines({
    assetsDir,
    instance: "/state/one",
    run,
    ...(extraCaCertificates ? { extraCaCertificates } : {}),
  });
}

const NOT_FOUND = failed("Error response from daemon: No such container: openclaw-desktop-ldk_1");

describe("desktop machines", () => {
  it("builds the image once, then runs a locked-down container on the bot's disk", async () => {
    const ca = path.join(tempDirs.make("local-desktop-ca-"), "ca.pem");
    fs.writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
    const docker = fakeDocker((args) =>
      args[0] === "image" ? failed("No such image") : args[1] === "inspect" ? NOT_FOUND : undefined,
    );
    const machines = machinesWith(docker.run, ca);

    await machines.start({ leaseId: "ldk_1", disk: "Main Bot" });

    const build = docker.calls.find((call) => call.argv[0] === "build");
    expect(build?.context).toEqual(["Dockerfile", "desktop-start.sh", "extra-ca-certificates.pem"]);
    const tag = build?.argv[build.argv.indexOf("--tag") + 1];
    expect(tag).toMatch(/^openclaw-local-desktop:[0-9a-f]{16}$/);
    const volume = docker.calls.find((call) => call.argv[0] === "volume")?.argv.at(-1);
    expect(volume).toMatch(/^openclaw-desktop-[0-9a-f]{8}-main-bot-[0-9a-f]{8}$/);
    const run = docker.calls.find((call) => call.argv[0] === "run")!.argv;
    expect(run).toEqual(
      expect.arrayContaining([
        "--init",
        "--cap-drop",
        "ALL",
        "no-new-privileges",
        `type=volume,source=${volume},target=/home/bot`,
        "openclaw.local-desktop.lease=ldk_1",
      ]),
    );
    expect(run.at(-1)).toBe(tag);
    expect(run.join(" ")).not.toMatch(/--publish|-p /);
    expect(docker.calls.at(-1)?.argv.slice(0, 2)).toEqual(["exec", "openclaw-desktop-ldk_1"]);

    await machines.start({ leaseId: "ldk_2", disk: "Main Bot" });
    expect(docker.calls.filter((call) => call.argv[0] === "image")).toHaveLength(1);
  });

  it("adopts a running container and restarts a stopped one without creating another", async () => {
    let status = "running";
    const docker = fakeDocker((args) =>
      args[1] === "inspect" && args[0] === "container" ? ok(`ldk_1 ${status}`) : undefined,
    );
    const machines = machinesWith(docker.run);

    await machines.start({ leaseId: "ldk_1", disk: "main" });
    status = "exited";
    await machines.start({ leaseId: "ldk_1", disk: "main" });

    expect(docker.calls.some((call) => call.argv[0] === "run")).toBe(false);
    expect(docker.calls.filter((call) => call.argv[0] === "start")).toHaveLength(1);
  });

  it("reports the start script's log when the desktop never becomes ready", async () => {
    const docker = fakeDocker((args) =>
      args[0] === "exec"
        ? failed("")
        : args[0] === "logs"
          ? ok("X server did not start")
          : args[1] === "inspect" && args[0] === "container"
            ? NOT_FOUND
            : undefined,
    );
    await expect(
      machinesWith(docker.run).start({ leaseId: "ldk_1", disk: "main" }),
    ).rejects.toThrow("The computer's desktop did not start: X server did not start");
  });

  it("passes secrets to exec by name only", async () => {
    const docker = fakeDocker(() => ok("done"));
    const output = await machinesWith(docker.run).exec("ldk_1", ["node", "-"], {
      timeoutMs: 1000,
      input: "script",
      env: { SECRET_TOKEN: "s3cret" },
    });

    expect(output).toBe("done");
    const call = docker.calls[0]!;
    expect(call.argv).toEqual([
      "exec",
      "--interactive",
      "--env",
      "SECRET_TOKEN",
      "openclaw-desktop-ldk_1",
      "node",
      "-",
    ]);
    expect(call.env).toEqual({ SECRET_TOKEN: "s3cret" });
    expect(call.input).toBe("script");
  });

  it("separates absent, stopped and foreign containers", async () => {
    const answers: Record<string, CommandResult> = {
      ldk_gone: NOT_FOUND,
      ldk_off: ok("ldk_off exited"),
      ldk_foreign: ok(" running"),
    };
    const docker = fakeDocker((args) =>
      args[1] === "inspect" ? answers[args.at(-1)!.replace("openclaw-desktop-", "")] : undefined,
    );
    const machines = machinesWith(docker.run);

    await expect(machines.state("ldk_gone")).resolves.toBe("absent");
    await expect(machines.state("ldk_off")).resolves.toBe("stopped");
    await expect(machines.remove("ldk_foreign")).rejects.toThrow("does not belong");
    await machines.remove("ldk_gone");
    await machines.remove("ldk_off");
    expect(
      docker.calls.filter((call) => call.argv[0] === "rm").map((call) => call.argv.at(-1)),
    ).toEqual(["openclaw-desktop-ldk_off"]);
  });

  it("turns engine failures into next steps instead of reporting a missing computer", async () => {
    const down = machinesWith(
      fakeDocker(() => failed("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"))
        .run,
    );
    await expect(down.state("ldk_1")).rejects.toThrow("Docker is not running");

    const missing = machinesWith(async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" });
    });
    await expect(missing.holders("main")).rejects.toThrow("Docker is not installed");
  });

  it("lists disk holders for this install and reads the bridge address", async () => {
    const docker = fakeDocker((args) =>
      args[0] === "ps"
        ? ok("ldk_1\nldk_2\n")
        : args[0] === "network"
          ? ok("fd00::1 172.17.0.1 ")
          : undefined,
    );
    const machines = machinesWith(docker.run);

    await expect(machines.holders("main")).resolves.toEqual(["ldk_1", "ldk_2"]);
    const filters = docker.calls[0]!.argv.filter((arg) => arg.startsWith("label="));
    expect(filters).toEqual([
      expect.stringMatching(/^label=openclaw\.local-desktop\.instance=[0-9a-f]{8}$/),
      expect.stringMatching(/^label=openclaw\.local-desktop\.disk=main-[0-9a-f]{8}$/),
    ]);
    await expect(machines.bridgeAddress()).resolves.toBe("172.17.0.1");
  });
});
