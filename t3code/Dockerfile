ARG BUILD_FROM
FROM ${BUILD_FROM}

ARG BUILD_ARCH
ARG BUILD_VERSION
ARG T3CODE_VERSION
ARG NODE_MAJOR=22
ARG AGENT_NPM_PACKAGES=""

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Tools the agents expect to find: git for worktrees/diffs, ripgrep for
# search, and the usual shell utilities.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git gnupg jq less openssh-client \
        python3 ripgrep tar unzip xz-utils \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# T3 Code server: the standalone release binary, checked against the
# release's SHA256SUMS (the same thing `npx t3` does at runtime).
RUN case "${BUILD_ARCH}" in \
        amd64) T3_KEY="linux-x64" ;; \
        aarch64) T3_KEY="linux-arm64" ;; \
        *) echo "Unsupported arch: ${BUILD_ARCH}" >&2; exit 1 ;; \
    esac \
    && BASE="https://github.com/pingdotgg/t3code/releases/download/v${T3CODE_VERSION}" \
    && ARCHIVE="t3-${T3CODE_VERSION}-${T3_KEY}.tar.gz" \
    && cd /tmp \
    && curl -fsSLO "${BASE}/SHA256SUMS" \
    && curl -fsSLO "${BASE}/${ARCHIVE}" \
    && grep -E "[[:space:]]\*?${ARCHIVE}\$" SHA256SUMS | awk '{print $1"  '"${ARCHIVE}"'"}' | sha256sum -c - \
    && mkdir -p /opt/t3code \
    && tar -xzf "${ARCHIVE}" -C /opt/t3code --strip-components=1 \
    && ln -s /opt/t3code/t3 /usr/local/bin/t3 \
    && rm -f /tmp/SHA256SUMS "/tmp/${ARCHIVE}"

# Agent harnesses (the things T3 Code drives).
RUN if [ -n "${AGENT_NPM_PACKAGES}" ]; then \
        npm install -g --no-fund --no-audit ${AGENT_NPM_PACKAGES}; \
    fi \
    && npm cache clean --force

COPY rootfs /
RUN chmod +x /etc/s6-overlay/s6-rc.d/t3code/run \
              /etc/s6-overlay/s6-rc.d/t3code/finish \
              /usr/local/bin/*

LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="addon" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.title="T3 Code for Home Assistant" \
    org.opencontainers.image.source="https://github.com/SchneiderWasTaken/ha-t3code" \
    org.opencontainers.image.licenses="MIT"
