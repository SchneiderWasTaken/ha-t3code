# ha-t3code

A Home Assistant add-on that runs [T3 Code](https://github.com/pingdotgg/t3code)
in the Home Assistant sidebar. T3 Code is the interface; the agent CLIs it
drives (Claude Code, Codex, OpenCode) are the harnesses. We don't fork T3
Code: we pin a release and carry the smallest possible patch set on its web
app.

## How it fits together

```
HA sidebar ─▶ Supervisor Ingress ─▶ gateway (:8099) ─▶ t3 serve per HA user (127.0.0.1:38xx)
              /api/hassio_ingress/<token>/  │
                                            └─ serves our patched T3 web build + ingress shim
```

- `t3code/gateway/server.mjs` (Node ≥ 22, no deps). Trusts only the
  Supervisor (172.30.32.2), reads `X-Remote-User-*`, starts one `t3 serve`
  per Home Assistant user, signs in for them (`t3 pair` → POST
  `/api/auth/browser-session` → keeps the `t3_session_*` cookie server-side)
  and proxies HTTP + WebSocket with that cookie. The browser never sees T3
  credentials or a pairing screen.
- `t3code/gateway/ingress-shim.js` is injected into `index.html`. It
  rewrites T3's same-origin URLs (`/api`, `/ws`, `/oauth`, `/.well-known`,
  `/mcp`, `/attachments`) into the Ingress path at the browser APIs (fetch,
  XHR, WebSocket, EventSource, src/href setters).
- `t3code/patches/*.patch` are applied to T3 Code's source at
  `T3CODE_VERSION` before building `apps/web` with `--base ./`. Today there
  is one: hash-based routing when `VITE_HASH_HISTORY=1`.
- The T3 server itself is the official release binary (Dockerfile), at the
  same version as the patched web source.

## Versions

`t3code/build.yaml` is the single source of truth: `T3CODE_VERSION` (server
binary and web source), `NODE_BUILD_VERSION` (upstream's `engines.node`) and
the pinned agent CLIs. `.github/workflows/upstream.yaml` bumps T3 Code daily
when there's a release.

## Verifying a change

```bash
scripts/verify-upstream.sh            # patches → web build → e2e in a browser
```

Needs Node at `NODE_BUILD_VERSION`, git and yq. Exit codes: 3 patch no longer
applies, 4 web build failed, 5 server deps failed, 1 e2e failed. The e2e
test (`tests/e2e/run.mjs`) runs T3 from source behind the real gateway and a
fake Ingress; keep its checks strict.

## Updating or regenerating a patch

```bash
git clone --depth 1 --branch v<VERSION> https://github.com/pingdotgg/t3code /tmp/t3
cd /tmp/t3
git apply --3way /path/to/t3code/patches/0001-*.patch   # or redo the change by hand
git -c core.hooksPath=/dev/null commit -am "<same subject as before>"
rm /path/to/t3code/patches/*.patch
git format-patch -1 --zero-commit --no-signature -o /path/to/t3code/patches/
```

`core.hooksPath=/dev/null` skips upstream's pre-commit hooks, which need a
full monorepo install. Prefer solving things in the gateway or shim over
adding patches: they survive upstream changes better.

## Rules

- Don't weaken or skip e2e checks to get green.
- The gateway must keep refusing requests that don't come from the
  Supervisor or lack a Home Assistant user.
- Don't write `SUPERVISOR_TOKEN` or other secrets into files under `/data`
  (they end up in backups); reference them from the environment.
- ShellCheck must pass for every shell script (`ci.yaml` lint job).
