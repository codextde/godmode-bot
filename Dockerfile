# syntax=docker/dockerfile:1.7
#
# Godmode Bot — headless server with the web dashboard (for a home server, NAS, VPS, Raspberry Pi 4/5, …).
#
#   docker build -t godmode-bot .
#   docker run -d -p 7777:7777 -v godmode-data:/data -e ANTHROPIC_API_KEY=… godmode-bot
#   docker exec <container> godmode token        # access token for the dashboard
#
# Claude Code needs credentials: pass ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (`claude setup-token`), or log in
# once with `docker exec -it <container> claude` and keep /home/godmode/.claude on a volume (see docker-compose.yml).

ARG NODE_VERSION=22
ARG BUN_VERSION=1.3.14
ARG DEBIAN_RELEASE=bookworm

# ---------------------------------------------------------------------------------------------------------------
# Build: web UI (Vite) + standalone core binary with the UI embedded. Runs on the build machine's architecture and
# cross-compiles the binary for the target platform.
# ---------------------------------------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-debian AS bun

FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS build
ARG TARGETARCH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN corepack enable
WORKDIR /src

# Dependencies first (cached until the lockfile changes).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile

RUN pnpm --filter @godmode/desktop build
# amd64 uses the "baseline" build so the image also runs on CPUs without AVX2 (older NAS / mini PCs).
RUN case "$TARGETARCH" in \
      amd64) target=bun-linux-x64-baseline ;; \
      arm64) target=bun-linux-arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && cd packages/core \
    && bun run scripts/build.ts --target="$target" \
    && install -D -m 0755 "bin/godmode-${target#bun-}" /out/godmode

# ---------------------------------------------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------------------------------------------
FROM debian:${DEBIAN_RELEASE}-slim AS runtime
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl git openssh-client tini procps \
       chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Containers have no display and Docker's default seccomp profile blocks Chromium's user-namespace sandbox;
# the Debian chromium wrapper reads extra switches from /etc/chromium.d.
RUN printf '%s\n' 'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --headless=new --no-sandbox --disable-dev-shm-usage"' \
      > /etc/chromium.d/godmode-container

# uv / uvx runs the browser-use MCP server.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
    && uv --version

RUN groupadd --gid 10001 godmode \
    && useradd --uid 10001 --gid godmode --create-home --home-dir /home/godmode --shell /bin/bash godmode \
    && mkdir -p /data /home/godmode/.claude /home/godmode/.cache \
    && chown -R godmode:godmode /data /home/godmode

USER godmode
ENV HOME=/home/godmode \
    PATH=/home/godmode/.local/bin:/usr/local/bin:/usr/bin:/bin \
    DISABLE_AUTOUPDATER=1

# Claude Code CLI (official native installer) → ~/.local/bin/claude
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && claude --version

COPY --from=build /out/godmode /usr/local/bin/godmode

ENV GODMODE_HOME=/data \
    GODMODE_PORT=7777
VOLUME ["/data"]
EXPOSE 7777
WORKDIR /data

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7777/api/health >/dev/null || exit 1

# tini reaps Chromium / Claude Code child processes and forwards SIGTERM for a clean shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["godmode", "serve", "--host", "0.0.0.0"]
