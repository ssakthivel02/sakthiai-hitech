# Real-MySQL integration tests

`pnpm test:mysql` runs every `*.mysql.test.ts` against a real MySQL-compatible server and **fails** if `TEST_DATABASE_URL` is missing (plain `pnpm test` skips these suites).

- `TEST_DATABASE_URL=mysql://user:pass@127.0.0.1:3306` uses server-level credentials; each suite creates a uniquely named throwaway database (`sakthi_it_*`), applies every migration in `drizzle/meta/_journal.json`, and drops it afterwards. Managed hosts (Aiven, Render, RDS, Azure) are refused; non-loopback hosts need `MYSQL_TEST_ALLOW_REMOTE=1`.
- CI: the `mysql-integration` job in the Quality Gate uses a `mysql:8.0` service container.
- Local run (any MySQL/MariaDB): start a server, create a user with CREATE/DROP privileges, export the URL, run `pnpm test:mysql`.
- Covered: migrations vs `drizzle/schema.ts`, indexes and query plans, provider policy/budget/breaker persistence and concurrency, session revocation, workspace membership and tenant isolation through tRPC, upload through a real clamd INSTREAM protocol server (clean / infected / scanner down), storage ownership, retrieval and grounding, readiness.
- Substituted: object storage (put is faked) and the model transport (stub adapter). Nothing else.
- Evidence level: LOCALLY_TESTED on MariaDB 10.11; MySQL 8 results are CI_PENDING until the job is observed.
