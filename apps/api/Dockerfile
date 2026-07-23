# syntax=docker/dockerfile:1
#
# Production image for @taporder/api (Fastify backend).
#
# IMPORTANT: build context is the REPO ROOT, not apps/api. This is a Turborepo
# monorepo and the API depends on the workspace package @taporder/types, so a
# build scoped to apps/api alone cannot resolve that dependency. Build with:
#
#   docker build -f apps/api/Dockerfile -t otlobly-api .
#
# Base image is Debian-slim (glibc). Prisma's schema pins no `binaryTargets`, so
# the client generates for the "native" target. Building and running on the SAME
# glibc base means native == runtime, avoiding the classic Prisma
# "query engine not found" mismatch — no schema change required. (An Alpine/musl
# base would require adding a musl binaryTarget to schema.prisma, out of scope.)
# openssl + ca-certificates are installed because Prisma's engine needs libssl
# present on Debian-slim.
#
# Two-track install: the BUILD stage runs a full workspace `npm ci` so that
# transitive/hoisted devDependencies match the host (apps/api's tsc resolves
# @types/ws only via root hoisting from apps/agent). The RUNTIME stage installs
# a pruned, prod-only subtree so the final image stays lean.
#
# Secrets are NEVER baked in: no .env is copied (see .dockerignore). The runtime
# .env is injected by the host (docker run --env-file / compose env) at start.

# ── Stage 1: prune the monorepo down to just the API + its workspace deps ──
# `turbo prune --docker` emits a minimal subtree (out/json = manifests + pruned
# lockfile for the lean runtime install; out/full = source), so the runtime
# install carries only api + types prod deps, not web/agent.
FROM node:22-slim AS pruner
WORKDIR /app
# turbo is already a repo devDependency; installed globally here only as build
# tooling for the prune step (not a new project dependency). Pinned to match root.
RUN npm install -g turbo@2.9.18
COPY . .
RUN turbo prune @taporder/api --docker

# ── Stage 2: full install, generate Prisma client, compile TypeScript ──
FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Manifests first for a cache-friendly install layer. Full workspace install so
# hoisted devDeps (e.g. @types/ws) resolve exactly as they do on the host.
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json    apps/api/package.json
COPY apps/web/package.json    apps/web/package.json
COPY apps/agent/package.json  apps/agent/package.json
COPY packages/types/package.json packages/types/package.json
RUN npm ci
# Source.
COPY . .
# Generate the Prisma client into node_modules/.prisma at BUILD time so the
# engine binary is present in the image (no generate on container start).
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma
# Build the shared types package first, then the API (tsc → dist/).
RUN npm run build --workspace=@taporder/types \
 && npm run build --workspace=@taporder/api

# ── Stage 3: lean runtime — only what's needed to run the compiled server ──
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# PORT is not a secret; a sane default keeps the image runnable and makes EXPOSE
# meaningful. Override via the injected runtime env if the host maps another port.
ENV PORT=3000
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 1001 --create-home nodeapp
# Production dependencies only (pruned lockfile; no tsc, prisma CLI, or tsx).
COPY --from=pruner /app/out/json/ ./
RUN npm ci --omit=dev
# Copy the generated Prisma client + engine over the fresh prod install.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
# Compiled output. The @taporder/types workspace symlink was created by npm ci
# above; it resolves to packages/types, whose dist we copy here.
COPY --from=builder /app/packages/types/dist ./packages/types/dist
COPY --from=builder /app/apps/api/dist ./apps/api/dist
# Schema kept alongside for reference / manual prisma ops; not read on boot.
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
USER nodeapp
EXPOSE 3000
# Run the compiled server. NOTE: no `prisma migrate` here — migrations run
# separately against Supabase, never on container start.
CMD ["node", "apps/api/dist/src/index.js"]
