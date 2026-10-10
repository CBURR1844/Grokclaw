import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import type { DesktopMachines, MachineState } from "./docker.js";
import type { NodeEnrollment } from "./guest-node.js";
import { createLocalDesktopProvider, readComputerOwner } from "./provider.js";

const PROFILE = { agentId: "main" };

function enrollment(overrides: Partial<NodeEnrollment> = {}): NodeEnrollment {
  return {
    mode: "connect",
    setupCode: "synthetic-setup-code",
    setupId: "setup-1",
    openclawVersion: "2026.9.9",
    displayName: "Cloud worker computer-main",
    nodeBootstrap: {
      url: "http://172.17.0.1:18789/__openclaw__/worker-bootstrap/artifacts/abc",
      token: "synthetic-bootstrap-token",
      sha256: "a".repeat(64),
      bytes: 10,
      openclawVersion: "2026.9.9",
      enabledPluginIds: [],
    },
    waitForDeviceId: async () => "device-1",
    ...overrides,
  } as NodeEnrollment;
}

/** In-memory Docker host: containers by lease, each holding a disk. */
function fakeMachines(overrides: Partial<DesktopMachines> = {}) {
  const containers = new Map<string, { disk: string; state: MachineState }>();
  const execs: Array<{ leaseId: string; argv: string[]; env?: Record<string, string> }> = [];
  const machines: DesktopMachines = {
    start: async ({ leaseId, disk }) => {
      containers.set(leaseId, { disk, state: "running" });
    },
    exec: async (leaseId, argv, options) => {
      execs.push({ leaseId, argv, ...(options.env ? { env: options.env } : {}) });
      return argv[0] === "tail" ? "node exited: gateway refused the setup code" : "";
    },
    state: async (leaseId) => containers.get(leaseId)?.state ?? "absent",
    remove: async (leaseId) => {
      containers.delete(leaseId);
    },
    holders: async (disk) =>
      [...containers].filter(([, container]) => container.disk === disk).map(([lease]) => lease),
    bridgeAddress: async () => "172.17.0.1",
    ...overrides,
  };
  return { machines, containers, execs };
}

