#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionMetadataRecord } from "../../src/utils/agent-sessions/cache-types";
import { historySourceKey } from "../../src/utils/agent-sessions/identity";
import { initializeCompactHistorySchema } from "../../src/utils/agent-sessions/migrations";
import { readClaudeMetadata } from "../../src/utils/agent-sessions/readers/claude";
import { HistoryRepository } from "../../src/utils/agent-sessions/repository";
import { BASELINE_REVISION, createBaselineOracle } from "../../src/utils/agent-sessions/testing/baseline-oracle";
import { generateHistoryCorpus, type HistoryCorpusManifest } from "../../src/utils/agent-sessions/testing/corpus";
import {
    createFixtureWorld,
    FIXED_HISTORY_NOW,
    type HistoryFixtureWorld,
} from "../../src/utils/agent-sessions/testing/fixture-world";
import type { HistoryMetadataRecord, NativeSessionSource } from "../../src/utils/agent-sessions/types";
import { SafeJSON } from "../../src/utils/json";
import { inspectSqliteStorage, type SqliteStorageFootprint, type SqliteStorageObject } from "./benchmark";

const PROVIDER_ID = "anthropic-sub";
const SEED = 20_260_907;
const RECORDS_PER_SESSION = 50;
const PARSER_VERSION = "2";
const TOOL_BODY_MARKER = "TOOL_BODY_PROBE_SECRET";
const TOOL_BODY_UNIT = `${TOOL_BODY_MARKER}${"x".repeat(64 * 1024)}`;

const SOURCE_CODE_FILES = {
    migrations: resolve(import.meta.dir, "../../src/utils/agent-sessions/migrations.ts"),
    repository: resolve(import.meta.dir, "../../src/utils/agent-sessions/repository.ts"),
} as const;

export interface SchemaBenchmarkConfig {
    root: string;
    output: string;
    sessions: number;
}

interface StorageSnapshot {
    files: { main: number; wal: number; shm: number };
    pageSize: number;
    pageCount: number;
    freePages: number;
    metadataBytes: number;
    totalDerivedBytes: number;
    objects: SqliteStorageObject[] | "unavailable";
}

interface StoreResult<Metadata> {
    buildMs: number;
    rows: { sessionMetadata: number; fileIndex: number };
    metadata: Metadata[];
    beforeCheckpoint: StorageSnapshot;
    afterCheckpoint: StorageSnapshot;
    sessionMetadataColumns: string[];
}

interface PreparedMetadata {
    metadata: HistoryMetadataRecord;
    revision: string;
}

export interface SchemaBenchmarkReport {
    version: 1;
    prototypeOnly: true;
    config: {
        sessions: number;
        records: number;
        main: number;
        subagent: number;
        seed: number;
    };
    corpus: {
        claudeSources: number;
        sourceBytes: number;
        sourceHash: string;
    };
    timings: {
        metadataParseMs: number;
        legacyBuildMs: number;
        compactBuildMs: number;
    };
    rows: {
        legacy: StoreResult<SessionMetadataRecord>["rows"];
        compact: StoreResult<ReturnType<HistoryRepository["listMetadata"]>[number]>["rows"];
    };
    storage: {
        legacy: Pick<StoreResult<SessionMetadataRecord>, "beforeCheckpoint" | "afterCheckpoint">;
        compact: Pick<
            StoreResult<ReturnType<HistoryRepository["listMetadata"]>[number]>,
            "beforeCheckpoint" | "afterCheckpoint"
        >;
    };
    ratios: {
        metadataOnlyCompactToLegacy: number;
        totalDerivedCompactToLegacy: number;
    };
    parity: {
        fileIdentitiesEqual: boolean;
        ordinaryMetadataEqual: boolean;
        fileIdentityCount: number;
        fileIdentityHash: string;
        ordinaryMetadataHash: string;
        nativePublicIdDifferenceCount: number;
        nativePublicIdDifferenceHash: string;
    };
    schema: {
        baselineRevision: typeof BASELINE_REVISION;
        legacy: { sourceKey: boolean; provider: boolean };
        candidate: { sourceKey: boolean; provider: boolean };
    };
    mutation: {
        bodyScale: 100;
        smallBodyBytes: number;
        largeBodyBytes: number;
        metadataEqual: boolean;
        metadataHash: string;
        smallCompactBytes: number;
        largeCompactBytes: number;
        growthBytes: number;
        allowedPageEffectBytes: number;
        noBodyCopy: boolean;
    };
    sourceCode: {
        before: Record<string, string>;
        after: Record<string, string>;
        changedDuringRun: string[];
    };
}

