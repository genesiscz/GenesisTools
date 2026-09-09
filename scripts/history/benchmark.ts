import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { arch, loadavg, platform, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
    type BaselineMeasured,
    type BaselineOracle,
    type BaselineOracleManifest,
    type BaselineOracleRequest,
    createBaselineOracle,
} from "@genesiscz/utils/agent-sessions/testing/baseline-oracle";
import { generateHistoryCorpus, type HistoryCorpusManifest } from "@genesiscz/utils/agent-sessions/testing/corpus";
import { createFixtureWorld, type HistoryFixtureWorld } from "@genesiscz/utils/agent-sessions/testing/fixture-world";
import { SafeJSON } from "@genesiscz/utils/json";

export type BenchmarkOperation =
    | "metadata-list"
    | "summary-search"
    | "content-rare"
    | "content-common"
    | "content-absent";
export type BenchmarkMeasuredOperation = BenchmarkOperation | "initialize";
export type BenchmarkPhase =
    | "warm-initialize"
    | "warm-service"
    | "cold-initialize"
    | "cold-service"
    | "warm-cli"
    | "cold-cli";
export type BenchmarkCounter = number | "unavailable";

export interface BenchmarkCounters {
    sourceBytesRead: BenchmarkCounter;
    parsedRecords: BenchmarkCounter;
    candidates: BenchmarkCounter;
    metadataReads: BenchmarkCounter;
    sourceHydrations: BenchmarkCounter;
    transactions: BenchmarkCounter;
}

export interface BenchmarkServiceMetrics {
    wallMs: number;
    userCpuMs: number;
    systemCpuMs: number;
    peakRssBytes: number;
}

export interface BenchmarkInvocationResult {
    value: object | object[];
    counters?: Partial<Record<keyof BenchmarkCounters, number>>;
    metrics?: BenchmarkServiceMetrics;
}

export interface BenchmarkAdapter {
    execute(operation: BenchmarkOperation): Promise<BenchmarkInvocationResult>;
    initializationDetails?: Record<string, number>;
    close?(): Promise<void> | void;
}

export interface BenchmarkOpenContext {
    cachePath: string;
    cold: boolean;
    repetition: number;
}

export interface BenchmarkCommandContext extends BenchmarkOpenContext {
    operation: BenchmarkOperation;
    prewarm: boolean;
}

export interface BenchmarkCommand {
    argv: string[];
    cwd: string;
    env: Record<string, string>;
    stdin?: string | Uint8Array;
}

export interface BenchmarkProcessResult {
    exitStatus: number;
    userCpuMs: number;
    systemCpuMs: number;
    peakRssBytes: number;
    failure?: string;
}

export interface BenchmarkVariant {
    name: string;
    open(context: BenchmarkOpenContext): Promise<BenchmarkAdapter>;
    command?(context: BenchmarkCommandContext): BenchmarkCommand | Promise<BenchmarkCommand>;
    storagePaths?(): string[];
    manifest?(): object;
}

export interface BenchmarkMeasurement {
    variant: string;
    operation: BenchmarkMeasuredOperation;
    phase: BenchmarkPhase;
    repetition: number;
    wallMs: number;
    userCpuMs: number;
    systemCpuMs: number;
    peakRssBytes: number;
    exitStatus: number;
    failure?: string;
    counters: BenchmarkCounters;
    details?: Record<string, number>;
}

export interface BenchmarkSummary {
    variant: string;
    operation: BenchmarkMeasuredOperation;
    phase: BenchmarkPhase;
    samples: number;
    medianMs: number;
    p95Ms: number | "unavailable";
    minMs: number;
    maxMs: number;
    nonzeroExitStatuses: number[];
}

export interface BenchmarkParity {
    operation: BenchmarkOperation;
    baseline: string;
    variant: string;
    equalIds: boolean;
    equalStructure: boolean;
    equalValues: boolean;
    baselineHash: string;
    variantHash: string;
    baselineIds: string[];
    variantIds: string[];
    structuralMismatches: string[];
    valueMismatches: string[];
}

export interface SqliteStorageObject {
    name: string;
    kind: "table" | "index";
    bytes: number;
    pages: number;
}

export interface SqliteStorageFootprint {
    path: string;
    files: {
        main: number;
        wal: number;
        shm: number;
    };
    pageSize: number;
    pageCount: number;
    freePages: number;
    objects: SqliteStorageObject[] | "unavailable";
    unavailableReason?: string;
}

