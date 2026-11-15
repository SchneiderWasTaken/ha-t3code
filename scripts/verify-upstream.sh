#!/usr/bin/env bash
# Build T3 Code's web app with our patches and run the end-to-end test
# against T3 Code from source, at the version pinned in t3code/build.yaml.
#
#   scripts/verify-upstream.sh [work-dir]
#
# Needs Node at t3code/build.yaml's NODE_BUILD_VERSION, plus git and yq.
# This is what CI runs and what to run locally after touching patches,
# the gateway or the shim. Exit status: 0 pass, 3 patch conflict,
# 4 web build failure, 5 server deps, 1 e2e failure.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="${1:-${RUNNER_TEMP:-$(mktemp -d)}/verify}"
version="$(yq -r '.args.T3CODE_VERSION' "${repo}/t3code/build.yaml")"
src="${work}/t3code"
web="${work}/web"
mkdir -p "${work}"

echo "::group::Build T3 Code web v${version} with patches"
"${repo}/t3code/scripts/build-web.sh" "${version}" "${repo}/t3code/patches" "${web}" "${src}"
echo "::endgroup::"

echo "::group::Install T3 Code server dependencies"
(cd "${src}" && pnpm install --frozen-lockfile --filter "t3...") || exit 5
echo "::endgroup::"

echo "::group::Install Playwright"
(cd "${repo}/tests/e2e" && npm ci --no-fund --no-audit && npx playwright install --with-deps chromium)
echo "::endgroup::"

T3_SRC="${src}" WEB_ROOT="${web}" node "${repo}/tests/e2e/run.mjs"