function hashValue(value: unknown): string {
    return createHash("sha256")
        .update(SafeJSON.stringify(value, { strict: true }))
        .digest("hex");
}

async function sourceCodeHashes(): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    for (const [name, path] of Object.entries(SOURCE_CODE_FILES)) {
        hashes[name] = createHash("sha256")
            .update(await readFile(path))
            .digest("hex");
    }
    return hashes;
}

function assertOutputInsideRoot(root: string, output: string): void {
    const fromRoot = relative(root, output);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
        throw new Error("--output must be inside --root");
    }
}

export function parseSchemaBenchmarkArgs(argv: string[]): SchemaBenchmarkConfig {
    const flags = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 2) {
        const name = argv[index];
        const value = argv[index + 1];
        if (!name?.startsWith("--") || value === undefined) {
            throw new Error(`Expected --flag value at argument ${index + 1}`);
        }
        flags.set(name, value);
    }

    const rootInput = flags.get("--root");
    if (!rootInput) {
        throw new Error("--root is required");
    }
    if (!isAbsolute(rootInput)) {
        throw new Error("--root must be absolute");
    }

    const outputInput = flags.get("--output");
    if (!outputInput) {
        throw new Error("--output is required");
    }
    if (!isAbsolute(outputInput)) {
        throw new Error("--output must be absolute");
    }

    const sessionsInput = flags.get("--sessions");
    if (!sessionsInput) {
        throw new Error("--sessions is required");
    }
    const sessions = Number(sessionsInput.replaceAll("_", ""));
    if (!Number.isSafeInteger(sessions) || sessions <= 0) {
        throw new Error("--sessions must be a positive safe integer");
    }

    const root = resolve(rootInput);
    const output = resolve(outputInput);
    assertOutputInsideRoot(root, output);
    return { root, output, sessions };
}

function distribution(sessions: number): { main: number; subagent: number } {
    if (sessions === 1_000) {
        return { main: 132, subagent: 868 };
    }
    if (sessions === 12_000) {
        return { main: 1_590, subagent: 10_410 };
    }
    const main = Math.min(sessions, Math.max(1, Math.round(sessions * 0.1325)));
    return { main, subagent: sessions - main };
}

function storageSnapshot(path: string, database: Database): StorageSnapshot {
    const footprint: SqliteStorageFootprint = inspectSqliteStorage(path, database);
    const objects = footprint.objects;
    const metadataBytes =
        objects === "unavailable"
            ? 0
            : objects
                  .filter((object) => object.name === "session_metadata" || object.name.includes("session_metadata"))
                  .reduce((total, object) => total + object.bytes, 0);
    return {
        files: footprint.files,
        pageSize: footprint.pageSize,
        pageCount: footprint.pageCount,
        freePages: footprint.freePages,
        metadataBytes,
        totalDerivedBytes: footprint.files.main + footprint.files.wal + footprint.files.shm,
        objects,
    };
}

function checkpoint(database: Database): void {
    database.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
}

function sessionMetadataColumns(database: Database): string[] {
    return database
        .query<{ name: string }, []>("PRAGMA table_info(session_metadata)")
        .all()
        .map((column) => column.name);
}

