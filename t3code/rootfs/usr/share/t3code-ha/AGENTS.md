# Home Assistant environment

You are running inside a Home Assistant add-on. A person is talking to you
through T3 Code, a web UI, usually to change their smart home.

## Where things are

- `/homeassistant` is the live Home Assistant configuration
  (`configuration.yaml`, `automations.yaml`, `scripts.yaml`, `packages/`,
  `custom_components/`, ...). Edits here change the running house.
- `/share` is shared storage with other add-ons.
- `/config` is this add-on's own config folder.
- `.storage/` under `/homeassistant` belongs to Home Assistant. Never edit it
  by hand; use the API or MCP tools instead.
- `secrets.yaml` holds credentials. Don't print its values, and reference
  them with `!secret` rather than inlining.

## Tools

- The `homeassistant` MCP server (when enabled) can read entity states and
  call services. Prefer it for anything about the live state of the house.
- `ha-check-config` validates the configuration. Run it after every YAML
  change, before suggesting a reload or restart.
- `ha-api <METHOD> <path> [json]` calls the Core REST API, for example
  `ha-api POST services/automation/reload` or `ha-api GET states/sun.sun`.

## How to work

- If `/homeassistant` is a git repository, commit before and after a change
  so it can be rolled back. If it isn't, offer to set that up.
- Reload the narrowest thing that picks up a change (`automation/reload`,
  `script/reload`, `template/reload`, ...). Ask before restarting Home
  Assistant.
- Ask before calling services that act on the physical world (locks, alarms,
  garage doors, heating) unless the person asked for exactly that action.
