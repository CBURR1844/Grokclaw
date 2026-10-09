/**
 * Gateway agent-list RPC regression tests.
 */
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { listClawRequesterIds, listGatewayAgentsBasic } from "./agent-list.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("listGatewayAgentsBasic", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-agent-list-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });
  afterEach(() => vi.unstubAllEnvs());
  it("projects sole, Doctor-migrated, and ownerless fleet ownership honestly", async () => {
    expect(await listGatewayAgentsBasic({ agents: { entries: { ops: {} } } })).toMatchObject({
      defaultId: "ops",
      ownership: "sole",
      selectionRequired: false,
    });

    const { config: migrated } = createCanonicalAgentConfigFixture({
      agents: { entries: { first: {}, retired: { default: true }, research: {} } },
    });
    expect(await listGatewayAgentsBasic(migrated)).toMatchObject({
      defaultId: "retired",
      ownership: "explicit",
      selectionRequired: false,
    });

    expect(
      await listGatewayAgentsBasic({
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      }),
    ).toMatchObject({
      defaultId: "ops",
      ownership: "explicit",
      selectionRequired: true,
    });

    expect(
      await listGatewayAgentsBasic({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "research" } },
          entries: { ops: {}, research: {} },
        },
      }),
    ).toMatchObject({
      defaultId: "research",
      ownership: "explicit",
      selectionRequired: false,
    });
  });

  it("retains disk system agents without treating regular disk dirs as roster members", async () => {
    await Promise.all(
      ["openclaw", "crestodian", "research"].map((id) =>
        fs.mkdir(path.join(stateDir, "agents", id), { recursive: true }),
      ),
    );

    const syncRead = vi.spyOn(fsSync, "readdirSync").mockImplementation(() => {
      throw new Error("Roster inventory must not block the Gateway thread");
    });
    onTestFinished(() => syncRead.mockRestore());
    const cfg = { agents: { entries: { main: {} } } };
    const result = await listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([
      { id: "main", kind: "agent", name: undefined },
      { id: "crestodian", kind: "system", name: undefined },
      { id: "openclaw", kind: "system", name: undefined },
    ]);
    await fs.rmdir(path.join(stateDir, "agents", "crestodian"));
    expect((await listGatewayAgentsBasic(cfg)).agents.map(({ id }) => id)).toEqual([
      "main",
      "openclaw",
    ]);
    expect(syncRead).not.toHaveBeenCalled();
  });

  it("does not add owner entries without a roster membership source", async () => {
    expect(
      (
        await listGatewayAgentsBasic({
          agents: { entries: { main: {} } },
        })
      ).agents,
    ).toEqual([{ id: "main", kind: "agent", name: undefined }]);
  });

  it("lets configured ownership override disk system metadata", async () => {
    await fs.mkdir(path.join(stateDir, "agents", "openclaw"), { recursive: true });
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, openclaw: { name: "OpenClaw" } },
      },
    };

    expect((await listGatewayAgentsBasic(cfg)).agents).toEqual([
      { id: "main", kind: "agent", name: undefined },
      { id: "openclaw", kind: "agent", name: "OpenClaw" },
    ]);
  });

  it("falls back to identity.name when the configured agent name is missing", async () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "main" },
      agents: {
        entries: { main: { identity: { name: "小金" } } },
      },
    };

    const result = await listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([{ id: "main", kind: "agent", name: "小金" }]);
  });

  it("prefers the explicit configured name over identity.name", async () => {
    const cfg: OpenClawConfig = {
      session: { mainKey: "main" },
      agents: {
        entries: {
          main: {
            name: "Ops",
            identity: { name: "开发助手" },
          },
        },
      },
    };

    const result = await listGatewayAgentsBasic(cfg);

    expect(result.agents).toEqual([{ id: "main", kind: "agent", name: "Ops" }]);
  });
});

describe("listClawRequesterIds", () => {
  let stateDir: string;
  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-claw-requesters-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("maps each Claw to the agents whose own, wildcard, or inherited allowlist admits it", () => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { subagents: { allowAgents: ["inbox"] } },
        entries: {
          main: {},
          ops: { subagents: { allowAgents: ["*"] } },
          writer: { subagents: { allowAgents: ["report"] } },
          solo: { subagents: { allowAgents: [] } },
          inbox: { kind: "claw" },
          report: { kind: "claw" },
        },
      },
    };

    expect(listClawRequesterIds(cfg)).toEqual(
      new Map([
        ["inbox", ["main", "ops"]],
        ["report", ["ops", "writer"]],
      ]),
    );
  });

  it("never counts Claws, system agents, or the Claw itself as requesters", async () => {
    await Promise.all(
      ["openclaw", "crestodian"].map((id) =>
        fs.mkdir(path.join(stateDir, "agents", id), { recursive: true }),
      ),
    );
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { subagents: { allowAgents: ["*"] } },
        entries: {
          main: {},
          inbox: { kind: "claw" },
          report: { kind: "claw", subagents: { allowAgents: ["inbox", "report"] } },
        },
      },
    };

    const roster = await listGatewayAgentsBasic(cfg);
    expect(roster.agents.filter((agent) => agent.kind === "system").map(({ id }) => id)).toEqual([
      "crestodian",
      "openclaw",
    ]);
    expect(listClawRequesterIds(cfg)).toEqual(
      new Map([
        ["inbox", ["main"]],
        ["report", ["main"]],
      ]),
    );
  });

  it("gives a Claw that no agent admits an empty requester list", () => {
    expect(
      listClawRequesterIds({
        agents: { ownership: "explicit", entries: { main: {}, inbox: { kind: "claw" } } },
      }),
    ).toEqual(new Map([["inbox", []]]));
    expect(listClawRequesterIds({ agents: { entries: { main: {} } } })).toEqual(new Map());
  });
});
