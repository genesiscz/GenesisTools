# Database Infrastructure

- **Storage**: `src/utils/storage/storage.ts` owns per-tool config/cache directories under `~/.genesis-tools/<tool>/`; wrap it with tool-specific subclasses such as `IndexerStorage`.
- **MacDatabase**: `src/utils/macos/MacDatabase.ts` is the read-only base accessor for system SQLite databases (Mail Envelope Index, Messages, etc.) and exposes subclass-owned `getMigrator()`.
- **Generic migrations**: `src/utils/database/migrations.ts` provides `Migration`, `runMigrations()`, `getPendingMigrations()`, and `Migrator`; applied IDs are persisted in `_migrations` while schema-aware migrations can use `isApplied`.
- **Indexer migrations**: `src/indexer/lib/indexer-migrations.ts` defines `INDEXER_MIGRATIONS`, which `createIndexStore()` applies on read-write opens.
- **Usage-limits migrations**: `src/utils/ai/usage-poll/migrations.ts` defines `USAGE_LIMITS_MIGRATIONS` (id `2026-09-usage-limits-provider`, scope `usage_limits`), which `UsageLimitsDb.ensureSchema()` applies on every open of `~/.genesis-tools/claude-history/index.db`. It adds `provider`, `account_id`, `kind` and the money columns to `usage_snapshots`, and `provider` to `spend_snapshots`. Do not add it to `INDEXER_MIGRATIONS`.
- **Metadata schema**: `src/indexer/lib/metadata-schema.ts` supports per-source typed columns plus `metadata_json TEXT DEFAULT '{}'` for ad-hoc fields; typed columns are used for filter pushdown and unindexed extras round-trip through the JSON bag.
- **Test pattern**: When adding DB logic, use an in-memory `new Database(":memory:")` in `*.test.ts` files grouped alongside source.
