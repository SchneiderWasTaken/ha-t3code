# T3 Code

[T3 Code](https://github.com/pingdotgg/t3code) is a web UI for coding agents.
This add-on runs its server next to Home Assistant, with your configuration
folder as the default project, so you can ask Claude Code, Codex, OpenCode
or any other supported agent to work on your smart home from a browser or
the T3 Code phone apps.

T3 Code is the interface. The agents (the "harnesses") are the CLIs it
drives, and they use your own subscriptions or API keys.

## First start

1. Install and start the add-on.
2. Open the **Log** tab. Once the server is up it prints a one-time
   **pairing link**. If the address in it starts with `172.30.`, swap it for
   your Home Assistant address, keeping port `3773`.
3. Open the link in your browser. That browser is now paired; you won't need
   a link again unless you clear its storage.

Restart the add-on to get a fresh pairing link for another device, or add
devices from **Settings → Sharing & access** in T3 Code.

## Signing in to agents

Logins are stored in the add-on's persistent storage and survive restarts
and updates. Pick one approach per agent:

- **API key:** add it under **env_vars** in the add-on configuration, e.g.
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Or add it per provider in
  **Settings → Providers** in T3 Code and mark it sensitive.
- **Subscription login:** Codex can connect with ChatGPT straight from
  **Settings → Providers**. For Claude Code, open a T3 Code terminal and run
  `claude auth login`.

Claude Code, Codex and OpenCode are preinstalled. Add other agent CLIs with
**extra_npm_packages**; they're installed into persistent storage, so T3
Code's **Update now** button keeps working.

## Home Assistant access

With **homeassistant_mcp** on (the default), the add-on registers Home
Assistant's MCP server with Claude Code, Codex and OpenCode. Enable the
**Model Context Protocol Server** integration in Home Assistant first
(**Settings → Devices & services → Add integration**).

Agents also get two helper commands:

- `ha-check-config` validates your configuration.
- `ha-api <METHOD> <path> [json]` calls the Home Assistant REST API.

With **agent_context** on, every agent receives standing instructions about
this environment (where the config lives, check before reload, don't touch
`.storage`, ask before acting on locks and alarms). Add your own notes in
`agent-context.md` in this add-on's config folder
(`/addon_configs/<slug>_t3code/` from the Samba or SSH add-ons).

**Agents can edit your live configuration.** Put `/homeassistant` under git
(or take a backup) before you start.

## Security

This add-on gives AI agents a shell, write access to your configuration and
an API token that can control everything in Home Assistant. Treat access to
it like admin access to Home Assistant.

- **Who can reach it.** Port 3773 is open on your home network (and your
  tailnet, if Home Assistant runs Tailscale). Don't forward it on your
  router. A browser only gets in after pairing with a one-time link from the
  add-on log, which only Home Assistant admins can read.
- **Use an encrypted path.** The port is plain HTTP. Prefer Tailscale or an
  HTTPS reverse proxy over connecting across Wi-Fi.
- **Keep approvals on.** Entity names, device attributes and files are text
  an agent reads, and a hostile one can try to steer it ("prompt
  injection"). Leave T3 Code's permission mode on approval for commands and
  service calls; don't use full-auto modes here.
- **Review paired devices** under **Settings → Sharing & access** in T3 Code
  and remove ones you don't recognise.
- **Backups.** Agent logins and the `env_vars` option are stored in the
  add-on's data, so they're in Home Assistant backups. Keep backups
  encrypted (the default on current Home Assistant).
- **Snapshots.** Put `/homeassistant` under git or take a backup before
  letting an agent change it.

## Options

| Option | Default | |
| --- | --- | --- |
| `log_level` | `info` | Server log verbosity. |
| `telemetry` | `false` | T3 Code's anonymous product usage events. |
| `homeassistant_mcp` | `true` | Register HA's MCP server with the agents. |
| `agent_context` | `true` | Standing instructions for agents. |
| `extra_apt_packages` | `[]` | Debian packages installed on every start. |
| `extra_npm_packages` | `[]` | Global npm packages, persisted. |
| `env_vars` | `[]` | `name`/`value` pairs passed to T3 and every agent. |

## Known limitations

- **No Ingress (sidebar panel) yet.** T3 Code's web client assumes it is
  served from the root of its origin, which Ingress doesn't allow. Use the
  **Open Web UI** button or the port directly.
- **amd64 and aarch64 only.** T3 Code doesn't publish 32-bit builds.
