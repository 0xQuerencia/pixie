# Current Pixie architecture (verified from main at d7ff7741)

- **Core:** Bun/TypeScript `index.ts`, Slack Bolt Socket Mode, single app token/client. `lib/commands.ts`, `lib/respond.ts`, `lib/intent.ts`, `lib/answer.ts`, `lib/tickets.ts` implement command, answer and support paths. Multi-workspace OAuth is **not** supported by this entrypoint.
- **Core persistence:** `lib/db.ts` uses `PIXIE_DB_PATH` and SQLite; operational tickets and learned answers live there. Never reset a real database while testing.
- **Legacy console/API:** `lib/web/serve.ts` serves the console and `/api/*`, `/internal/v1/*`. Authentication checks reside in `lib/web/auth.ts`; internal API uses separate token gates. PR #11 proposes removal of unsafe legacy passcode and dev bypass.
- **Wizard:** Next.js 16 + React 19 under `pixie-wizard/`; the original public landing is `app/page.tsx` -> `app/landing/LandingExperience.tsx`. Wizard dashboards, program pages, APIs and `lib/db.ts` use PostgreSQL. HCA OAuth is still the existing account login.
- **Integrations:** Slack, optional AI endpoints (OpenCode Zen, HCAI, Groq, OpenRouter and configured answer router), program-specific source adapters, optional Railway service paths. No one provider should silently become compulsory.
- **Hosting:** current live public original landing is a separate Vercel deployment; this repo's code alone does not prove authenticated Wizard/Core services are live.
- **Background operations:** `index.ts` starts report, warm, ticket-backfill and resolution services alongside the Slack Socket Mode runtime; operate them as a single-instance process until per-workspace storage/coordination is proven.

This is an inventory of current code, not a claim that all features work in production.
