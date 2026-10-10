import { createHash } from "node:crypto";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import { IMAGE_BUILD_TIMEOUT_MS, type DesktopMachines } from "./docker.js";
import { launchGuestNode, readGuestNodeLog, type GuestExec } from "./guest-node.js";

export const LOCAL_DESKTOP_PROVIDER_ID = "local-desktop";

// Facts the image's start script guarantees; the guest node reads them inside the computer.
const DESKTOP = {
  protocol: "rfb",
  port: 5900,
  passwordFilePath: "/tmp/openclaw-desktop/vnc-password",
} as const;
// Core's default node phase window, used when it supplies none.
const NODE_PHASE_MS = 20 * 60_000;

/** The agent whose disk a profile's computer uses, or undefined when settings are not ours. */
export function readComputerOwner(
  settings: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const keys = Object.keys(settings ?? {});
  const agentId = settings?.agentId;
  return keys.length === 1 && typeof agentId === "string" && agentId.trim() === agentId && agentId
    ? agentId
    : undefined;
}

function leaseIdFor(operationId: string): string {
  return `ldk_${createHash("sha256").update(`local-desktop\0${operationId}`).digest("hex").slice(0, 16)}`;
}

/**
 * Each lease is one container running a private desktop and an ephemeral OpenClaw node; the
 * bot's home directory is a disk that outlives leases. One open lease per disk keeps two
 * chats from writing the same home at once.
 */
export function createLocalDesktopProvider(machines: DesktopMachines): WorkerProvider {
  const perDisk = new KeyedAsyncQueue();

  // After allocation every failure removes the container before core sees it.
  const releaseOnFailure = async <T>(leaseId: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      try {
        await machines.remove(leaseId);
      } catch (cleanupError) {
        throw WorkerProviderError.cleanupIndeterminate(leaseId, error, cleanupError);
      }
      throw WorkerProviderError.cleanupComplete(leaseId, error);
    }
  };

  return {
    id: LOCAL_DESKTOP_PROVIDER_ID,
    requiresNodeEnrollment: true,
    provisionBeforeInstallation: true,
    allowsDesktopResize: true,
    async resolveAllocation(_profile, operationId) {
      return { leaseId: leaseIdFor(operationId), sharedHost: false };
    },
    resolveProvisionTimeoutMs: (_profile, options) =>
      IMAGE_BUILD_TIMEOUT_MS + 2 * (options?.nodeBootstrapTimeoutMs ?? NODE_PHASE_MS) + 5 * 60_000,
    resolveDestroyTimeoutMs: () => 2 * 60_000,

    async provision(profile, operationId, options = {}) {
      const agentId = readComputerOwner(profile);
      if (!agentId) {
        throw new WorkerProviderError(
          'local-desktop profiles take exactly one setting: { "agentId": "<bot id>" }.',
        );
      }
      const { signal, beginNodeEnrollment } = options;
      if (!beginNodeEnrollment) {
        throw new WorkerProviderError("This Gateway cannot enroll a node on a local computer.");
      }
      const current = () => {
        signal?.throwIfAborted();
        options.assertCurrent?.();
      };
      const leaseId = leaseIdFor(operationId);
      current();
      await perDisk.enqueue(agentId, async () => {
        const others = (await machines.holders(agentId)).filter((holder) => holder !== leaseId);
        if (others.length > 0) {
          throw new WorkerProviderError(
            "This bot's computer is already open in another chat. Close it there, then try again.",
          );
        }
        current();
        await releaseOnFailure(leaseId, () => machines.start({ leaseId, disk: agentId }, signal));
      });
      return await releaseOnFailure(leaseId, async (): Promise<WorkerLease> => {
        current();
        // Enrollment checks its own owner. After it begins, the node's pairing writes its device
        // id onto the record, so core's owner check would refuse the lease it is waiting for.
        const enrollment = await beginNodeEnrollment();
        // Stop ends the open; so does core closing the enrollment (shutdown or a newer open).
        const live =
          signal && enrollment.signal
            ? AbortSignal.any([signal, enrollment.signal])
            : (signal ?? enrollment.signal);
        live?.throwIfAborted();
        const exec: GuestExec = (argv, execOptions) => machines.exec(leaseId, argv, execOptions);
        await launchGuestNode(exec, enrollment, live);
        let deviceId: string;
        try {
          deviceId = await enrollment.waitForDeviceId();
        } catch (error) {
          const log = await readGuestNodeLog(exec);
          throw new Error(
            `The computer's OpenClaw node did not connect to the Gateway${log ? `. Node log:\n${log}` : "."}`,
            { cause: error },
          );
        }
        live?.throwIfAborted();
        return { leaseId, node: { deviceId }, desktop: { ...DESKTOP } };
      });
    },

    // `destroyed` lets core skip teardown, so it is reported only for a proven-absent container;
    // engine failures throw and stay transient.
    async inspect({ leaseId }) {
      const state = await machines.state(leaseId);
      return state === "running"
        ? { status: "active", sharedHost: false }
        : state === "absent"
          ? { status: "destroyed" }
          : { status: "unknown" };
    },

    async destroy({ leaseId }) {
      await machines.remove(leaseId);
    },
  };
}
