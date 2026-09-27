# One-shot migration job: applies packages/sync/migrations/*.sql, then exits.
# Build context: repo root. The runner only needs `postgres`.
FROM oven/bun:1.4.2-alpine
WORKDIR /srv/sync
RUN echo '{"name":"migrate","private":true,"type":"module"}' > package.json \
  && bun add --exact postgres@3.4.7 \
  && rm -rf ~/.bun/install/cache
COPY packages/sync/migrations ./migrations
COPY packages/sync/src/server/migrate.ts ./src/server/migrate.ts
USER bun
CMD ["bun", "src/server/migrate.ts"]
