# SvelteKit app on Bun. Build context: repo root.
#
# NOT YET BUILDABLE: packages/app (the SvelteKit app) is being scaffolded
# separately. This file assumes it will:
#   - be a Bun workspace package named @parasocial/app with a `build` script
#     (vite build) using a Bun-compatible adapter (svelte-adapter-bun, or
#     @sveltejs/adapter-node run under Bun), emitting packages/app/build;
#   - start with `bun build/index.js`, listening on $PORT (3000);
#   - call createPlatform() from @parasocial/sync/server at startup (which
#     also runs migrations, so the migrate job is belt-and-braces).
# Adjust the last stage if the adapter's output differs.

FROM oven/bun:1.4.2 AS deps
WORKDIR /repo
COPY package.json bun.lock ./
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM deps AS build
ENV NODE_ENV=production
RUN bun run --cwd packages/app build

FROM oven/bun:1.4.2-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production PORT=3000
COPY --from=build /repo/package.json /repo/bun.lock ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages ./packages
WORKDIR /repo/packages/app
USER bun
EXPOSE 3000
CMD ["bun", "build/index.js"]
