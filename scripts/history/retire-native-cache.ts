/**
 * Retires `~/.genesis-tools/native-history`, the parallel index an earlier draft of this branch
 * built before it was steered back onto the shared `claude-history/index.db`. It only ever
 * existed on the machine that ran that draft; master never wrote it, so nothing here is a
 * backup and none is needed. Everything in it is derived from the native transcripts and is
 * rebuilt by an ordinary search.
 *
 * The manifest this writes is a receipt, not a backup: what was deleted, how large it was, and
 * when. It is deliberately small, and it cannot restore anything.
 *
 * Run once, after the merge: `bun scripts/history/retire-native-cache.ts` inspects and prints,
 * and only `--confirm-delete-native-history` deletes.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";

const EXPECTED_TABLES = [
    "_migrations",
    "native_issues",
    "native_messages",
    "native_records",
    "native_sessions",
    "native_sources",
    "native_text_content",
    "native_text_fts",
    "native_text_fts_config",
    "native_text_fts_data",
    "native_text_fts_docsize",
    "native_text_fts_idx",
] as const;
const EXPECTED_FILES = new Set(["index.db", "index.db-shm", "index.db-wal"]);
const EXPECTED_MIGRATIONS = ["native_history:native-history-records-v2", "native_history:native-history-v1"];

export interface NativeCacheRetirementReport {
    target: string;
    exists: boolean;
    bytes: number;
    files: string[];
    tables: string[];
    schemaMatches: boolean;
    openProcesses: Array<{ pid: number; command: string }> | "unknown";
}

function retiredTarget(toolsHome: string): string {
    return join(resolve(toolsHome), ".genesis-tools", "native-history");
}

function databaseSchema(path: string): { tables: string[]; migrationIds: string[] } {
    const db = new Database(path, { readonly: true });

    try {
        const tables = db
            .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all()
            .map((row) => row.name);
        const migrationIds = tables.includes("_migrations")
            ? db
                  .query<{ id: string }, []>("SELECT id FROM _migrations ORDER BY id")
                  .all()
                  .map((row) => row.id)
            : [];
        return { tables, migrationIds };
    } finally {
        db.close();
    }
}

function openProcesses(paths: string[]): NativeCacheRetirementReport["openProcesses"] {
    const lsof = Bun.which("lsof") ?? (existsSync("/usr/sbin/lsof") ? "/usr/sbin/lsof" : undefined);

    if (!lsof || paths.length === 0) {
        return lsof ? [] : "unknown";
    }

    const child = Bun.spawnSync([lsof, "-Fpc", "--", ...paths], {
        env: env.getProcessEnv(),
        stdout: "pipe",
        stderr: "pipe",
    });

    if ((child.exitCode !== 0 && child.exitCode !== 1) || child.stderr.toString().trim()) {
        return "unknown";
    }

    const found: Array<{ pid: number; command: string }> = [];
    let current: { pid: number; command: string } | undefined;

    for (const line of child.stdout.toString().split("\n")) {
        if (line.startsWith("p")) {
            current = { pid: Number(line.slice(1)), command: "" };
            found.push(current);
        } else if (line.startsWith("c") && current) {
            current.command = line.slice(1);
        }
    }

    return found.filter((process) => Number.isSafeInteger(process.pid));
}

export function inspectNativeCache(
    toolsHome = env.tools.getHome(),
    processInspector: (paths: string[]) => NativeCacheRetirementReport["openProcesses"] = openProcesses
): NativeCacheRetirementReport {
    const target = retiredTarget(toolsHome);

    if (!existsSync(target)) {
        return {
            target,
            exists: false,
            bytes: 0,
            files: [],
            tables: [],
            schemaMatches: false,
            openProcesses: [],
        };
    }

    const targetStat = lstatSync(target);

    if (!targetStat.isDirectory() || targetStat.isSymbolicLink() || resolve(target) !== target) {
        throw new Error(`Refusing unexpected native-history target: ${target}`);
    }

    const files = readdirSync(target).sort();
    const paths = files.map((file) => join(target, file));
    const regularFiles = paths.every((path) => lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
    const bytes = paths.reduce((total, path) => total + (lstatSync(path).isFile() ? lstatSync(path).size : 0), 0);
    const databasePath = join(target, "index.db");
    const { tables, migrationIds } =
        regularFiles && existsSync(databasePath) ? databaseSchema(databasePath) : { tables: [], migrationIds: [] };
    const schemaMatches =
        regularFiles &&
        files.every((file) => EXPECTED_FILES.has(file)) &&
        EXPECTED_TABLES.length === tables.length &&
        EXPECTED_TABLES.every((table) => tables.includes(table)) &&
        migrationIds.length === EXPECTED_MIGRATIONS.length &&
        EXPECTED_MIGRATIONS.every((id) => migrationIds.includes(id));

    return { target, exists: true, bytes, files, tables, schemaMatches, openProcesses: processInspector(paths) };
}

export function retireNativeCache(options: {
    toolsHome?: string;
    confirmDelete: boolean;
    manifestDirectory?: string;
    processInspector?: (paths: string[]) => NativeCacheRetirementReport["openProcesses"];
    /** The irreversible primitive, injectable so tests can spy on it and make it throw. */
    remove?: (path: string) => void;
}): { report: NativeCacheRetirementReport; manifest?: string; deleted: boolean } {
    const report = inspectNativeCache(options.toolsHome, options.processInspector);

    if (!options.confirmDelete || !report.exists) {
        return { report, deleted: false };
    }

    if (!report.schemaMatches) {
        throw new Error("Refusing cleanup because the retired native-history schema or files do not match");
    }

    if (report.openProcesses === "unknown") {
        throw new Error("Refusing cleanup because open-file ownership could not be verified");
    }

    if (report.openProcesses.length > 0) {
        throw new Error(
            `Refusing cleanup because ${report.openProcesses.length} process(es) still have the cache open`
        );
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const manifestDirectory =
        options.manifestDirectory ??
        join(resolve(options.toolsHome ?? env.tools.getHome()), ".genesis-tools", "history-retirement");
    const manifestRoot = resolve(manifestDirectory);
    if (manifestRoot === report.target || manifestRoot.startsWith(`${report.target}/`)) {
        throw new Error("Retirement manifest must be outside the directory being deleted");
    }
    mkdirSync(manifestDirectory, { recursive: true, mode: 0o700 });
    // A receipt of what was removed, not a restore point. The cache it records is derived data.
    const manifest = join(manifestDirectory, `native-history-${stamp}.json`);
    const payload = { version: 1, retiredAt: new Date().toISOString(), report };
    const encoded = `${SafeJSON.stringify(
        {
            ...payload,
            sha256: createHash("sha256")
                .update(SafeJSON.stringify(payload, { strict: true }))
                .digest("hex"),
        },
        { strict: true, pretty: true }
    )}\n`;
    writeFileSync(manifest, encoded, { mode: 0o600 });

    const quarantine = join(dirname(report.target), `.native-history-retiring-${stamp}`);
    renameSync(report.target, quarantine);

    if (existsSync(report.target)) {
        throw new Error(`Retired cache path was recreated; original cache retained at ${quarantine}`);
    }

    const afterRename = (options.processInspector ?? openProcesses)(report.files.map((file) => join(quarantine, file)));
    if (afterRename === "unknown" || afterRename.length > 0) {
        if (!existsSync(report.target)) {
            renameSync(quarantine, report.target);
        }
        throw new Error("Cache became active during quarantine; deletion refused");
    }

    (options.remove ?? ((path: string) => rmSync(path, { recursive: true })))(quarantine);
    return { report, manifest, deleted: true };
}

if (import.meta.main) {
    const confirmDelete = process.argv.includes("--confirm-delete-native-history");
    const result = retireNativeCache({ confirmDelete });
    process.stdout.write(`${SafeJSON.stringify(result, { strict: true, pretty: true })}\n`);
}
