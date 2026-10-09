// Load the shared migration mocks before their production consumers.
// oxfmt-ignore
import { useDoctorLegacyConfigFixture } from "./doctor/shared/legacy-config-fixture.test-support.js";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../config/plugin-auto-enable.test-helpers.js";
import { repairStaleAgentModelRefs } from "./doctor/shared/stale-agent-model-ref-repair.js";

const DEFAULT_REF = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;

describe("repairStaleAgentModelRefs", () => {
  useDoctorLegacyConfigFixture();

  it("repairs agent model refs whose configured provider was deleted", () => {
    const result = repairStaleAgentModelRefs(
      {
        models: {
          providers: {
            custom: { baseUrl: "http://localhost:1234", models: [] },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "deleted/default-primary",
              fallbacks: ["custom/kept", DEFAULT_REF, "deleted/default-fallback"],
            },
            models: {
              "custom/kept": { alias: "kept" },
              "deleted/models-add-row": { alias: "stale" },
            },
          },
          entries: {
            main: {
              model: "deleted/agent-primary",
              models: {
                "plugin-provider/kept": {},
                "deleted/agent-models-add-row": {},
              },
            },
          },
        },
      },
      {
        pluginProviderIds: new Set(["plugin-provider"]),
        persistedProviderIdsByAgentId: new Map(),
      },
    );

    expect(result.config.agents?.defaults?.model).toEqual({
      primary: DEFAULT_REF,
      fallbacks: ["custom/kept"],
    });
    expect(result.config.agents?.defaults?.models).toEqual({
      "custom/kept": { alias: "kept" },
      [DEFAULT_REF]: {},
    });
    expect(result.config.agents?.entries?.main).toMatchObject({
      models: { "plugin-provider/kept": {}, [DEFAULT_REF]: {} },
    });
    expect(result.config.agents?.entries?.main?.model).toBeUndefined();
    expect(result.changes).toEqual([
      `Replaced stale agents.defaults.model primary "deleted/default-primary" with default "${DEFAULT_REF}" (provider "deleted" is unavailable).`,
      'Removed stale agents.defaults.model fallback "deleted/default-fallback" (provider "deleted" is unavailable).',
      `Removed duplicate agents.defaults.model fallback "${DEFAULT_REF}" after selecting it as the default primary.`,
      'Removed stale agents.defaults.models entry "deleted/models-add-row" (provider "deleted" is unavailable).',
      `Added agents.defaults.models entry "${DEFAULT_REF}" to keep the repaired allowlist restrictive.`,
      'Removed stale agents.entries.main.model "deleted/agent-primary" so agent "main" inherits the default model (provider "deleted" is unavailable).',
      'Removed stale agents.entries.main.models entry "deleted/agent-models-add-row" (provider "deleted" is unavailable).',
      `Added agents.entries.main.models entry "${DEFAULT_REF}" to keep the repaired allowlist restrictive.`,
    ]);
  });

  it("preserves plugin-owned CLI providers and agent-local models.json providers", () => {
    const result = repairStaleAgentModelRefs(
      {
        agents: {
          defaults: {
            model: "my-cli/model",
          },
          entries: {
            worker: { model: "agent-local/model" },
            core: { model: "anthropic/claude-sonnet-4-6" },
          },
        },
      },
      {
        pluginProviderIds: new Set(["anthropic", "my-cli"]),
        persistedProviderIdsByAgentId: new Map([["worker", new Set(["agent-local"])]]),
      },
    );

    expect(result.changes).toEqual([]);
    expect(result.config.agents?.defaults?.model).toBe("my-cli/model");
    expect(result.config.agents?.entries?.worker?.model).toBe("agent-local/model");
    expect(result.config.agents?.entries?.core?.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("uses a retained metadata snapshot for plugin-owned providers", () => {
    const config = {
      agents: {
        defaults: {
          model: "my-cli/model",
        },
      },
    };
    const baseSnapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([
        {
          id: "my-cli-plugin",
          channels: [],
          providers: ["my-cli"],
        },
      ]),
    });
    const pluginMetadataSnapshot = {
      ...baseSnapshot,
      owners: {
        ...baseSnapshot.owners,
        providers: new Map([["my-cli", ["my-cli-plugin"]]]),
      },
    };

    const result = repairStaleAgentModelRefs(config, {
      pluginMetadataSnapshot,
      persistedProviderIdsByAgentId: new Map(),
    });

    expect(result.changes).toEqual([]);
    expect(result.config.agents?.defaults?.model).toBe("my-cli/model");
  });

  it("preserves model refs backed by a configured installable provider", () => {
    const result = repairStaleAgentModelRefs(
      {
        plugins: {
          allow: ["mistral"],
          entries: { mistral: { enabled: true } },
        },
        agents: {
          defaults: {
            model: { primary: "mistral/mistral-large-latest" },
          },
        },
      },
      {
        pluginProviderIds: new Set(),
        persistedProviderIdsByAgentId: new Map(),
      },
    );

    expect(result.changes).toEqual([]);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "mistral/mistral-large-latest",
    });
  });

  it("does not treat one agent-local provider as globally available", () => {
    const result = repairStaleAgentModelRefs(
      {
        agents: {
          defaults: { model: "agent-local/model" },
          entries: { main: {}, worker: {} },
        },
      },
      {
        pluginProviderIds: new Set(),
        persistedProviderIdsByAgentId: new Map([
          ["main", new Set(["agent-local"])],
          ["worker", new Set()],
        ]),
      },
    );

    expect(result.config.agents?.defaults?.model).toBe(DEFAULT_REF);
    expect(result.changes).toEqual([
      `Replaced stale agents.defaults.model "agent-local/model" with default "${DEFAULT_REF}" (provider "agent-local" is unavailable).`,
    ]);
  });

  it("evaluates and repairs every canonical keyed agent", () => {
    const result = repairStaleAgentModelRefs(
      {
        agents: {
          defaults: { model: "agent-local/model" },
          entries: {
            main: {},
            worker: { model: "deleted/worker" },
          },
        },
      },
      {
        pluginProviderIds: new Set(),
        persistedProviderIdsByAgentId: new Map([
          ["main", new Set(["agent-local"])],
          ["worker", new Set()],
        ]),
      },
    );

    expect(result.config.agents?.defaults?.model).toBe(DEFAULT_REF);
    expect(result.config.agents?.entries?.worker?.model).toBeUndefined();
    expect(result.changes).toContain(
      'Removed stale agents.entries.worker.model "deleted/worker" so agent "worker" inherits the default model (provider "deleted" is unavailable).',
    );
  });

  it("keeps a repaired model allowlist restrictive", () => {
    const result = repairStaleAgentModelRefs(
      {
        agents: {
          defaults: {
            model: "deleted/main",
            models: { "deleted/main": {} },
          },
        },
      },
      { pluginProviderIds: new Set(), persistedProviderIdsByAgentId: new Map() },
    );

    expect(result.config.agents?.defaults?.models).toEqual({ [DEFAULT_REF]: {} });
    expect(result.changes).toContain(
      `Added agents.defaults.models entry "${DEFAULT_REF}" to keep the repaired allowlist restrictive.`,
    );
  });

  it("does not throw on malformed best-effort model config", () => {
    expect(() =>
      repairStaleAgentModelRefs(
        {
          agents: {
            defaults: {
              model: { primary: "deleted/main", fallbacks: 42 },
            },
          },
        },
        { pluginProviderIds: new Set(), persistedProviderIdsByAgentId: new Map() },
      ),
    ).not.toThrow();
  });

  it("uses only explicit providers when models.mode is replace", () => {
    const result = repairStaleAgentModelRefs(
      {
        models: {
          mode: "replace",
          providers: {
            custom: {
              baseUrl: "http://localhost:1234",
              models: [{ id: "kept", name: "Kept" }],
            },
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "deleted/main",
              fallbacks: ["plugin-provider/model", "custom/kept"],
            },
          },
        },
      },
      {
        pluginProviderIds: new Set(["plugin-provider"]),
        persistedProviderIdsByAgentId: new Map(),
      },
    );

    expect(result.config.agents?.defaults?.model).toEqual({ primary: "custom/kept" });
    expect(result.changes).toEqual([
      'Replaced stale agents.defaults.model primary "deleted/main" with default "custom/kept" (provider "deleted" is unavailable).',
      'Removed stale agents.defaults.model fallback "plugin-provider/model" (provider "plugin-provider" is unavailable).',
      'Removed duplicate agents.defaults.model fallback "custom/kept" after selecting it as the default primary.',
    ]);
  });
});
