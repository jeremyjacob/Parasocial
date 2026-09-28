# Engine pool (PLAN §3): the pool server on Bun, one Deno process per active document running
# the engine build. Build context: repo root.
#
# Deno is the sandbox: each document's process may only read the engine build (no network, env,
# writes or subprocesses). The compose `engine` network adds no egress on top.
# Renders use WebGPU; without a GPU, Mesa's lavapipe (software Vulkan) provides the adapter.

FROM oven/bun:1.4.2 AS deps
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY tests/package.json ./tests/package.json
RUN bun install --frozen-lockfile

FROM denoland/deno:bin-2.9.1 AS deno

FROM oven/bun:1.4.2-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends mesa-vulkan-drivers libvulkan1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno
WORKDIR /repo
COPY --from=deps /repo/package.json /repo/bun.lock ./
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/packages ./packages
# the engine build is written next to the server on start
RUN chown -R bun /repo/packages/engine-pool
USER bun
ENV POOL_HOST=0.0.0.0 POOL_PORT=4000
EXPOSE 4000
CMD ["bun", "packages/engine-pool/src/server.ts"]
