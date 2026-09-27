# ┌──────────────────────────────────────────────────────────────────────┐
# │  STUB — NOT THE REAL ENGINE POOL.                                     │
# │                                                                       │
# │  The real service (PLAN §3, milestone M5) runs the engine build in    │
# │  Playwright-driven headless Chromium: one Chromium process per        │
# │  document job, Chromium sandbox on, CPU/memory/wall-clock limits,     │
# │  warm engines. It will live in packages/engine-pool and be built from │
# │  there (FROM mcr.microsoft.com/playwright + Bun, or Node if           │
# │  Playwright under Bun proves flaky).                                  │
# │                                                                       │
# │  This placeholder only answers GET /health and 501s everything else, │
# │  so the compose topology (internal `engine` network, no egress) can   │
# │  be exercised now.                                                    │
# └──────────────────────────────────────────────────────────────────────┘
FROM oven/bun:1.4.2-alpine
WORKDIR /srv
COPY stub.ts .
USER bun
EXPOSE 4000
CMD ["bun", "stub.ts"]
