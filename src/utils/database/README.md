# `src/utils/database/` — Kysely + bun:sqlite

Thin shared layer over `bun:sqlite`. **Use `createKyselyClient<DB>()` for new code.**

## Why Kysely (not Drizzle / Prisma)

- **Half the owned DBs use FTS5/sqlite-vec.** Drizzle's auto-migration generator does not understand `CREATE VIRTUAL TABLE` ([drizzle-orm#2046](https://github.com/drizzle-team/drizzle-orm/issues/2046)).
- **3 readonly Apple system DBs** (Mail, Contacts, Voice Memos). Schema-as-code is a liability there — Kysely's interface-only typing is right.
- **Indexer has dynamic per-source columns.** No static schema can model that — Kysely lets us mix typed and untyped paths.
- **Most call sites already use parameterized SQL.** They need typed results + composable predicates, not an ORM.

## Quick start

```ts
import { createKyselyClient } from "@genesiscz/utils/database";
import type { DB } from "./db-types";

const client = createKyselyClient<DB>({
    path: "/path/to/file.db",
    bootstrap: [
        `CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL
        )`,
    ],
});

await client.kysely.selectFrom("users").select(["id", "name"]).execute();
```

## When to use what

| Need | Use |
|---|---|
| Type-safe SELECT/INSERT/UPDATE/DELETE | `client.kysely.<query>` |
| Composable WHERE clauses with tokens | `buildLikePredicate(tokens, columns)` from `@genesiscz/utils/database` |
| FTS5 `CREATE VIRTUAL TABLE` | `migrations` option on `createKyselyClient` (existing `runMigrations` framework) |
| FTS5 `MATCH` operator | `sql\`${col} MATCH ${query}\`` inside `where(...)` |
| sqlite-vec extension | Load via `onOpen`; query via `client.raw` (vec0 doesn't fit a static interface) |
| `ATTACH DATABASE` | `client.raw.run("ATTACH DATABASE '...' AS x")` |
| `PRAGMA table_info(...)` | `client.raw.prepare(...).all()` |
| Dynamic schema (indexer per-source columns) | Stays raw (`client.raw` + `migrations`) |

## Per-tool layout

```
src/<tool>/lib/
├── db-types.ts        # interface DB { table_a: {...}; table_b: {...} }
├── db.ts              # getDatabase() singleton returning DatabaseClient<DB>
└── ... use the typed client ...
```

## Migrations

The existing `runMigrations()` framework handles versioned DDL — pass `migrations` to `createKyselyClient`. Used for:

- FTS5 virtual table creation + sync triggers
- One-off data fixes
- Schema changes that aren't expressible as `CREATE TABLE IF NOT EXISTS`

For greenfield tables, the `bootstrap` option (`CREATE TABLE IF NOT EXISTS …`) is enough — no migration needed because there's nothing to migrate from.

### Shared provider history database

`~/.genesis-tools/claude-history/index.db` is one physical database with independently scoped owners:

- `provider_history` migrations own provider metadata, source freshness, discovery generations, and aggregate history statistics.
- `usage_limits` migrations own `usage_snapshots` and `spend_snapshots`.

History metadata and statistics use the shared `HistoryDatabase` connection, but opening a read-only status/title lookup must not initialize either schema. Rebuild/reset operations may clear only their provider-scoped derived rows. They must preserve usage/spend observations and tables owned by other migration scopes. Transcript bodies remain in native source files or provider projections; this database stores no message mirror or FTS transcript index.

## Future swap to Drizzle / Prisma

Each tool owns its own `db-types.ts` + `db.ts`. To swap, rewrite those two files for that tool only. The thin contract makes it local — no codebase-wide refactor.
