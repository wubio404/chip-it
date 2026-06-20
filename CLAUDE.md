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