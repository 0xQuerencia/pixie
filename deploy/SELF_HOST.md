# Isolated self-host pilot (not deployed)

This stack is for an **authorized**, single-workspace installation. Do not attach it to any workspace without permission. It preserves existing Hack Club Auth and other optional integrations; independent account auth and multi-workspace OAuth are not implemented.

1. Copy `deploy/selfhost.env.example` to `deploy/selfhost.env`, replace placeholders with securely generated values, and set a real `BASE_URL`. Do not commit secrets.
2. Start with `docker compose --env-file deploy/selfhost.env -f deploy/compose.yml up --build -d postgres`.
3. After Postgres is healthy, migrate the wizard: `docker compose --env-file deploy/selfhost.env -f deploy/compose.yml run --rm wizard bun run migrate`.
4. Start Core and Wizard: `docker compose --env-file deploy/selfhost.env -f deploy/compose.yml up --build -d core wizard`.
5. Place a properly configured TLS reverse proxy in front of the Wizard's loopback-bound port 4901. Core is loopback-only on host port 4100. Do not publicly expose `/internal/v1/*` or publish Postgres.
6. Verify the public landing route, authorized login and basic Core health **in a test workspace**. The dashboard still needs supported auth, database state and configured provider credentials.
7. Back up SQLite using a consistent SQLite backup (such as `VACUUM INTO` while attached, or take a snapshot with Core stopped) and PostgreSQL with `pg_dump`. Test restores on disposable volumes.
8. To roll back, stop Core and Wizard, restore the prior pinned image/commit and consistent DB backups. Never apply migrations to a production database without separately reviewing their reversibility.

Core's legacy Railway Dockerfile remains untouched; this compose is isolated. A deployment dry-run and test suite still need to be performed on a host with Docker and Bun.
