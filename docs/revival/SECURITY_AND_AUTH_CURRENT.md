# Auth and trust boundaries

1. **Wizard:** `pixie-wizard/app/api/auth/login/route.ts` links to Hack Club Auth and `pixie-wizard/lib/session.ts` verifies signed session cookies. Existing HCA-linked identities and access rules stay in place. No Pixie Accounts or identity migration is implemented.
2. **Core:** `lib/web/auth.ts` signs sessions; `lib/web/serve.ts` gates legacy dashboard routes. Existing main had unsafe hardcoded default passcode `pixie` and `SLACK_CLIENT_ID=dev-testing` admin login path. PR #11 removes these and changes default bind to localhost.
3. **Internal:** `/internal/v1/*` API methods require a separate `PIXIE_INTERNAL_TOKEN`. Do not expose these routes to the public internet or confuse this token with a user session.
4. **Programs/workspaces:** preserve per-program grants, authorizations, state ownership and audit trails. Socket Mode runtime remains single-workspace. Treat multi-workspace isolation as unproven until explicitly tested.
5. **Operations:** terminate TLS at a trusted proxy, configure authentication and proxy-side login rate limits, use randomly generated secrets, restrict access to SQLite/Postgres volumes, and run no live Hack Club tests without permission.

Findings are code-level observations only. Regression PRs remain drafts until checks pass. Security controls outside the app must be configured and verified by its authorized operator.