async function buildLegacy(options: {
    world: HistoryFixtureWorld;
    directory: string;
    records: PreparedMetadata[];
}): Promise<StoreResult<SessionMetadataRecord>> {
    await mkdir(options.directory, { recursive: true });
    const oracle = await createBaselineOracle({ world: options.world });
    const path = join(options.directory, "index.db");
    try {
        const result = await oracle.buildMetadataStore({
            directory: options.directory,
            records: options.records.map((record) => record.metadata),
        });
        const database = new Database(path);
        try {
            const rows = {
                sessionMetadata:
                    database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_metadata").get()
                        ?.count ?? 0,
                fileIndex:
                    database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM file_index").get()?.count ?? 0,
            };
            const beforeCheckpoint = storageSnapshot(path, database);
            checkpoint(database);
            const afterCheckpoint = storageSnapshot(path, database);
            return {
                buildMs: result.buildMs,
                rows,
                metadata: result.metadata,
                beforeCheckpoint,
                afterCheckpoint,
                sessionMetadataColumns: sessionMetadataColumns(database),
            };
        } finally {
            database.close();
        }
    } finally {
        await oracle.close();
    }
}

async function buildCompact(options: {
    path: string;
    records: PreparedMetadata[];
}): Promise<StoreResult<ReturnType<HistoryRepository["listMetadata"]>[number]>> {
    await mkdir(dirname(options.path), { recursive: true });
    const started = performance.now();
    const database = new Database(options.path, { create: true });
    try {
        database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
        initializeCompactHistorySchema(database);
        const repository = new HistoryRepository(database);
        for (const record of options.records) {
            const replaced = repository.replaceMetadata({
                metadata: record.metadata,
                revision: record.revision,
                parserVersion: PARSER_VERSION,
                generation: 1,
                expected: null,
            });
            if (!replaced) {
                throw new Error("Compact metadata insert lost an optimistic-concurrency race");
            }
        }
        const buildMs = performance.now() - started;
        const metadata = repository.listMetadata({ providerId: PROVIDER_ID });
        const rows = {
            sessionMetadata:
                database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM session_metadata").get()?.count ??
                0,
            fileIndex:
                database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM file_index").get()?.count ?? 0,
        };
        const beforeCheckpoint = storageSnapshot(options.path, database);
        checkpoint(database);
        const afterCheckpoint = storageSnapshot(options.path, database);
        return {
            buildMs,
            rows,
            metadata,
            beforeCheckpoint,
            afterCheckpoint,
            sessionMetadataColumns: sessionMetadataColumns(database),
        };
    } finally {
        database.close();
    }
}

async function prepareMetadata(options: {
    world: HistoryFixtureWorld;
    corpus: HistoryCorpusManifest;
}): Promise<PreparedMetadata[]> {
    const root = realpathSync(options.world.sources.claude);
    const sourceHome = realpathSync(dirname(root));
    const revisions = new Map(
        options.corpus.sources
            .filter((source) => source.provider === "claude")
            .map((source) => [source.relativePath, source.sha256])
    );
    const prepared: PreparedMetadata[] = [];
    for (const source of options.corpus.sources.filter(
        (candidate) => candidate.provider === "claude" && candidate.relativePath.endsWith(".jsonl")
    )) {
        const filePath = realpathSync(join(options.world.root, source.relativePath));
        const nativeSource: NativeSessionSource<"claude"> = {
            kind: "claude",
            root,
            sourceHome,
            filePath,
            dataPaths: [filePath],
            metadataPaths: [],
        };
        const read = await readClaudeMetadata(nativeSource);
        if (!read.metadata || read.issues.length > 0 || !read.complete) {
            throw new Error("Generated Claude metadata source could not be read completely");
        }
        const metadata: HistoryMetadataRecord = {
            ...read.metadata,
            providerId: PROVIDER_ID,
            sourceKey: historySourceKey({
                providerId: PROVIDER_ID,
                sourceHome,
                nativeId: read.metadata.nativeId,
            }),
        };
        prepared.push({ metadata, revision: revisions.get(source.relativePath) ?? hashValue(source.relativePath) });
    }
    return prepared;
}

