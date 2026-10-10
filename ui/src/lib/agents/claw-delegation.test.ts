import { describe, expect, it } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { chatOffersClaws, delegateToClaw, readClawDelegationAccess } from "./claw-delegation.ts";

const request = {
  sessionKey: "agent:forge:main",
  sessionId: "session-1",
  targetAgentId: "sorter",
  task: "Sort my inbox",
  idempotencyKey: "key-1",
};

function snapshot(
  scopes: string[],
  options: { methods?: string[]; connected?: boolean } = {},
): Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> {
  return {
    client: createTestGatewayClient(createGatewayRequestMock()),
    hello: gatewayHelloForMethods(options.methods ?? ["sessions.delegate"], scopes),
    phase: options.connected === false ? "offline" : "connected",
  };
}

describe("Claw delegation access", () => {
  it.each([
    ["a writer", snapshot(["operator.write"]), { allowed: true }],
    ["an admin", snapshot(["operator.admin"]), { allowed: true }],
    // The method is not an own-session write, so the narrow session scope is not enough.
    [
      "a caller with only own-session writes",
      snapshot(["operator.read", "operator.sessions.write"]),
      { allowed: false, cause: "missing-scope" },
    ],
    [
      "a Gateway without the method",
      snapshot(["operator.write"], { methods: ["chat.send"] }),
      { allowed: false, cause: "method-unavailable" },
    ],
    [
      "a lost connection",
      snapshot(["operator.write"], { connected: false }),
      { allowed: false, cause: "disconnected" },
    ],
  ])("decides for %s", (_name, gateway, expected) => {
    expect(readClawDelegationAccess(gateway)).toMatchObject({
      ...expected,
      requiredScope: "operator.write",
    });
  });
});

describe("delegateToClaw", () => {
  it("sends the request unchanged and reports nothing once the Claw started", async () => {
    const rpc = createGatewayRequestMock(async () => ({
      status: "accepted",
      runId: "run-1",
      childSessionKey: "agent:sorter:subagent:1",
    }));

    await expect(
      delegateToClaw(createTestGatewayClient(rpc), request, "Inbox Sorter"),
    ).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("sessions.delegate", request);
  });

  it("explains a Gateway refusal with its own text", async () => {
    const rpc = createGatewayRequestMock(async () => {
      throw new GatewayRequestError({
        code: "FORBIDDEN",
        message: "This bot's tool settings don't let it start helpers.",
      });
    });

    await expect(
      delegateToClaw(createTestGatewayClient(rpc), request, "Inbox Sorter"),
    ).resolves.toBe("Couldn't do that: This bot's tool settings don't let it start helpers.");
  });

  it("asks the user to check the chat after a lost answer, without retrying", async () => {
    const rpc = createGatewayRequestMock(async () => {
      throw new Error("gateway closed (1006)");
    });

    await expect(
      delegateToClaw(createTestGatewayClient(rpc), request, "Inbox Sorter"),
    ).resolves.toBe("Couldn't confirm Inbox Sorter started. Check this chat before sending again.");
    expect(rpc).toHaveBeenCalledOnce();
  });
});

describe("chatOffersClaws", () => {
  it.each([
    ["a bot's chat", "agent:forge:main", false, true],
    ["an incognito chat", "agent:forge:main", true, false],
    ["a helper's chat", "agent:forge:subagent:abc", false, false],
    ["a routine's chat", "agent:forge:cron:job-1", false, false],
  ])("decides for %s", (_name, sessionKey, incognito, expected) => {
    expect(chatOffersClaws({ sessionKey, incognito })).toBe(expected);
  });
});
