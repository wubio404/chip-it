# TapOrder — Project Rules

Read TAPORDER_SPEC.md before any work. It is the source of truth. @TAPORDER_SPEC.md

## Hard rules (from spec Section 0 & 19)
- Build ONE phase per session. Do not skip ahead or merge phases.
- The Prisma schema (5.3) and TS interfaces (PosConnector, ConnectorResult, CanonicalOrder) are normative — implement exactly. All other code blocks in the spec are illustrative.
- Every connector implements PosConnector. The router owns fallback; connectors are pure.
- Money is integer piastres everywhere. Never floats.
- Paymob: follow Appendix A (Section 21) exactly, especially the HMAC field order.
- Ask before adding any dependency not implied by the spec.
- Stop at the end of each scoped task and tell me how to verify it before continuing.

## Stack
Turborepo (web / api / agent + shared types), TypeScript, Next.js 14 App Router, Fastify, Prisma + Postgres, Redis.

## Known gaps (tracked, not yet fixed)
- **PWA menu never re-fetches after initial load.** `apps/web/src/components/menu/MenuPage.tsx` receives `venue` as a static prop from the server component and never re-fetches `GET /venues/:slug`. Spec §12 calls for a 60s poll (or SSE) so sold-out toggles from the admin panel show up live; right now a customer only sees an availability change after a full page reload. The admin-side cache invalidation on toggle is correct and immediate — this gap is entirely on the PWA read side. Small, self-contained follow-up; deliberately not bundled into the admin-panel session that surfaced it.