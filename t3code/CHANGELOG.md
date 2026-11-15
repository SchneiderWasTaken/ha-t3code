# Changelog

## 0.2.0

- **Opens in the Home Assistant sidebar.** No port, no pairing: Home
  Assistant signs you in and the add-on signs you in to T3 Code.
- Each Home Assistant user gets their own T3 Code (threads, settings,
  history); agent logins are shared. Administrators only for now.
- The Home Assistant config folder is added as a project automatically.
- The direct port is now optional and closed by default; set
  `direct_access_user` to use it with the T3 phone apps or Tailscale.
- Pairing tokens no longer appear in the add-on log.

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
