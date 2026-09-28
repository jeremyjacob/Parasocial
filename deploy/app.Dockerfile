# SvelteKit app on Bun, plus the engine origin (deploy/app-start.ts). Build context: repo root.
# The app runs migrations on startup too (createPlatform), so the migrate job is belt-and-braces.

FROM oven/bun:1.4.2 AS deps
WORKDIR /repo
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY tests/package.json ./tests/package.json
RUN bun install --frozen-lockfile

FROM deps AS build
ENV NODE_ENV=production
RUN bun run --cwd packages/app build

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production PORT=3000 BLOB_DIR=/data/blobs
COPY --from=build /repo/package.json /repo/bun.lock ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
COPY examples ./examples
COPY deploy/app-start.ts ./deploy/app-start.ts
# the engine origin builds its bundle into packages/runtime/dist on start; blobs live on a volume
RUN chown bun packages/runtime && mkdir -p /data/blobs && chown bun /data/blobs
USER bun
EXPOSE 3000 5174
CMD ["bun", "deploy/app-start.ts"]
