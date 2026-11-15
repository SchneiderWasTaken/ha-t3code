# Architecture

## Interface, not harness

This project doesn't build an agent loop. It packages an **interface**
(T3 Code) and gives it a Home Assistant-shaped workspace. The **harnesses**
are the agent CLIs T3 Code already drives (Claude Code, Codex, OpenCode, any
ACP agent). Multiple inference providers come from T3 itself: each harness
brings its own model access, and T3 can hold several instances of a provider
with different keys or base URLs.

```
 HA sidebar (any HA user)
      │  HA login, then Supervisor Ingress: /api/hassio_ingress/<token>/…
      ▼        + X-Remote-User-Id / -Name / -Display-Name
┌──────────────────────── add-on container ─────────────────────────┐
│ gateway :8099 (t3code/gateway/server.mjs)                         │
│   • trusts only the Supervisor; refuses requests without an HA user│
│   • serves T3's web app, built with our patches + ingress shim     │
│   • one `t3 serve` per HA user, started on demand                  │
│   • signs in for the user; T3 session cookie never leaves gateway  │
│        │                       │                                  │
│        ▼                       ▼                                  │
│  t3 serve (user A) :3801   t3 serve (user B) :3802   …            │
│        │ spawns claude / codex / opencode …                       │
│        ▼                                                          │
│  /homeassistant (admins)        http://supervisor/core/api (MCP)  │
└───────────────────────────────────────────────────────────────────┘
 optional: direct port 3773 ─▶ one chosen user's t3 serve (T3 pairing)
```

## Carrying patches on T3 Code

We pin a T3 Code release (`T3CODE_VERSION` in `t3code/build.yaml`) and use:

- the **official release binary** for the server, and
- T3's **web app built from source at the same tag**, with
  `t3code/patches/*.patch` applied and Vite's `--base ./`.

Ingress needs the app to work under a sub-path. Most of that is solved
without touching T3's source: the gateway injects `ingress-shim.js`, which
rewrites T3's own same-origin URLs into the Ingress path at the browser
APIs. The only source patch keeps routes in the URL hash (as T3's Electron
build already does). Auth needs no patch: T3's browser login is an HttpOnly
cookie, so the gateway holds it and attaches it while proxying.

### Keeping up with upstream

`.github/workflows/upstream.yaml` runs daily:

1. New T3 Code release? Create `upstream/t3code-v<version>`, bump
   `T3CODE_VERSION`, `NODE_BUILD_VERSION` (from upstream's `engines.node`)
   and the add-on version.
2. Run `scripts/verify-upstream.sh`: apply patches, build the web app, run
   the end-to-end browser test (`tests/e2e/run.mjs`) against T3 from source
   behind the gateway and a fake Ingress.
3. If that fails, run Claude (`anthropics/claude-code-action`) with the
   failure log and `CLAUDE.md`, asking it to regenerate patches or adapt the
   gateway, without weakening the test. Then verify again.
4. Push the branch, open a PR stating whether it passed first time, passed
   after Claude's repair, or still needs a human, and start CI (lint, e2e,
   image builds) on it. The job fails visibly if it's still broken.

Nothing merges automatically; a person reviews the PR. Claude needs a
`CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`
repository secret.

## Multi-user roadmap

Decisions so far: agent logins are shared (household subscriptions), with an
option for a user to bring their own; and each person may change exactly
what their Home Assistant account is allowed to change, with no extra
approval step.

### Done (0.2.0)

- Sidebar via Ingress, no pairing, per-user T3 servers keyed on the HA user
  id. Admin-only (`panel_admin: true` and checked again in the gateway).

### Phase 2: non-admin users get their own space

Home Assistant's permission model is effectively admin vs non-admin. For
files, that means non-admins can't touch the config directory at all, so:

- **Admins** keep today's setup: `/homeassistant` as the workspace, the
  add-on's API access.
- **Non-admins** get a private workspace (`/data/users/<id>/workspace`, a git
  repo), no access to `/homeassistant` (which also holds `secrets.yaml`),
  and agents acting **as them** in Home Assistant: their T3 server and
  agents get *their* access token instead of `SUPERVISOR_TOKEN`, so Home
  Assistant enforces their permissions on every call. The token comes from
  a one-time Home Assistant sign-in (OAuth) the gateway runs for them, kept
  as a refresh token.
- **Isolation:** each user's T3 server and agents run as their own Linux
  user, so one user's agents can't read another's workspace or threads.
- **Shared logins:** agent credentials are provided to every user's
  agents (e.g. `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, API keys
  via env), with a per-user override.
- `panel_admin: false` once this ships, so the panel shows for everyone.

### Phase 3: getting work into Home Assistant

What a non-admin builds lands through what Home Assistant lets *them* do
via the API (entity control, and whatever else their account permits).
Things HA only lets admins do (YAML packages, custom cards in `www/`,
dashboards, custom integrations) stay admin actions; a non-admin can hand an
admin a ready-made change from their workspace.

## Other ideas

- Ask upstream for sub-path support (would let us drop the patch).
- Verify the Supervisor proxy streams MCP responses (Streamable HTTP/SSE)
  well enough for the Home Assistant MCP server.
- Snapshot `/homeassistant` (git or HA backup) before an agent session.
- A config-check hook that harnesses run after edits.