function ordinaryMetadata(record: SessionMetadataRecord): object {
    return {
        filePath: record.filePath,
        sessionId: record.sessionId,
        customTitle: record.customTitle,
        summary: record.summary,
        firstPrompt: record.firstPrompt,
        gitBranch: record.gitBranch,
        project: record.project,
        cwd: record.cwd,
        mtime: record.mtime,
        firstTimestamp: record.firstTimestamp,
        isSubagent: record.isSubagent,
        allUserText: record.allUserText,
    };
}

function sortedOrdinary(records: SessionMetadataRecord[]): object[] {
    return records.map(ordinaryMetadata).toSorted((left, right) => {
        const leftPath = (left as { filePath: string }).filePath;
        const rightPath = (right as { filePath: string }).filePath;
        return leftPath.localeCompare(rightPath);
    });
}

function parity(options: {
    prepared: PreparedMetadata[];
    legacy: SessionMetadataRecord[];
    compact: Array<ReturnType<HistoryRepository["listMetadata"]>[number]>;
}): SchemaBenchmarkReport["parity"] {
    const legacyPaths = options.legacy.map((record) => record.filePath).toSorted();
    const compactPaths = options.compact.map((record) => record.filePath).toSorted();
    const fileIdentitiesEqual = SafeJSON.stringify(legacyPaths) === SafeJSON.stringify(compactPaths);
    const legacyOrdinary = sortedOrdinary(options.legacy);
    const compactOrdinary = sortedOrdinary(options.compact);
    const ordinaryMetadataEqual = SafeJSON.stringify(legacyOrdinary) === SafeJSON.stringify(compactOrdinary);
    if (!fileIdentitiesEqual || !ordinaryMetadataEqual) {
        throw new Error("Legacy and compact metadata stores diverged");
    }

    const differences = options.prepared
        .map(({ metadata }) => [metadata.nativeId, metadata.sessionId] as const)
        .filter(([nativeId, sessionId]) => nativeId !== sessionId)
        .toSorted(([left], [right]) => left.localeCompare(right));
    return {
        fileIdentitiesEqual,
        ordinaryMetadataEqual,
        fileIdentityCount: legacyPaths.length,
        fileIdentityHash: hashValue(legacyPaths),
        ordinaryMetadataHash: hashValue(legacyOrdinary),
        nativePublicIdDifferenceCount: differences.length,
        nativePublicIdDifferenceHash: hashValue(differences),
    };
}

function mutationContent(options: { sessionId: string; bodyScale: number }): string {
    const records = [
        {
            type: "user",
            sessionId: options.sessionId,
            cwd: "/fixtures/mutation",
            gitBranch: "fixture-main",
            timestamp: "2026-08-15T10:00:00.000Z",
            message: { role: "user", content: "metadata mutation prompt" },
        },
        { type: "custom-title", sessionId: options.sessionId, customTitle: "Mutation fixture" },
        {
            type: "user",
            sessionId: options.sessionId,
            timestamp: "2026-08-15T10:01:00.000Z",
            message: {
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "fixture-tool",
                        content: TOOL_BODY_UNIT.repeat(options.bodyScale),
                    },
                ],
            },
        },
    ];
    return `${records.map((record) => SafeJSON.stringify(record, { strict: true })).join("\n")}\n`;
}

async function readMutationMetadata(options: {
    source: NativeSessionSource<"claude">;
    content: string;
}): Promise<PreparedMetadata> {
    await writeFile(options.source.filePath, options.content, "utf8");
    const timestamp = new Date(FIXED_HISTORY_NOW);
    await utimes(options.source.filePath, timestamp, timestamp);
    const read = await readClaudeMetadata(options.source);
    if (!read.metadata || read.issues.length > 0 || !read.complete) {
        throw new Error("Tool-output mutation source could not be read completely");
    }
    const metadata: HistoryMetadataRecord = {
        ...read.metadata,
        providerId: PROVIDER_ID,
        sourceKey: historySourceKey({
            providerId: PROVIDER_ID,
            sourceHome: options.source.sourceHome,
            nativeId: read.metadata.nativeId,
        }),
    };
    return { metadata, revision: createHash("sha256").update(options.content).digest("hex") };
}

