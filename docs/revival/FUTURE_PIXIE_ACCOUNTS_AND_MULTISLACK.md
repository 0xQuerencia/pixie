# Future architecture (design only; not approved for implementation)

Independent Pixie Accounts require verified identifiers, MFA/recovery policy, revocable sessions, organization membership/RBAC, audit logging and an explicit migration path from current HCA-linked data. Do **not** auto-link accounts by unverified email or replace current owner IDs in place.

Independent Slack installations require explicit OAuth install/uninstall, per-workspace encrypted and revocable credentials, isolated program/channel/ticket/cache keys, per-install scopes, per-workspace background-job scheduling and tests proving workspace A never sees B's data. Existing Socket Mode single-workspace initialization is not multi-workspace ready.

Migration order: document identity mapping, create additive tables, test on disposable copies, explicitly verify owner links, ship dual-read safely with feature flags, migrate progressively, and rehearse rollback. This is not a deployment proposal.
