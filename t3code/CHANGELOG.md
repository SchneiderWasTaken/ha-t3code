# Changelog

## 0.1.1

- Install pulls a prebuilt image instead of building on the device.
- The Home Assistant API token is no longer written into Claude Code or
  OpenCode config files (so it stays out of backups); agents read it from
  their environment.
- Agent CLIs pinned: Claude Code 2.1.325, Codex 0.169.0, OpenCode 1.19.5.
- Security guidance in the documentation.

## 0.1.0

- First scaffold: T3 Code 0.1.9 server, Claude Code, Codex and OpenCode
  preinstalled, `/homeassistant` as the default project, Home Assistant MCP
  wiring, agent instructions, and `ha-check-config` / `ha-api` helpers.
