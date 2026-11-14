# Architecture

## Interface, not harness

This project doesn't build an agent loop. It packages an **interface**
(T3 Code) and gives it a Home Assistant-shaped workspace. The **harnesses**
are the agent CLIs T3 Code already knows how to drive:

```
 Browser / T3 phone app
          │  HTTP + WebSocket (paired device auth)
          ▼
┌──────────────── add-on container ─────────────────┐
│  t3 serve  (T3 Code server + bundled web UI)       │
│     │ spawns / talks to                            │
│     ├── claude   (Claude Code)  ┐                  │
│     ├── codex    (Codex CLI)    ├─ harnesses       │
│     ├── opencode (OpenCode)     │  = "providers"   │
│     └── …any ACP agent          ┘                  │
│            │ files            │ MCP / REST         │
│            ▼                  ▼                    │
│     /homeassistant      http://supervisor/core/api │
└────────────────────────────────────────────────────┘
```

Multiple inference providers come from T3 Code itself: each harness brings
its own model access (subscription login or API key), and T3 lets you add
several instances of a provider with different keys or base URLs, e.g.
Claude Code against OpenRouter, a local model through OpenCode, and so on.

What this repo owns is the glue:

| Piece | Where |
| --- | --- |
| Packaging T3 + harnesses for HA (glibc base, arch mapping, checksum) | `t3code/Dockerfile`, `t3code/build.yaml` |
| Persistent state (`HOME`, `T3CODE_HOME`, npm prefix under `/data`) | `rootfs/.../t3code/run` |
| HA workspace (`/homeassistant` as the default project) | `config.yaml` `map`, `run` |
| HA tools for agents (MCP wiring, `ha-api`, `ha-check-config`) | `run`, `rootfs/usr/local/bin` |
| HA-specific agent instructions | `rootfs/usr/share/t3code-ha/AGENTS.md` |

## Upstream tracking

T3 Code is consumed as its published release binary, pinned by
`T3CODE_VERSION` in `build.yaml` and verified against the release's
`SHA256SUMS`. Bumping T3 is a one-line change plus a changelog entry.
We don't fork until something below needs it.

## Open questions / roadmap

### Ingress (sidebar panel)

The thing that would make this feel native. Ingress serves the add-on at
`/api/hassio_ingress/<token>/` and authenticates the HA user. Today it
doesn't work because:

1. The web client derives API/WebSocket URLs from `window.location.origin`
   (`apps/web/src/environments/primary/target.ts`, `httpLayer.ts`) and loads
   assets from `/`, so everything misses the sub-path.
2. T3 has its own pairing auth; behind Ingress we'd want to trust HA's
   session instead.

Options, cheapest first:

- **Upstream a base-path setting** (`T3CODE_BASE_PATH` / `X-Ingress-Path`
  aware). Best outcome; worth an issue on pingdotgg/t3code.
- **Patch at build time** (build web from source with Vite `base` and a
  patched origin helper). Means building the monorepo in CI.
- **Rewrite proxy** (nginx `sub_filter`) in front of T3. Fragile with a
  modern SPA plus WebSockets; last resort.

For auth behind Ingress, the add-on could mint a pairing token on the
first Ingress request (Ingress traffic only comes from `172.30.32.2`) so the
HA user is paired transparently.

### Other items

- Prebuilt multi-arch images on GHCR (`image:` in `config.yaml`) so users
  don't build locally; installs are slow on a Pi otherwise.
- Verify the Supervisor proxy streams MCP responses correctly (Streamable
  HTTP / SSE); fall back to a direct `homeassistant:8123` URL with a
  long-lived token option if not.
- Optional git auto-init and pre-change snapshot for `/homeassistant`.
- Optional HA config-check hook that harnesses run after edits (Claude Code
  hooks, Codex notify).
- `hassio_api` + backup integration: snapshot before a session that edits
  config.
- Expose T3 Connect / Tailscale options for remote access.
