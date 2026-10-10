// Control UI test helper builds session paths and URLs for e2e navigation.
import { buildControlUiSessionPath } from "@openclaw/session-url-contract";

export function controlUiSessionPath(
  sessionKey: string,
  basePath = "",
  namespace: "chat" | "dashboard" = "chat",
): string {
  const pathname = buildControlUiSessionPath({
    namespace,
    sessionKey,
    fallbackAgentId: sessionKey.split(":")[1] || "main",
    basePath,
    shortIdLength: 32,
  });
  return pathname ?? `${basePath}/chat`;
}

export function controlUiSessionUrl(
  baseUrl: string,
  sessionKey: string,
  namespace: "chat" | "dashboard" = "chat",
): string {
  const url = new URL(baseUrl);
  // Cold fixture navigation knows the exact key; it must not depend on a warm
  // short-reference cache or a separately mocked sessions.resolve response.
  url.pathname =
    buildControlUiSessionPath({
      namespace,
      sessionKey,
      basePath: url.pathname,
      fallbackAgentId: sessionKey.split(":")[1] || "main",
      exactKey: true,
    }) ?? controlUiSessionPath(sessionKey, url.pathname, namespace);
  url.search = "";
  url.hash = "";
  return url.toString();
}
