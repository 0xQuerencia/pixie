# Revival progress — 2026-11-17

**Base:** `d7ff7741b97a8e92b096719f13663cce557bbfd3`

| Work | Status |
| --- | --- |
| Original landing | Restored on Vercel, verified via HTTPS on apex and www; independent of Core/Wizard |
| Insecure legacy console login | Draft PR #11 — not merged; tests not run |
| No-network unit test guard | Draft PR #14 — not merged; tests not run |
| Configurable manifest shortcut | Draft PR #12 — not merged; tests not run |
| Provider portability | Draft PR #15 — not merged; tests not run |
| Workspace-aware URLs | Draft PR #13 — not merged; tests not run |
| Self-host pilot | Draft PR #16 — not merged; Docker not tested |
| Architecture/runbook inventory | This draft PR — not merged |
| Performance/dead-code cleanup | Pending benchmark; no unverified deletion |
| Login/dashboard backend | Not restored by the landing deployment; separate auth/Core/database setup required |

**Validation blocked:** Bun, Docker and a full repository clone are unavailable in this execution environment. PR authors must run the repo's offline test suite, TypeScript and format checks, then review and merge explicitly. No Hack Club or other protected workspace touched.
