// Subagent target policy tests cover requester defaults, explicit allowlists,
// wildcard target sets, and stale configured-agent filtering.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  resolveRequesterAllowAgents,
  resolveSubagentAllowedTargetIds,
  resolveSubagentTargetPolicy,
} from "./subagent-target-policy.js";

describe("subagent target policy", () => {
  it("defaults to requester-only when no allowlist is configured", () => {
    expect(
      resolveSubagentTargetPolicy({
        requesterAgentId: "main",
        targetAgentId: "main",
        requestedAgentId: "main",
      }),
    ).toEqual({ ok: true });
    const result = resolveSubagentTargetPolicy({
      requesterAgentId: "main",
      targetAgentId: "other",
      requestedAgentId: "other",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected target policy to reject other agent");
    }
    expect(result.allowedText).toBe("main");
  });

  it("filters explicit allowlists to configured target ids", () => {
    expect(
      resolveSubagentAllowedTargetIds({
        requesterAgentId: "main",
        allowAgents: ["planner", "stale"],
        configuredAgentIds: ["main", "planner"],
      }),
    ).toEqual({
      allowAny: false,
      allowedIds: ["planner"],
    });

    const result = resolveSubagentTargetPolicy({
      requesterAgentId: "main",
      targetAgentId: "stale",
      requestedAgentId: "stale",
      allowAgents: ["planner", "stale"],
      configuredAgentIds: ["main", "planner"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected target policy to reject stale explicit target");
    }
    expect(result.allowedText).toBe("planner");
    expect(result.error).toBe(
      'agentId "stale" is not in the configured agent registry (allowed: planner)',
    );
  });

  it("limits wildcard allowlists to configured agents plus the requester", () => {
    expect(
      resolveSubagentAllowedTargetIds({
        requesterAgentId: "main",
        allowAgents: ["*"],
        configuredAgentIds: ["planner", "checker"],
      }),
    ).toEqual({
      allowAny: true,
      allowedIds: ["checker", "main", "planner"],
    });
  });

  it("filters explicit targets when wildcard allowlists are mixed", () => {
    expect(
      resolveSubagentAllowedTargetIds({
        requesterAgentId: "main",
        allowAgents: ["*", "beta"],
        configuredAgentIds: ["main", "planner"],
      }),
    ).toEqual({
      allowAny: true,
      allowedIds: ["main", "planner"],
    });

    const result = resolveSubagentTargetPolicy({
      requesterAgentId: "main",
      targetAgentId: "beta",
      requestedAgentId: "beta",
      allowAgents: ["*", "beta"],
      configuredAgentIds: ["main", "planner"],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected target policy to reject stale mixed explicit target");
    }
    expect(result.error).toBe(
      'agentId "beta" is not in the configured agent registry (allowed: main, planner)',
    );
  });

  it("reads a requester's own allowlist before the defaults' allowlist", () => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { subagents: { allowAgents: ["*"] } },
        entries: {
          main: { subagents: { allowAgents: ["planner"] } },
          locked: { subagents: { allowAgents: [] } },
          planner: {},
        },
      },
    };

    expect(resolveRequesterAllowAgents(cfg, "main")).toEqual(["planner"]);
    expect(resolveRequesterAllowAgents(cfg, "locked")).toEqual([]);
    expect(resolveRequesterAllowAgents(cfg, "planner")).toEqual(["*"]);
    expect(resolveRequesterAllowAgents({ agents: { entries: { main: {} } } }, "main")).toBe(
      undefined,
    );
  });
});
