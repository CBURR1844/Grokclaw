/* @vitest-environment jsdom */
import { expect } from "vitest";
import { clawDelegationMockInitScript } from "./control-ui-e2e-claws.ts";
import type { MockGatewayWindow } from "./control-ui-e2e-contract.ts";
import { createControlUiMockGatewayInitScript } from "./control-ui-e2e.ts";
import { mockGatewayTest as it } from "./mock-gateway-page.test-support.ts";

it("evaluates a refused request again on its key and replays only an accepted run", async ({
  gatewayPage,
}) => {
  const sessionKey = "agent:main:main";
  gatewayPage.execute(
    createControlUiMockGatewayInitScript({ sessions: [{ key: sessionKey, kind: "direct" }] }),
  );
  gatewayPage.execute(clawDelegationMockInitScript({ brief: { label: "Morning Brief" } }));
  // SAFETY: the mock Gateway init script just installed this global on the page's window.
  const gateway = (gatewayPage.window as MockGatewayWindow).openclawControlUiE2eGateway;
  const sessionId = gateway?.getSessionRow(sessionKey).sessionId;
  const socket = gatewayPage.connect();
  const delegate = async (id: string, params: Record<string, unknown>) => {
    await socket.request(id, "sessions.delegate", params);
    return socket.frames.find((frame) => frame.id === id);
  };
  const request = {
    sessionKey,
    sessionId,
    targetAgentId: "brief",
    task: "Write today's brief",
    idempotencyKey: "key-1",
  };
  const stale = {
    ok: false,
    error: { message: "This chat changed since you opened it. Reload and try again." },
  };
  const accepted = {
    ok: true,
    payload: {
      status: "accepted",
      runId: "mock-claw-run-1",
      childSessionKey: "agent:brief:subagent:mock-claw-run-1",
    },
  };

  // A refusal is not kept: the same key from the current chat starts the Claw.
  expect(await delegate("stale", { ...request, sessionId: "replaced" })).toMatchObject(stale);
  expect(await delegate("first", request)).toMatchObject(accepted);
  // An accepted run is kept: a retry joins it instead of starting another.
  expect(await delegate("retry", request)).toMatchObject(accepted);
  // The chat check comes first, as on the Gateway, even for a key that started a run.
  expect(await delegate("stale-retry", { ...request, sessionId: "replaced" })).toMatchObject(stale);
  expect(await delegate("reused", { ...request, task: "Something else" })).toMatchObject({
    ok: false,
    error: { message: "This request key was already used for a different request." },
  });
  const history = await socket.request("history", "chat.history", { sessionKey });
  expect(history.messages).toEqual([
    expect.objectContaining({
      openclawAutomation: expect.objectContaining({ runId: "mock-claw-run-1" }),
    }),
  ]);
});