export interface BenchmarkPrewarmResult {
    variant: string;
    operation: BenchmarkOperation;
    exitStatus: number;
    failure?: string;
}

export interface BenchmarkReport {
    comparisonStatus: "compared" | "pending-no-candidate";
    prewarm: BenchmarkPrewarmResult[];
    parity: BenchmarkParity[];
    measurements: BenchmarkMeasurement[];
    summaries: BenchmarkSummary[];
}

export interface BenchmarkMatrixOptions {
    variants: BenchmarkVariant[];
    operations: BenchmarkOperation[];
    cacheRoot: string;
    warmRepetitions?: number;
    coldRepetitions?: number;
    includeCli?: boolean;
    runCommand?: (command: BenchmarkCommand) => Promise<BenchmarkProcessResult>;
    normalizePrefixes?: string[];
}

export interface BenchmarkCliConfig {
    root: string;
    output: string;
    sessionCount: number;
    recordCount: number;
    mainSessionCount: number;
    subagentSessionCount: number;
    seed: number;
    warmRepetitions: number;
    coldRepetitions: number;
    candidateModule?: string;
    includeCli?: false;
}

function parseIntegerFlag(flags: Map<string, string>, name: string, fallback?: number): number {
    const raw = flags.get(name);
    if (raw === undefined && fallback !== undefined) {
        return fallback;
    }
    if (raw === undefined) {
        throw new Error(`${name} is required`);
    }

    const value = Number(raw.replaceAll("_", ""));
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer`);
    }

    return value;
}

export function parseBenchmarkCliArgs(argv: string[]): BenchmarkCliConfig {
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

    const root = resolve(rootInput);
    const output = resolve(outputInput);
    const outputFromRoot = relative(root, output);
    if (outputFromRoot === ".." || outputFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new Error("--output must be inside --root");
    }

    const sessionCount = parseIntegerFlag(flags, "--sessions");
    const mainSessionCount = parseIntegerFlag(flags, "--main-sessions");
    const subagentSessionCount = parseIntegerFlag(flags, "--subagent-sessions");
    if (mainSessionCount + subagentSessionCount !== sessionCount) {
        throw new Error("--main-sessions plus --subagent-sessions must equal --sessions");
    }
    const includeCli = flags.get("--include-cli");
    if (includeCli !== undefined && includeCli !== "true" && includeCli !== "false") {
        throw new Error("--include-cli must be true or false");
    }

    return {
        root,
        output,
        sessionCount,
        recordCount: parseIntegerFlag(flags, "--records"),
        mainSessionCount,
        subagentSessionCount,
        seed: parseIntegerFlag(flags, "--seed", 73),
        warmRepetitions: parseIntegerFlag(flags, "--warm", 30),
        coldRepetitions: parseIntegerFlag(flags, "--cold", 5),
        candidateModule: flags.get("--candidate-module"),
        ...(includeCli === "false" ? { includeCli: false as const } : {}),
    };
}

const COUNTER_NAMES = [
    "sourceBytesRead",
    "parsedRecords",
    "candidates",
    "metadataReads",
    "sourceHydrations",
    "transactions",
] as const satisfies readonly (keyof BenchmarkCounters)[];

function normalizeCounters(input: BenchmarkInvocationResult["counters"]): BenchmarkCounters {
    return Object.fromEntries(COUNTER_NAMES.map((name) => [name, input?.[name] ?? "unavailable"])) as BenchmarkCounters;
}

function orderedIds(value: object | object[]): string[] {
    const ids: string[] = [];
    const visit = (candidate: object | object[]): void => {
        if (Array.isArray(candidate)) {
            for (const item of candidate) {
                visit(item);
            }
            return;
        }

        const record = candidate as Record<string, object | object[] | string>;
        const id = record.sessionId ?? record.id;
        if (typeof id === "string") {
            ids.push(id);
            return;
        }

        for (const nested of Object.values(record)) {
            if (typeof nested === "object" && nested !== null) {
                visit(nested);
            }
        }
    };
    visit(value);
    return ids;
}

function structureOf(value: object | object[]): string {
    if (Array.isArray(value)) {
        return `[${value.map(structureOf).join(",")}]`;
    }

    const record = value as Record<string, object | object[] | string | number | boolean | null>;
    return `{${Object.keys(record)
        .toSorted()
        .map((key) => {
            const nested = record[key];
            if (nested === null) {
                return `${key}:null`;
            }
            if (typeof nested === "object") {
                return `${key}:${structureOf(nested)}`;
            }
            return `${key}:${typeof nested}`;
        })
        .join(",")}}`;
}

function normalizeDto(value: unknown, prefixes: string[]): unknown {
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === "string") {
        return prefixes.reduce((normalized, prefix) => normalized.replaceAll(prefix, "<ROOT>"), value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => normalizeDto(item, prefixes));
    }
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.entries(value)
                .toSorted(([left], [right]) => left.localeCompare(right))
                .map(([key, nested]) => [key, normalizeDto(nested, prefixes)])
        );
    }

    return value;
}

function dtoHash(value: unknown): string {
    return createHash("sha256")
        .update(SafeJSON.stringify(value, { strict: true }))
        .digest("hex");
}

function valueMismatches(baseline: unknown, variant: unknown, path = "$", mismatches: string[] = []): string[] {
    if (Array.isArray(baseline) && Array.isArray(variant)) {
        if (baseline.length !== variant.length) {
            mismatches.push(`${path}: length differs`);
        }
        for (let index = 0; index < Math.min(baseline.length, variant.length); index += 1) {
            valueMismatches(baseline[index], variant[index], `${path}[${index}]`, mismatches);
        }
        return mismatches;
    }
    if (typeof baseline === "object" && baseline !== null && typeof variant === "object" && variant !== null) {
        const baselineRecord = baseline as Record<string, unknown>;
        const variantRecord = variant as Record<string, unknown>;
        const keys = new Set([...Object.keys(baselineRecord), ...Object.keys(variantRecord)]);
        for (const key of [...keys].toSorted()) {
            if (!(key in baselineRecord) || !(key in variantRecord)) {
                mismatches.push(`${path}.${key}: field presence differs`);
                continue;
            }
            valueMismatches(baselineRecord[key], variantRecord[key], `${path}.${key}`, mismatches);
        }
        return mismatches;
    }
    if (!Object.is(baseline, variant)) {
        mismatches.push(`${path}: value differs`);
    }
    return mismatches;
}

function compareStructure(baseline: object | object[], variant: object | object[]): string[] {
    return structureOf(baseline) === structureOf(variant) ? [] : ["$: public DTO structure differs"];
}

async function openMeasuredVariant(options: {
    variant: BenchmarkVariant;
    operation: BenchmarkMeasuredOperation;
    cachePath: string;
    cold: boolean;
    phase: "warm-initialize" | "cold-initialize";
    repetition: number;
}): Promise<{ adapter: BenchmarkAdapter; measurement: BenchmarkMeasurement }> {
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    const adapter = await options.variant.open({
        cachePath: options.cachePath,
        cold: options.cold,
        repetition: options.repetition,
    });
    const cpu = process.cpuUsage(cpuBefore);

    return {
        adapter,
        measurement: {
            variant: options.variant.name,
            operation: options.operation,
            phase: options.phase,
            repetition: options.repetition,
            wallMs: performance.now() - started,
            userCpuMs: cpu.user / 1_000,
            systemCpuMs: cpu.system / 1_000,
            peakRssBytes: process.resourceUsage().maxRSS,
            exitStatus: 0,
            counters: normalizeCounters(undefined),
            details: adapter.initializationDetails,
        },
    };
}

async function measureService(options: {
    adapter: BenchmarkAdapter;
    variant: string;
    operation: BenchmarkOperation;
    phase: "warm-service" | "cold-service";
    repetition: number;
}): Promise<BenchmarkMeasurement> {
    const cpuBefore = process.cpuUsage();
    const started = performance.now();
    let result: BenchmarkInvocationResult | undefined;
    let failure: string | undefined;
    try {
        result = await options.adapter.execute(options.operation);
    } catch (error) {
        failure = (error instanceof Error ? error.message : String(error)).replaceAll(/[\r\n]+/g, " ").slice(0, 500);
    }
    const wallMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuBefore);

    return {
        variant: options.variant,
        operation: options.operation,
        phase: options.phase,
        repetition: options.repetition,
        wallMs: result?.metrics?.wallMs ?? wallMs,
        userCpuMs: result?.metrics?.userCpuMs ?? cpu.user / 1_000,
        systemCpuMs: result?.metrics?.systemCpuMs ?? cpu.system / 1_000,
        peakRssBytes: result?.metrics?.peakRssBytes ?? process.resourceUsage().maxRSS,
        exitStatus: failure ? 1 : 0,
        failure,
        counters: normalizeCounters(result?.counters),
    };
}

async function defaultRunCommand(command: BenchmarkCommand): Promise<BenchmarkProcessResult> {
    const stdin = typeof command.stdin === "string" ? new TextEncoder().encode(command.stdin) : command.stdin;
    const processHandle = Bun.spawn(command.argv, {
        cwd: command.cwd,
        env: command.env,
        stdin: stdin ?? "ignore",
        stdout: "ignore",
        stderr: "pipe",
    });
    const [exitStatus, stderr] = await Promise.all([processHandle.exited, new Response(processHandle.stderr).text()]);
    const usage = processHandle.resourceUsage();

    return {
        exitStatus,
        userCpuMs: Number(usage?.cpuTime.user ?? 0) / 1_000,
        systemCpuMs: Number(usage?.cpuTime.system ?? 0) / 1_000,
        peakRssBytes: Number(usage?.maxRSS ?? 0),
        failure: exitStatus === 0 ? undefined : stderr.trim() || `command exited ${exitStatus}`,
    };
}

async function measureCli(options: {
    command: BenchmarkCommand;
    runCommand: (command: BenchmarkCommand) => Promise<BenchmarkProcessResult>;
    variant: string;
    operation: BenchmarkOperation;
    phase: "warm-cli" | "cold-cli";
    repetition: number;
}): Promise<BenchmarkMeasurement> {
    const started = performance.now();
    const result = await options.runCommand(options.command);

    return {
        variant: options.variant,
        operation: options.operation,
        phase: options.phase,
        repetition: options.repetition,
        wallMs: performance.now() - started,
        userCpuMs: result.userCpuMs,
        systemCpuMs: result.systemCpuMs,
        peakRssBytes: result.peakRssBytes,
        exitStatus: result.exitStatus,
        failure: result.failure,
        counters: normalizeCounters(undefined),
    };
}

async function commandFor(options: {
    variant: BenchmarkVariant;
    operation: BenchmarkOperation;
    cachePath: string;
    cold: boolean;
    repetition: number;
    prewarm: boolean;
}): Promise<BenchmarkCommand> {
    const command = await options.variant.command?.({
        operation: options.operation,
        cachePath: options.cachePath,
        cold: options.cold,
        repetition: options.repetition,
        prewarm: options.prewarm,
    });
    if (!command) {
        throw new Error(`CLI measurement requested but ${options.variant.name} has no command factory`);
    }

    return command;
}

function percentile(sorted: number[], fraction: number): number {
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function summarize(measurements: BenchmarkMeasurement[]): BenchmarkSummary[] {
    const groups = new Map<string, BenchmarkMeasurement[]>();
    for (const measurement of measurements) {
        const key = `${measurement.variant}\u0000${measurement.operation}\u0000${measurement.phase}`;
        const group = groups.get(key) ?? [];
        group.push(measurement);
        groups.set(key, group);
    }

    return [...groups.values()].map((group) => {
        const [first] = group;
        const sorted = group.map((measurement) => measurement.wallMs).toSorted((left, right) => left - right);

        return {
            variant: first.variant,
            operation: first.operation,
            phase: first.phase,
            samples: group.length,
            medianMs: percentile(sorted, 0.5),
            p95Ms:
                (first.phase === "warm-service" || first.phase === "warm-cli") && group.length >= 30
                    ? percentile(sorted, 0.95)
                    : "unavailable",
            minMs: sorted[0] ?? 0,
            maxMs: sorted.at(-1) ?? 0,
            nonzeroExitStatuses: group.map(({ exitStatus }) => exitStatus).filter((exitStatus) => exitStatus !== 0),
        };
    });
}

function fileBytes(path: string): number {
    return existsSync(path) ? statSync(path).size : 0;
}

export function inspectSqliteStorage(path: string, providedDatabase?: Database): SqliteStorageFootprint {
    if (!providedDatabase && !existsSync(path)) {
        return {
            path,
            files: { main: 0, wal: fileBytes(`${path}-wal`), shm: fileBytes(`${path}-shm`) },
            pageSize: 0,
            pageCount: 0,
            freePages: 0,
            objects: "unavailable",
            unavailableReason: "database file does not exist",
        };
    }

    const database = providedDatabase ?? new Database(path, { readonly: true });
    let objects: SqliteStorageObject[] | "unavailable" = "unavailable";
    let unavailableReason: string | undefined;
    try {
        objects = database
            .query<SqliteStorageObject, []>(`
            SELECT
                pages.name AS name,
                CASE WHEN schema.type = 'index' OR pages.name LIKE 'sqlite_autoindex_%' THEN 'index' ELSE 'table' END AS kind,
                SUM(pages.pgsize) AS bytes,
                COUNT(*) AS pages
            FROM dbstat AS pages
            LEFT JOIN sqlite_schema AS schema ON schema.name = pages.name
            GROUP BY pages.name, kind
            ORDER BY pages.name
        `)
            .all();
    } catch (error) {
        unavailableReason = error instanceof Error ? error.message : String(error);
    }

    const pageSize = database.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
    const pageCount = database.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
    const freePages =
        database.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;
    if (!providedDatabase) {
        database.close();
    }

    return {
        path,
        files: { main: fileBytes(path), wal: fileBytes(`${path}-wal`), shm: fileBytes(`${path}-shm`) },
        pageSize,
        pageCount,
        freePages,
        objects,
        unavailableReason,
    };
}

export async function runBenchmarkMatrix(options: BenchmarkMatrixOptions): Promise<BenchmarkReport> {
    if (options.variants.length === 0) {
        throw new Error("At least one benchmark variant is required");
    }

    const warmRepetitions = options.warmRepetitions ?? 30;
    const coldRepetitions = options.coldRepetitions ?? 5;
    const runCommand = options.runCommand ?? defaultRunCommand;
    const warmAdapters: Array<{ variant: BenchmarkVariant; adapter: BenchmarkAdapter }> = [];
    const measurements: BenchmarkMeasurement[] = [];
    try {
        for (const variant of options.variants) {
            const opened = await openMeasuredVariant({
                variant,
                operation: "initialize",
                cachePath: join(options.cacheRoot, "warm", variant.name),
                cold: false,
                phase: "warm-initialize",
                repetition: 0,
            });
            warmAdapters.push({ variant, adapter: opened.adapter });
            measurements.push(opened.measurement);
        }
    } catch (error) {
        await Promise.allSettled(warmAdapters.map(({ adapter }) => adapter.close?.()));
        throw error;
    }
    const parity: BenchmarkParity[] = [];
    const prewarm: BenchmarkPrewarmResult[] = [];

    try {
        for (const operation of options.operations) {
            const baselineResult = await warmAdapters[0].adapter.execute(operation);
            for (const current of warmAdapters.slice(1)) {
                const variantResult = await current.adapter.execute(operation);
                const prefixes = options.normalizePrefixes ?? [];
                const normalizedBaseline = normalizeDto(baselineResult.value, prefixes);
                const normalizedVariant = normalizeDto(variantResult.value, prefixes);
                const structuralMismatches = compareStructure(
                    normalizedBaseline as object | object[],
                    normalizedVariant as object | object[]
                );
                const baselineIds = orderedIds(normalizedBaseline as object | object[]);
                const variantIds = orderedIds(normalizedVariant as object | object[]);
                const mismatchedValues = valueMismatches(normalizedBaseline, normalizedVariant);
                parity.push({
                    operation,
                    baseline: warmAdapters[0].variant.name,
                    variant: current.variant.name,
                    equalIds:
                        baselineIds.length === variantIds.length &&
                        baselineIds.every((id, index) => id === variantIds[index]),
                    equalStructure: structuralMismatches.length === 0,
                    equalValues: mismatchedValues.length === 0,
                    baselineHash: dtoHash(normalizedBaseline),
                    variantHash: dtoHash(normalizedVariant),
                    baselineIds,
                    variantIds,
                    structuralMismatches,
                    valueMismatches: mismatchedValues,
                });
            }
        }

        if (options.includeCli) {
            for (const operation of options.operations) {
                for (const variant of options.variants) {
                    const cachePath = join(options.cacheRoot, "warm-cli", operation, variant.name);
                    const result = await runCommand(
                        await commandFor({
                            variant,
                            operation,
                            cachePath,
                            cold: false,
                            repetition: -1,
                            prewarm: true,
                        })
                    );
                    prewarm.push({
                        variant: variant.name,
                        operation,
                        exitStatus: result.exitStatus,
                        failure: result.failure,
                    });
                }
            }
        }

        for (let repetition = 0; repetition < warmRepetitions; repetition += 1) {
            for (let operationIndex = 0; operationIndex < options.operations.length; operationIndex += 1) {
                const operation = options.operations[operationIndex];
                for (let variantOffset = 0; variantOffset < warmAdapters.length; variantOffset += 1) {
                    const current = warmAdapters[(variantOffset + operationIndex + repetition) % warmAdapters.length];
                    measurements.push(
                        await measureService({
                            adapter: current.adapter,
                            variant: current.variant.name,
                            operation,
                            phase: "warm-service",
                            repetition,
                        })
                    );
                    if (options.includeCli) {
                        const cachePath = join(options.cacheRoot, "warm-cli", operation, current.variant.name);
                        measurements.push(
                            await measureCli({
                                command: await commandFor({
                                    variant: current.variant,
                                    operation,
                                    cachePath,
                                    cold: false,
                                    repetition,
                                    prewarm: false,
                                }),
                                runCommand,
                                variant: current.variant.name,
                                operation,
                                phase: "warm-cli",
                                repetition,
                            })
                        );
                    }
                }
            }
        }

        for (let repetition = 0; repetition < coldRepetitions; repetition += 1) {
            for (const operation of options.operations) {
                for (const variant of options.variants) {
                    const serviceCachePath = join(
                        options.cacheRoot,
                        "cold",
                        `${repetition}`,
                        operation,
                        "service",
                        variant.name
                    );
                    const opened = await openMeasuredVariant({
                        variant,
                        operation,
                        cachePath: serviceCachePath,
                        cold: true,
                        phase: "cold-initialize",
                        repetition,
                    });
                    measurements.push(opened.measurement);
                    try {
                        measurements.push(
                            await measureService({
                                adapter: opened.adapter,
                                variant: variant.name,
                                operation,
                                phase: "cold-service",
                                repetition,
                            })
                        );
                        if (options.includeCli) {
                            const cachePath = join(
                                options.cacheRoot,
                                "cold",
                                `${repetition}`,
                                operation,
                                "cli",
                                variant.name
                            );
                            measurements.push(
                                await measureCli({
                                    command: await commandFor({
                                        variant,
                                        operation,
                                        cachePath,
                                        cold: true,
                                        repetition,
                                        prewarm: false,
                                    }),
                                    runCommand,
                                    variant: variant.name,
                                    operation,
                                    phase: "cold-cli",
                                    repetition,
                                })
                            );
                        }
                    } finally {
                        await opened.adapter.close?.();
                    }
                }
            }
        }
    } finally {
        await Promise.all(warmAdapters.map(({ adapter }) => adapter.close?.()));
    }

    return {
        comparisonStatus: options.variants.length > 1 ? "compared" : "pending-no-candidate",
        prewarm,
        parity,
        measurements,
        summaries: summarize(measurements),
    };
}

function baselineRequest(operation: BenchmarkOperation, corpus: HistoryCorpusManifest): BaselineOracleRequest {
    switch (operation) {
        case "metadata-list":
            return { operation: "list", filters: { limit: Number.MAX_SAFE_INTEGER } };
        case "summary-search":
            return { operation: "summary", filters: { query: corpus.queries.common, limit: 20 } };
        case "content-rare":
            return { operation: "content", filters: { query: corpus.queries.rare, limit: 20 } };
        case "content-common":
            return { operation: "content", filters: { query: corpus.queries.common, limit: 20 } };
        case "content-absent":
            return { operation: "content", filters: { query: corpus.queries.absent, limit: 20 } };
    }
}

function baselineMetrics(measured: BaselineMeasured<object | object[]>): BenchmarkInvocationResult {
    return {
        value: measured.value,
        metrics: {
            wallMs: measured.measurement.elapsedMs,
            userCpuMs: measured.measurement.cpuUserMicros / 1_000,
            systemCpuMs: measured.measurement.cpuSystemMicros / 1_000,
            peakRssBytes: measured.measurement.peakRssBytes,
        },
    };
}

async function executeBaseline(
    oracle: BaselineOracle,
    operation: BenchmarkOperation,
    corpus: HistoryCorpusManifest
): Promise<BenchmarkInvocationResult> {
    switch (operation) {
        case "metadata-list":
            return baselineMetrics(await oracle.measureList({ limit: Number.MAX_SAFE_INTEGER }));
        case "summary-search":
            return baselineMetrics(await oracle.measureSearchSummaries({ query: corpus.queries.common, limit: 20 }));
        case "content-rare":
            return baselineMetrics(await oracle.measureSearchContent({ query: corpus.queries.rare, limit: 20 }));
        case "content-common":
            return baselineMetrics(await oracle.measureSearchContent({ query: corpus.queries.common, limit: 20 }));
        case "content-absent":
            return baselineMetrics(await oracle.measureSearchContent({ query: corpus.queries.absent, limit: 20 }));
    }
}

export function createBaselineBenchmarkVariant(options: {
    world: HistoryFixtureWorld;
    corpus: HistoryCorpusManifest;
}): BenchmarkVariant {
    const storagePaths = new Set<string>();
    let manifest: BaselineOracleManifest | undefined;
    let invocationOracle: BaselineOracle | undefined;

    return {
        name: "baseline",
        async open(context) {
            const oracle = await createBaselineOracle({ world: options.world, cacheHome: context.cachePath });
            invocationOracle = oracle;
            manifest = oracle.manifest;
            storagePaths.add(join(context.cachePath, ".genesis-tools", "claude-history", "index.db"));
            return {
                initializationDetails: oracle.startupMeasurement,
                execute: (operation) => executeBaseline(oracle, operation, options.corpus),
                close: () => oracle.close(),
            };
        },
        async command(context) {
            if (!invocationOracle) {
                throw new Error("Baseline command requested before the oracle was opened");
            }
            const namespace = createHash("sha256")
                .update(`${context.cachePath}:${context.operation}:${context.cold ? context.repetition : "warm"}`)
                .digest("hex")
                .slice(0, 24);
            const invocation = await invocationOracle.buildFreshProcessInvocation({
                request: baselineRequest(context.operation, options.corpus),
                cacheNamespace: namespace,
            });
            storagePaths.add(invocation.databasePath);
            return {
                argv: invocation.command,
                cwd: invocation.cwd,
                env: invocation.environment,
                stdin: invocation.stdin,
            };
        },
        storagePaths: () => [...storagePaths].toSorted(),
        manifest() {
            if (!manifest) {
                throw new Error("Baseline manifest requested before the oracle was opened");
            }
            return manifest;
        },
    };
}

export interface GeneratedBenchmarkArtifact {
    schemaVersion: 1;
    generatedAt: string;
    environment: {
        platform: string;
        release: string;
        architecture: string;
        bunVersion: string;
        sqliteVersion: string;
        loadAverage: number[];
        interrupted: boolean;
    };
    corpus: {
        version: number;
        seed: number;
        logical: HistoryCorpusManifest["logical"];
        providers: HistoryCorpusManifest["providers"];
        queries: HistoryCorpusManifest["queries"];
        sourceCount: number;
        totalBytes: number;
        sources: HistoryCorpusManifest["sources"];
    };
    matrix: BenchmarkReport;
    storage: Record<string, SqliteStorageFootprint[]>;
    variantManifests: Record<string, object | "unavailable">;
    exitStatus: number;
}

export interface GeneratedBenchmarkOptions {
    config: BenchmarkCliConfig;
    createVariants(context: { world: HistoryFixtureWorld; corpus: HistoryCorpusManifest }): Promise<BenchmarkVariant[]>;
    includeCli?: boolean;
}

function sqliteVersion(): string {
    const database = new Database(":memory:");
    try {
        return (
            database.query<{ version: string }, []>("SELECT sqlite_version() AS version").get()?.version ??
            "unavailable"
        );
    } finally {
        database.close();
    }
}

function assertGeneratedConfig(config: BenchmarkCliConfig): void {
    if (!isAbsolute(config.root)) {
        throw new Error("Benchmark root must be absolute");
    }
    const outputFromRoot = relative(resolve(config.root), resolve(config.output));
    if (outputFromRoot === ".." || outputFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        throw new Error("Benchmark output must be inside the benchmark root");
    }
    if (config.mainSessionCount + config.subagentSessionCount !== config.sessionCount) {
        throw new Error("Benchmark main/subagent distribution must equal session count");
    }
}

export async function runGeneratedHistoryBenchmark(
    options: GeneratedBenchmarkOptions
): Promise<GeneratedBenchmarkArtifact> {
    assertGeneratedConfig(options.config);
    await mkdir(options.config.root, { recursive: true });
    await mkdir(dirname(options.config.output), { recursive: true });
    const world = await createFixtureWorld({ baseDirectory: options.config.root });
    try {
        const corpus = await generateHistoryCorpus({
            root: world.root,
            seed: options.config.seed,
            sessionCount: options.config.sessionCount,
            recordCount: options.config.recordCount,
            distribution: {
                main: options.config.mainSessionCount,
                subagent: options.config.subagentSessionCount,
            },
            now: world.now,
        });
        const variants = await options.createVariants({ world, corpus });
        const matrix = await runBenchmarkMatrix({
            variants,
            operations: ["metadata-list", "summary-search", "content-rare", "content-common", "content-absent"],
            cacheRoot: join(world.root, "derived-cache"),
            warmRepetitions: options.config.warmRepetitions,
            coldRepetitions: options.config.coldRepetitions,
            includeCli: options.includeCli ?? true,
            normalizePrefixes: [world.root],
        });
        const storage = Object.fromEntries(
            variants.map((variant) => [
                variant.name,
                (variant.storagePaths?.() ?? []).map((path) => inspectSqliteStorage(path)),
            ])
        );
        const artifact: GeneratedBenchmarkArtifact = {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            environment: {
                platform: platform(),
                release: release(),
                architecture: arch(),
                bunVersion: Bun.version,
                sqliteVersion: sqliteVersion(),
                loadAverage: loadavg(),
                interrupted: false,
            },
            corpus: {
                version: corpus.version,
                seed: corpus.seed,
                logical: corpus.logical,
                providers: corpus.providers,
                queries: corpus.queries,
                sourceCount: corpus.sources.length,
                totalBytes: corpus.totalBytes,
                sources: corpus.sources,
            },
            matrix,
            storage,
            variantManifests: Object.fromEntries(
                variants.map((variant) => [variant.name, variant.manifest?.() ?? "unavailable"])
            ),
            exitStatus:
                matrix.prewarm.some((result) => result.exitStatus !== 0) ||
                matrix.measurements.some((measurement) => measurement.exitStatus !== 0)
                    ? 1
                    : matrix.parity.some(
                            (comparison) =>
                                !comparison.equalIds || !comparison.equalStructure || !comparison.equalValues
                        )
                      ? 2
                      : 0,
        };
        await Bun.write(options.config.output, `${SafeJSON.stringify(artifact, { strict: true, pretty: true })}\n`);
        return artifact;
    } finally {
        await world.dispose();
    }
}

export type BenchmarkVariantFactory = (context: {
    world: HistoryFixtureWorld;
    corpus: HistoryCorpusManifest;
}) => BenchmarkVariant | Promise<BenchmarkVariant>;

async function loadCandidateFactory(path: string): Promise<BenchmarkVariantFactory> {
    const modulePath = isAbsolute(path) ? path : resolve(path);
    const loaded = (await import(modulePath)) as Record<string, unknown>;
    if (typeof loaded.createBenchmarkVariant !== "function") {
        throw new Error(`Candidate module must export createBenchmarkVariant(context): ${modulePath}`);
    }

    return loaded.createBenchmarkVariant as BenchmarkVariantFactory;
}

export async function runBenchmarkCli(argv: string[]): Promise<GeneratedBenchmarkArtifact> {
    const config = parseBenchmarkCliArgs(argv);
    const candidateFactory = config.candidateModule ? await loadCandidateFactory(config.candidateModule) : undefined;
    return runGeneratedHistoryBenchmark({
        config,
        async createVariants(context) {
            const variants = [createBaselineBenchmarkVariant(context)];
            if (candidateFactory) {
                variants.push(await candidateFactory(context));
            }
            return variants;
        },
        includeCli: config.includeCli !== false,
    });
}

if (import.meta.main) {
    try {
        const artifact = await runBenchmarkCli(process.argv.slice(2));
        process.stdout.write(
            `${artifact.matrix.comparisonStatus}: ${artifact.exitStatus === 0 ? "complete" : "failed"}\n`
        );
        process.stdout.write(`artifact: ${parseBenchmarkCliArgs(process.argv.slice(2)).output}\n`);
        process.exitCode = artifact.exitStatus;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`history benchmark failed: ${message.replaceAll(/[\r\n]+/g, " ").slice(0, 500)}\n`);
        process.exitCode = 1;
    }
}
