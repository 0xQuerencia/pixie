# Runtime dependencies

| Component | Dependency | Configuration | When necessary |
| --- | --- | --- | --- |
| Core Slack Socket Mode | Slack bot/app tokens and installed app | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | For bot runtime |
| Core local state | Persistent SQLite storage | `PIXIE_DB_PATH` | For tickets, learned answers |
| Legacy console | Authenticated session and optional passcode | `PIXIE_SESSION_SECRET`, `PIXIE_DASHBOARD_PASSCODE` | For legacy web console |
| Core internal API | Privileged bearer token | `PIXIE_INTERNAL_TOKEN` | For Wizard/Core communication |
| Answer model | Optional AI API/endpoint | `PIXIE_ANSWER_BASE_URL`, `PIXIE_ANSWER_API_KEY`, `PIXIE_MODEL` | For model-powered answers |
| Related thread links | Trusted Slack domain | `PIXIE_SLACK_WORKSPACE_URL` (PR #13) | For workspace-correct permalink rendering |
| Wizard | PostgreSQL | `DATABASE_URL` | For program/admin dashboards |
| Wizard login | Hack Club Auth application | `HCA_CLIENT_ID`, `HCA_CLIENT_SECRET`, `BASE_URL`, `SESSION_SECRET` | Existing Wizard identity, not replaced |
| Hosting | TLS proxy and public DNS | Operator-managed | For actual public access |

Do not pass secrets to browser code or commit a filled-in deployment environment file. Retaining a Hack Club integration does not authorize use of its workspace.
