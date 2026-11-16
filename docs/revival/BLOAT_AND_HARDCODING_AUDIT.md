# Evidence-led cleanup inventory

| Finding | Evidence | Disposition |
| --- | --- | --- |
| Legacy default console password | `lib/web/serve.ts` `PIXIE_DASHBOARD_PASSCODE || "pixie"` at d7ff7741 | PR #11 removes |
| Legacy testing admin bypass | `SLACK_CLIENT_ID === "dev-testing"` in `lib/web/serve.ts` and `lib/web/auth.ts` | PR #11 removes |
| Railway-only answer endpoint | `lib/config.ts` private internal hostname | PR #15 makes defaults portable |
| Fixed Hack Club thread URL | `lib/relatedThreads.ts` `hackclub.slack.com` | PR #13 validates workspace URL |
| Manifest shortcut too long when rebranded | `scripts/manifest.cjs` appends display name | PR #12 bounds label length |
| Large files | `lib/tickets.ts`, `lib/db.ts`, `lib/web/api.ts`, `lib/respond.ts`, `lib/handlers.ts` | **Do not delete/refactor on size alone** |
| Hack Club Auth/program adapters | Existing identity and integrations | **Retain**, no removal or identity migration |
| Background jobs and provider traffic | `index.ts` startup jobs; optional provider config | Benchmark offline before optimizing |

No performance improvement or dead-code deletion is claimed here without measured evidence.