async function databaseContains(path: string, needle: string): Promise<boolean> {
    const bytes = await Bun.file(path).bytes();
    return Buffer.from(bytes).indexOf(Buffer.from(needle)) >= 0;
}

async function mutationProbe(options: {
    world: HistoryFixtureWorld;
    directory: string;
}): Promise<SchemaBenchmarkReport["mutation"]> {
    const root = realpathSync(options.world.sources.claude);
    const sourceHome = realpathSync(dirname(root));
    const project = join(root, "-fixtures-mutation");
    await mkdir(project, { recursive: true });
    const sessionId = "11111111-2222-4333-8444-555555555555";
    const filePath = join(project, `${sessionId}.jsonl`);
    await writeFile(filePath, "", "utf8");
    const canonicalFile = realpathSync(filePath);
    const source: NativeSessionSource<"claude"> = {
        kind: "claude",
        root,
        sourceHome,
        filePath: canonicalFile,
        dataPaths: [canonicalFile],
        metadataPaths: [],
    };
    const smallContent = mutationContent({ sessionId, bodyScale: 1 });
    const largeContent = mutationContent({ sessionId, bodyScale: 100 });
    const small = await readMutationMetadata({ source, content: smallContent });
    const large = await readMutationMetadata({ source, content: largeContent });
    const metadataHash = hashValue(small.metadata);
    const metadataEqual = metadataHash === hashValue(large.metadata);
    if (!metadataEqual) {
        throw new Error("Tool-output body changed compact metadata projection");
    }

    const smallPath = join(options.directory, "small.db");
    const largePath = join(options.directory, "large.db");
    const smallStore = await buildCompact({ path: smallPath, records: [small] });
    const largeStore = await buildCompact({ path: largePath, records: [large] });
    const smallCompactBytes = smallStore.afterCheckpoint.totalDerivedBytes;
    const largeCompactBytes = largeStore.afterCheckpoint.totalDerivedBytes;
    const growthBytes = largeCompactBytes - smallCompactBytes;
    const allowedPageEffectBytes =
        Math.max(smallStore.afterCheckpoint.pageSize, largeStore.afterCheckpoint.pageSize) * 2;
    const noBodyCopy =
        !(await databaseContains(smallPath, TOOL_BODY_MARKER)) &&
        !(await databaseContains(largePath, TOOL_BODY_MARKER));
    if (!noBodyCopy || Math.abs(growthBytes) > allowedPageEffectBytes) {
        throw new Error("Compact metadata storage grew with source tool-output body");
    }

    return {
        bodyScale: 100,
        smallBodyBytes: Buffer.byteLength(smallContent),
        largeBodyBytes: Buffer.byteLength(largeContent),
        metadataEqual,
        metadataHash,
        smallCompactBytes,
        largeCompactBytes,
        growthBytes,
        allowedPageEffectBytes,
        noBodyCopy,
    };
}

function ratio(numerator: number, denominator: number): number {
    if (denominator <= 0) {
        throw new Error("Legacy schema probe produced an empty size denominator");
    }
    return numerator / denominator;
}

