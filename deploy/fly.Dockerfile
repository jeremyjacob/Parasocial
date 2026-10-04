# Parasocial on Fly.io (see fly.toml): every service in one image, run by deploy/fly-start.ts on a
# single machine with a /data volume, so the whole stack stops when idle and starts on the next request.
#
#   caddy :8080 (Fly's proxy terminates TLS)  →  app :3000, engine origin :5174, zero-cache :4848
#   postgres :5432 (localhost), engine-pool :4000 (localhost)
#
# Build context: repo root.

FROM oven/bun:1.4.2 AS deps
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY tests/package.json ./tests/package.json
RUN bun install --frozen-lockfile

FROM deps AS build
ENV NODE_ENV=production
RUN bun run --cwd packages/app build

# zero-cache from npm on glibc (the rocicorp/zero image is Alpine, so its native modules don't fit here).
# Must match the @rocicorp/zero version pinned in packages/sync/package.json.
FROM node:22-trixie AS zero
WORKDIR /opt/zero
RUN echo '{"name":"zero-cache","private":true}' > package.json \
 && npm install --omit=dev --no-audit --no-fund @rocicorp/zero@1.9.0

FROM denoland/deno:bin-2.9.1 AS deno
FROM caddy:2.10 AS caddy

FROM oven/bun:1.4.2-slim AS runtime
RUN mkdir -p /etc/postgresql-common \
 && echo "create_main_cluster = false" > /etc/postgresql-common/createcluster.conf \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-17 mesa-vulkan-drivers libvulkan1 libstdc++6 ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=zero /usr/local/bin/node /usr/local/bin/node
COPY --from=zero /opt/zero /opt/zero
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo/package.json /repo/bun.lock ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY examples ./examples
COPY deploy/app-start.ts deploy/fly-start.ts deploy/fly.Caddyfile ./deploy/
# the engine origin and the pool write their builds next to their sources on start
RUN chown -R bun packages/runtime packages/engine-pool
EXPOSE 8080
CMD ["bun", "deploy/fly-start.ts"]
