# T3 Code for Home Assistant

A Home Assistant add-on repository that runs
[T3 Code](https://github.com/pingdotgg/t3code) as a web UI for coding agents,
with your Home Assistant configuration as the workspace.

- **Many agents, one UI.** Claude Code, Codex and OpenCode are preinstalled;
  any other agent T3 Code supports can be added. Each uses your own
  subscription or API key.
- **Knows it's in Home Assistant.** Your config folder is the default
  project, agents get Home Assistant's MCP server and helper commands, and
  standing instructions on how to change a live house safely.
- **Persistent.** Agent logins, threads and extra tools survive restarts.

> Not affiliated with T3 Tools Inc. T3 Code is MIT licensed; this add-on
> downloads its official release at build time.

## Install

[![Add repository to Home Assistant][repo-badge]][repo-link]

Or in Home Assistant: **Settings → Add-ons → Add-on store → ⋮ →
Repositories**, add `https://github.com/SchneiderWasTaken/ha-t3code`, then
install **T3 Code**. See the add-on's [documentation](t3code/DOCS.md).

## Add-ons

| Add-on | |
| --- | --- |
| [T3 Code](t3code/) | Web UI for coding agents working on your HA config. |

## Development

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together
and what's next. To try a change, copy this repository into `/addons` on a
Home Assistant install (Samba or SSH add-on) and install it from **Local
add-ons**, or use the
[add-on devcontainer](https://developers.home-assistant.io/docs/add-ons/testing).

[repo-badge]: https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg
[repo-link]: https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FSchneiderWasTaken%2Fha-t3code
