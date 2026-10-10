import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createMyComputerTool, MY_COMPUTER_TOOL, setUpBotComputer } from "./src/bot-computer.js";
import { createDesktopMachines } from "./src/docker.js";
import { createLocalDesktopProvider } from "./src/provider.js";

const assetsDir = fileURLToPath(new URL("./assets/", import.meta.url));

export default definePluginEntry({
  id: "local-desktop",
  name: "Local Desktop",
  description: "Gives each bot its own Linux desktop in a Docker container on this machine",
  register(api) {
    const machines = createDesktopMachines({
      assetsDir,
      instance: api.runtime.state.resolveStateDir(),
    });
    api.registerWorkerProvider(createLocalDesktopProvider(machines));
    api.registerTool((context) => createMyComputerTool({ context, gateway: api.runtime.gateway }), {
      name: MY_COMPUTER_TOOL,
    });
    api.registerToolMetadata({
      toolName: MY_COMPUTER_TOOL,
      displayName: "My computer",
      description: "Open the bot's own desktop on this machine.",
      risk: "high",
      tags: ["desktop"],
    });
    api.registerGatewayMethod(
      "localDesktop.setup",
      async ({ params, respond }) => {
        const agentId =
          params && typeof params === "object" && !Array.isArray(params)
            ? (params as Record<string, unknown>).agentId
            : undefined;
        if (typeof agentId !== "string" || !agentId || Object.keys(params ?? {}).length !== 1) {
          const message = "localDesktop.setup takes { agentId }.";
          respond(false, { error: message }, errorShape(ErrorCodes.INVALID_REQUEST, message));
          return;
        }
        try {
          respond(true, await setUpBotComputer({ agentId, machines, config: api.runtime.config }));
        } catch (error) {
          const message = formatErrorMessage(error);
          respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
        }
      },
      { scope: "operator.admin" },
    );
  },
});
