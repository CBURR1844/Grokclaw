---
summary: "Gives each bot its own Linux desktop in a Docker container on this machine."
read_when:
  - You are installing, configuring, or auditing the local-desktop plugin
title: "Local Desktop plugin reference"
---

<!-- Generated file. Do not edit by hand.
Run `pnpm plugins:inventory:gen` to rebuild it. Hand-written text survives only
between the openclaw-plugin-reference:manual-start and
openclaw-plugin-reference:manual-end comment markers. -->

Gives each bot its own Linux desktop in a Docker container on this machine.

## Distribution

- Package: `@openclaw/local-desktop`
- Install route: included in OpenClaw

## Surface

- Contracts: `tools`, `workerProviders`

<!-- openclaw-plugin-reference:manual-start -->

## Give an agent its computer

```bash
openclaw gateway call localDesktop.setup --params '{"agentId":"main"}'
```

The call needs `operator.admin`. It returns the profile it created, the address the computer will use to reach the Gateway, and `gatewayRestart`: `automatic` when the Gateway restarts itself to listen there, `manual` when config reload is off and you must run `openclaw gateway restart`, or `none` when no restart is needed. See [Local desktop profile](/gateway/config-cloud-workers#local-desktop-profile) for what it changes and its limits.

The agent then calls `my_computer` with `action: "open"` (add `show: true` to open the chat's Desktop panel), uses `computer` with the returned `environmentId`, and calls `my_computer` with `action: "close"` when done. With the profile setup writes, an idle computer closes after 30 minutes; its disk stays.

<!-- openclaw-plugin-reference:manual-end -->
