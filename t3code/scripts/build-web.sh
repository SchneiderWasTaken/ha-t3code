#!/usr/bin/env bash
# Build T3 Code's web app for serving under Home Assistant Ingress.
#
#   build-web.sh <t3code-version> <patches-dir> <out-dir> [src-dir]
#
# Clones pingdotgg/t3code at v<version> (or reuses <src-dir> if it already
# holds a checkout), applies our patches, and builds apps/web with a relative
# asset base. Used by the Dockerfile, CI and the upstream-bump workflow, so a
# failure here is the first sign that an upstream change broke our patches.
#
# Exit codes: 3 = a patch no longer applies, 4 = the web build failed.
set -euo pipefail

version="${1:?t3code version}"
patches="$(cd "${2:?patches dir}" && pwd)"
out="${3:?output dir}"
src="${4:-$(mktemp -d)/t3code}"

if [[ ! -d "${src}/.git" ]]; then
    git clone --quiet --depth 1 --branch "v${version}" https://github.com/pingdotgg/t3code "${src}"
fi
cd "${src}"

shopt -s nullglob
for patch in "${patches}"/*.patch; do
    echo "Applying $(basename "${patch}")"
    if ! git apply --check "${patch}" 2>/tmp/patch-error; then
        echo "::error::$(basename "${patch}") no longer applies to t3code v${version}" >&2
        cat /tmp/patch-error >&2
        exit 3
    fi
    git apply "${patch}"
done

# Use exactly the pnpm upstream pins (Node 25+ no longer ships corepack).
pnpm_spec="$(node -p "(require('./package.json').packageManager || '').split('+')[0]")"
if [[ "${pnpm_spec}" == pnpm@* ]] && [[ "$(pnpm --version 2>/dev/null)" != "${pnpm_spec#pnpm@}" ]]; then
    npm install -g --no-fund --no-audit "${pnpm_spec}"
fi
pnpm install --frozen-lockfile --filter "@t3tools/web..."
if ! (cd apps/web && VITE_HASH_HISTORY=1 pnpm exec vp build --base ./); then
    echo "::error::T3 Code web build failed for v${version}" >&2
    exit 4
fi

rm -rf "${out}"
mkdir -p "$(dirname "${out}")"
cp -r apps/web/dist "${out}"

# Sanity check: assets must be relative or nothing loads under Ingress.
grep -q 'src="./assets/' "${out}/index.html" || {
    echo "::error::index.html does not use relative asset paths" >&2
    exit 4
}
echo "Built T3 Code web v${version} into ${out}"
