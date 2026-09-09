import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { historyDatabasePath } from "../../src/utils/agent-sessions/database";
import { openHistoryService } from "../../src/utils/agent-sessions/open-service";
import { env } from "../../src/utils/env";
import { SafeJSON } from "../../src/utils/json";

const OBSERVATIONS = ["usage_snapshots", "spend_snapshots"] as const;
const ADDITIONAL_BUDGET = 1_000_000_000;

async function footprint(path: string) {
    const sizes = await Promise.all(
        [path, `${path}-wal`, `${path}-shm`].map(async (file) => {
            try {
                return (await stat(file)).size;
            } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                    return 0;
                }
                throw error;
            }
        })
    );
    return { main: sizes[0], wal: sizes[1], shm: sizes[2], total: sizes.reduce((sum, value) => sum + value, 0) };
}

function observations(database: Database) {
    return Object.fromEntries(
        OBSERVATIONS.map((table) => {
            const hash = createHash("sha256");
            let count = 0;
            for (const row of database.query(`SELECT * FROM ${table} ORDER BY id`).iterate()) {
                hash.update(SafeJSON.stringify(row, { strict: true }));
                hash.update("\n");
                count++;
            }
            const schema = database
                .query("SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? ORDER BY type,name")
                .all(table);
            return [
                table,
                {
                    count,
                    sha256: hash.digest("hex"),
                    schemaSha256: createHash("sha256")
                        .update(SafeJSON.stringify(schema, { strict: true }))
                        .digest("hex"),
                },
            ];
        })
    );
}

/** Rehearse against a consistent disposable backup. The source database and native transcripts remain read-only. */
export async function rehearseHistoryCorpus(options: {
    source: string;
    output: string;
    roots?: Partial<Record<"claude" | "codex" | "grok", string[]>>;
}) {
    const source = resolve(options.source);
    if ([source, `${source}-wal`, `${source}-shm`].includes(resolve(options.output))) {
        throw new Error("The rehearsal report must not overwrite the source database or its sidecars");
    }
    const baseline = await footprint(source);
    const scratch = await mkdtemp(join(tmpdir(), "history-corpus-rehearsal-"));
    const copy = join(scratch, "index.db");
    let database: Database | undefined;
    try {
        const backup = Bun.spawn(["sqlite3", "-readonly", source, `.backup '${copy.replaceAll("'", "''")}'`], {
            env: env.getProcessEnv(),
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
        });
        const stderr = await new Response(backup.stderr).text();
        if ((await backup.exited) !== 0) {
            throw new Error(`Consistent history backup failed: ${stderr}`);
        }
        database = new Database(copy);
        const before = observations(database);
        const providers = [];
        for (const provider of ["claude", "codex", "grok"] as const) {
            const started = performance.now();
            const service = openHistoryService({ provider, database, roots: options.roots?.[provider] });
            const synced = await service.sync();
            const stats = await service.refreshStatistics();
            providers.push({
                provider,
                elapsedMs: performance.now() - started,
                sessions: synced.report.sessions,
                sources: synced.report.sources,
                parsed: synced.report.parsed,
                issues: synced.report.issues.length,
                statistics: { parsed: stats.parsed, coverage: stats.coverage, issues: stats.issues.length },
            });
        }
        const after = observations(database);
        const protectedDataPreserved =
            SafeJSON.stringify(before, { strict: true }) === SafeJSON.stringify(after, { strict: true });
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        database.close();
        database = undefined;
        const final = await footprint(copy);
        const growth = final.total - baseline.total;
        const report = {
            measuredAt: new Date().toISOString(),
            baseline,
            final,
            growth,
            allowance: ADDITIONAL_BUDGET,
            withinBudget: growth <= ADDITIONAL_BUDGET,
            protectedDataPreserved,
            observations: { before, after },
            providers,
        };
        await mkdir(dirname(resolve(options.output)), { recursive: true });
        await writeFile(options.output, `${SafeJSON.stringify(report, { strict: true, pretty: true })}\n`, {
            mode: 0o600,
        });
        if (!protectedDataPreserved || !report.withinBudget) {
            throw new Error(`Corpus rehearsal failed preservation or budget; see ${options.output}`);
        }
        return report;
    } finally {
        database?.close();
        await rm(scratch, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const output = process.argv[2];
    if (!output) {
        throw new Error("Usage: bun scripts/history/corpus-rehearsal.ts <report.json> [source.db]");
    }
    const report = await rehearseHistoryCorpus({ source: process.argv[3] ?? historyDatabasePath(), output });
    process.stdout.write(`${SafeJSON.stringify(report, { strict: true })}\n`);
}