export async function runSchemaBenchmark(config: SchemaBenchmarkConfig): Promise<SchemaBenchmarkReport> {
    const root = resolve(config.root);
    const output = resolve(config.output);
    if (!isAbsolute(root) || !isAbsolute(output) || !Number.isSafeInteger(config.sessions) || config.sessions <= 0) {
        throw new Error("Schema benchmark requires absolute root/output and a positive session count");
    }
    assertOutputInsideRoot(root, output);
    await mkdir(root, { recursive: true });
    const sourceBefore = await sourceCodeHashes();
    const world = await createFixtureWorld({ baseDirectory: root });
    try {
        const mix = distribution(config.sessions);
        const corpus = await generateHistoryCorpus({
            root: world.root,
            seed: SEED,
            sessionCount: config.sessions,
            recordCount: config.sessions * RECORDS_PER_SESSION,
            distribution: mix,
        });
        const parseStarted = performance.now();
        const prepared = await prepareMetadata({ world, corpus });
        const metadataParseMs = performance.now() - parseStarted;
        if (prepared.length !== config.sessions) {
            throw new Error("Claude metadata count differs from generated session count");
        }

        const legacy = await buildLegacy({
            world,
            directory: join(world.root, "derived", "legacy"),
            records: prepared,
        });
        const compact = await buildCompact({
            path: join(world.root, "derived", "compact", "index.db"),
            records: prepared,
        });
        const parityResult = parity({
            prepared,
            legacy: legacy.metadata,
            compact: compact.metadata,
        });
        const mutation = await mutationProbe({
            world,
            directory: join(world.root, "derived", "mutation"),
        });
        const claudeSources = corpus.sources.filter((source) => source.provider === "claude");
        const sourceAfter = await sourceCodeHashes();
        const changedDuringRun = Object.keys(sourceBefore).filter((name) => sourceBefore[name] !== sourceAfter[name]);
        if (changedDuringRun.length > 0) {
            console.warn(`Schema source changed during probe: ${changedDuringRun.join(", ")}`);
        }

        const report: SchemaBenchmarkReport = {
            version: 1,
            prototypeOnly: true,
            config: {
                sessions: config.sessions,
                records: config.sessions * RECORDS_PER_SESSION,
                main: mix.main,
                subagent: mix.subagent,
                seed: SEED,
            },
            corpus: {
                claudeSources: claudeSources.length,
                sourceBytes: claudeSources.reduce((total, source) => total + source.bytes, 0),
                sourceHash: hashValue(claudeSources.map((source) => source.sha256).toSorted()),
            },
            timings: {
                metadataParseMs,
                legacyBuildMs: legacy.buildMs,
                compactBuildMs: compact.buildMs,
            },
            rows: {
                legacy: legacy.rows,
                compact: compact.rows,
            },
            storage: {
                legacy: {
                    beforeCheckpoint: legacy.beforeCheckpoint,
                    afterCheckpoint: legacy.afterCheckpoint,
                },
                compact: {
                    beforeCheckpoint: compact.beforeCheckpoint,
                    afterCheckpoint: compact.afterCheckpoint,
                },
            },
            ratios: {
                metadataOnlyCompactToLegacy: ratio(
                    compact.afterCheckpoint.metadataBytes,
                    legacy.afterCheckpoint.metadataBytes
                ),
                totalDerivedCompactToLegacy: ratio(
                    compact.afterCheckpoint.totalDerivedBytes,
                    legacy.afterCheckpoint.totalDerivedBytes
                ),
            },
            parity: parityResult,
            schema: {
                baselineRevision: BASELINE_REVISION,
                legacy: {
                    sourceKey: legacy.sessionMetadataColumns.includes("source_key"),
                    provider: legacy.sessionMetadataColumns.includes("provider"),
                },
                candidate: {
                    sourceKey: compact.sessionMetadataColumns.includes("source_key"),
                    provider: compact.sessionMetadataColumns.includes("provider"),
                },
            },
            mutation,
            sourceCode: {
                before: sourceBefore,
                after: sourceAfter,
                changedDuringRun,
            },
        };
        await mkdir(dirname(output), { recursive: true });
        await Bun.write(output, `${SafeJSON.stringify(report, { strict: true })}\n`);
        return report;
    } finally {
        await world.dispose();
    }
}

async function main(): Promise<void> {
    const config = parseSchemaBenchmarkArgs(process.argv.slice(2));
    const report = await runSchemaBenchmark(config);
    console.log(
        SafeJSON.stringify({
            sessions: report.config.sessions,
            records: report.config.records,
            metadataRatio: report.ratios.metadataOnlyCompactToLegacy,
            totalDerivedRatio: report.ratios.totalDerivedCompactToLegacy,
            schemaChanged: report.sourceCode.changedDuringRun.length > 0,
        })
    );
}

if (import.meta.main) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
