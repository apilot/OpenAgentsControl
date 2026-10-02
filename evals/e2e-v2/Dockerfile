# oac-e2e — clean-room image for validating OpenAgentsControl work on real opencode v2.
# Nothing from the host repo is baked in: the repo is bind-mounted read-only at runtime.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      curl \
      ca-certificates \
      git \
      jq \
      python3 \
      python3-yaml \
      procps \
      unzip \
 && rm -rf /var/lib/apt/lists/*

# Legacy builder creates WORKDIR dirs as root — pre-create writable ones explicitly.
RUN mkdir -p /home/node/e2e /home/node/.local/share/opencode && chown -R node:node /home/node
USER node

# opencode v2 via the official curl installer; verify it landed in one of the two layouts.
RUN curl -fsSL https://opencode.ai/install | bash \
 && (test -x "$HOME/.opencode/bin/opencode" || test -x "$HOME/.local/bin/opencode")

ENV PATH="/home/node/.bun/bin:/home/node/.opencode/bin:/home/node/.local/bin:${PATH}"

# bun for our TS test suites (bun runs TypeScript natively); user-level installer.
RUN curl -fsSL https://bun.sh/install | bash \
 && "$HOME/.bun/bin/bun" --version

# opencode v2 CLI ships as `opencode2` from the `next` dist-tag (stable `opencode` is still the V1 engine).
RUN bun add -g opencode-ai@next \
 && opencode2 --version

ENV PATH="/home/node/.bun/bin:${PATH}"

WORKDIR /home/node/e2e
CMD ["bash"]