describe("local desktop provider", () => {
  it("opens a computer whose node and desktop come back on the lease", async () => {
    const host = fakeMachines();
    const provider = createLocalDesktopProvider(host.machines);
    const { leaseId } = await provider.resolveAllocation(PROFILE, "op-1");

    // Core's owner check compares the provisioning snapshot, so it fails once the paired node's
    // device id lands on the record.
    let enrolled = false;
    const lease = await provider.provision(PROFILE, "op-1", {
      assertCurrent: () => {
        if (enrolled) {
          throw new Error("Worker environment owner changed during teardown");
        }
      },
      beginNodeEnrollment: async () => {
        enrolled = true;
        return enrollment();
      },
    });

    expect(lease).toEqual({
      leaseId,
      node: { deviceId: "device-1" },
      desktop: {
        protocol: "rfb",
        port: 5900,
        passwordFilePath: "/tmp/openclaw-desktop/vnc-password",
      },
    });
    expect(lease.sharedHost).toBeUndefined();
    expect(host.containers.get(leaseId)?.disk).toBe("main");
    const launch = host.execs.find((exec) => exec.argv.join(" ") === "node -");
    expect(launch?.env).toMatchObject({
      LOCAL_DESKTOP_BOOTSTRAP_TOKEN: "synthetic-bootstrap-token",
      LOCAL_DESKTOP_SETUP_CODE: "synthetic-setup-code",
    });
    expect(launch?.env?.LOCAL_DESKTOP_PLAN).not.toContain("synthetic-bootstrap-token");
    await expect(provider.inspect({ leaseId, profile: PROFILE })).resolves.toEqual({
      status: "active",
      sharedHost: false,
    });
  });

  it("replays the same operation onto the same container", async () => {
    const host = fakeMachines();
    const provider = createLocalDesktopProvider(host.machines);
    const options = { beginNodeEnrollment: async () => enrollment() };

    const first = await provider.provision(PROFILE, "op-1", options);
    const second = await provider.provision(PROFILE, "op-1", options);

    expect(second.leaseId).toBe(first.leaseId);
    expect(host.containers.size).toBe(1);
  });

  it("refuses a second open of the same bot's disk without touching the first", async () => {
    const host = fakeMachines();
    const provider = createLocalDesktopProvider(host.machines);
    const first = await provider.provision(PROFILE, "op-1", {
      beginNodeEnrollment: async () => enrollment(),
    });

    const second = provider.provision(PROFILE, "op-2", {
      beginNodeEnrollment: async () => enrollment(),
    });

    await expect(second).rejects.toBeInstanceOf(WorkerProviderError);
    await expect(second).rejects.toThrow("already open in another chat");
    expect([...host.containers.keys()]).toEqual([first.leaseId]);
  });

  it("removes the container and reports the node log when enrollment never connects", async () => {
    const host = fakeMachines();
    const provider = createLocalDesktopProvider(host.machines);

    const result = provider.provision(PROFILE, "op-1", {
      beginNodeEnrollment: async () =>
        enrollment({
          waitForDeviceId: async () => {
            throw new Error("node did not connect within 10 minutes");
          },
        }),
    });

    const error = await result.catch((caught: unknown) => caught);
    expect(WorkerProviderError.isCleanupComplete(error)).toBe(true);
    expect((error as Error).message).toContain("gateway refused the setup code");
    expect(host.containers.size).toBe(0);
  });

  it("stops the node install when core closes the enrollment", async () => {
    const closed = new AbortController();
    const installing = Promise.withResolvers<void>();
    const host = fakeMachines({
      exec: async (_leaseId, _argv, options) => {
        installing.resolve();
        const stopped = Promise.withResolvers<void>();
        options.signal?.addEventListener("abort", () => stopped.resolve());
        await stopped.promise;
        throw new Error("docker exec stopped");
      },
    });
    const provider = createLocalDesktopProvider(host.machines);

    const result = provider
      .provision(PROFILE, "op-1", {
        beginNodeEnrollment: async () => enrollment({ signal: closed.signal }),
      })
      .catch((caught: unknown) => caught);
    await installing.promise;
    closed.abort(new Error("Gateway is shutting down"));

    expect(WorkerProviderError.isCleanupComplete(await result)).toBe(true);
    expect(host.containers.size).toBe(0);
  });

  it("reports indeterminate cleanup when the failed container cannot be removed", async () => {
    const host = fakeMachines({
      start: async () => {
        throw new Error("Docker could not start the computer");
      },
      remove: async () => {
        throw new Error("Docker is not running");
      },
    });
    const provider = createLocalDesktopProvider(host.machines);

    const error = await provider
      .provision(PROFILE, "op-1", { beginNodeEnrollment: async () => enrollment() })
      .catch((caught: unknown) => caught);

    expect(WorkerProviderError.isCleanupIndeterminate(error)).toBe(true);
  });

  it("rejects settings it does not own before touching Docker", async () => {
    const host = fakeMachines({
      holders: async () => {
        throw new Error("Docker must not be called");
      },
    });
    const provider = createLocalDesktopProvider(host.machines);

    for (const settings of [{}, { agentId: "" }, { agentId: "main", memory: "4g" }]) {
      await expect(
        provider.provision(settings, "op-1", { beginNodeEnrollment: async () => enrollment() }),
      ).rejects.toBeInstanceOf(WorkerProviderError);
    }
    expect(readComputerOwner({ agentId: "main" })).toBe("main");
  });

  it("reports destroyed only for a container proven gone", async () => {
    const host = fakeMachines();
    const provider = createLocalDesktopProvider(host.machines);
    host.containers.set("ldk_off", { disk: "main", state: "stopped" });

    await expect(provider.inspect({ leaseId: "ldk_off", profile: PROFILE })).resolves.toEqual({
      status: "unknown",
    });
    await provider.destroy({ leaseId: "ldk_off", profile: PROFILE });
    await expect(provider.inspect({ leaseId: "ldk_off", profile: PROFILE })).resolves.toEqual({
      status: "destroyed",
    });
  });
});
