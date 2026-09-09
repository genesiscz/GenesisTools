import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, symlink, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionMetadataRecord } from "@genesiscz/utils/agent-sessions/cache-types";
import type { ConversationMessage } from "@genesiscz/utils/claude/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { HistoryFixtureWorld } from "./fixture-world";

export const BASELINE_REVISION = "010697b869a34af0e79363b5c74bfc4946f74b96";
export const BASELINE_RESULT_PREFIX = "__BASELINE_ORACLE_RESULT__";

/** Repository root of this checkout; the pinned baseline is archived out of it. */
function defaultRepositoryRoot(): string {
    return resolve(join(dirname(fileURLToPath(import.meta.url)), "../../../.."));
}

let revisionAvailable: boolean | undefined;

/**
 * True when this clone actually contains {@link BASELINE_REVISION}.
 *
 * CI checks out with `fetch-depth: 1`, so the pinned commit is absent there and every
 * frozen-oracle comparison fails with `not a tree object` rather than on a real
 * regression. Suites that compare against the oracle gate on this instead.
 */
export function baselineRevisionAvailable(): boolean {
    if (revisionAvailable === undefined) {
        let reason = "";
        try {
            const probe = Bun.spawnSync(["git", "cat-file", "-e", `${BASELINE_REVISION}^{commit}`], {
                cwd: defaultRepositoryRoot(),
                stdout: "ignore",
                stderr: "pipe",
            });
            revisionAvailable = probe.exitCode === 0;
            reason = probe.stderr.toString().trim();
        } catch (error) {
            // No git at all (an extracted archive, a slim container): degrade to a skip
            // rather than failing every suite that imports this at module scope.
            revisionAvailable = false;
            reason = error instanceof Error ? error.message : String(error);
        }

        if (!revisionAvailable) {
            logger.warn(
                { revision: BASELINE_REVISION, reason },
                "Frozen history baseline is missing from this clone; oracle parity suites will skip"
            );
        }
    }

    return revisionAvailable;
}

const BASELINE_READY_PREFIX = "__BASELINE_ORACLE_READY__";
const ARCHIVE_PATHS = ["package.json", "bun.lock", "tsconfig.json", "src/claude/lib/history", "src/utils"] as const;
const HASHED_PATHS = [
    "src/claude/lib/history/search.ts",
    "src/claude/lib/history/types.ts",
    "package.json",
    "bun.lock",
] as const;

export interface BaselineSearchFilters {
    query?: string;
    exact?: boolean;
    regex?: boolean;
    file?: string;
    files?: string[];
    tool?: string;
    project?: string;
    since?: Date;
    until?: Date;
    agentsOnly?: boolean;
    excludeAgents?: boolean;
    excludeThinking?: boolean;
    limit?: number;
    context?: number;
    excludeCurrentSession?: string;
    conversationDate?: Date;
    conversationDateUntil?: Date;
    commitHash?: string;
    commitMessage?: string;
    sortByRelevance?: boolean;
}

export interface BaselineSearchResult {
    filePath: string;
    project: string;
    sessionId: string;
    timestamp: Date;
    summary?: string;
    customTitle?: string;
    gitBranch?: string;
    matchedMessages: ConversationMessage[];
    contextMessages?: ConversationMessage[];
    isSubagent: boolean;
    relevanceScore?: number;
    commitHashes?: string[];
    userMessageCount?: number;
    assistantMessageCount?: number;
}

export interface BaselineConversationStats {
    totalConversations: number;
    totalMessages: number;
    projectCounts: Record<string, number>;
    toolCounts: Record<string, number>;
    dailyActivity: Record<string, number>;
    hourlyActivity: Record<string, number>;
    subagentCount: number;
    tokenUsage: {
        inputTokens: number;
        outputTokens: number;
        cacheCreateTokens: number;
        cacheReadTokens: number;
    };
    dailyTokens: Record<string, BaselineConversationStats["tokenUsage"]>;
    modelCounts: Record<string, number>;
    branchCounts: Record<string, number>;
    conversationLengths: number[];
}

export interface BaselineOperationMeasurement {
    elapsedMs: number;
    cpuUserMicros: number;
    cpuSystemMicros: number;
    peakRssBytes: number;
    driverPid: number;
}

export interface BaselineMeasured<T> {
    value: T;
    measurement: BaselineOperationMeasurement;
}

export interface BaselineMetadataStoreResult {
    buildMs: number;
    metadata: SessionMetadataRecord[];
}

export interface BaselineStartupMeasurement {
    materializeMs: number;
    driverStartMs: number;
    schemaInitMs: number;
}

export interface BaselineOracleManifest {
    revision: typeof BASELINE_REVISION;
    archiveSha256: string;
    runtimeBundleSha256: string;
    runtimeDependencyHash: string;
    runtimeDependencies: Record<string, string>;
    sourceHashes: Record<string, string>;
    dependencyManifestHashes: {
        packageJson: string;
        bunLock: string;
    };
}

export type BaselineOracleRequest =
    | { operation: "list"; filters: BaselineSearchFilters }
    | { operation: "summary"; filters: BaselineSearchFilters }
    | { operation: "content"; filters: BaselineSearchFilters }
    | { operation: "detail"; sessionId: string }
    | { operation: "statistics"; forceRefresh: boolean; from?: string; to?: string }
    | { operation: "metadata-store"; directory: string; records: SessionMetadataRecord[] }
    | { operation: "probe-failure"; message: string };

export interface BaselineFreshProcessInvocation {
    command: string[];
    cwd: string;
    environment: Record<string, string>;
    stdin: string;
    resultPrefix: typeof BASELINE_RESULT_PREFIX;
    databasePath: string;
}

export interface BaselineOracle {
    databasePath: string;
    manifest: BaselineOracleManifest;
    startupMeasurement: BaselineStartupMeasurement;
    list(filters?: BaselineSearchFilters): Promise<BaselineSearchResult[]>;
    searchSummaries(filters: BaselineSearchFilters): Promise<BaselineSearchResult[]>;
    searchContent(filters: BaselineSearchFilters): Promise<BaselineSearchResult[]>;
    getSelectedDetail(sessionId: string): Promise<BaselineSearchResult | null>;
    getStatistics(options?: { forceRefresh?: boolean; from?: string; to?: string }): Promise<BaselineConversationStats>;
    measureList(filters?: BaselineSearchFilters): Promise<BaselineMeasured<BaselineSearchResult[]>>;
    measureSearchSummaries(filters: BaselineSearchFilters): Promise<BaselineMeasured<BaselineSearchResult[]>>;
    measureSearchContent(filters: BaselineSearchFilters): Promise<BaselineMeasured<BaselineSearchResult[]>>;
    measureSelectedDetail(sessionId: string): Promise<BaselineMeasured<BaselineSearchResult | null>>;
    measureStatistics(options?: {
        forceRefresh?: boolean;
        from?: string;
        to?: string;
    }): Promise<BaselineMeasured<BaselineConversationStats>>;
    buildMetadataStore(options: {
        directory: string;
        records: SessionMetadataRecord[];
    }): Promise<BaselineMetadataStoreResult>;
    buildFreshProcessInvocation(options: {
        request: BaselineOracleRequest;
        cacheNamespace: string;
    }): Promise<BaselineFreshProcessInvocation>;
    close(): Promise<void>;
    probeFailure(message: string): Promise<void>;
}

interface ReadyEnvelope {
    schemaInitMs: number;
    driverPid: number;
}

interface SuccessEnvelope<T> {
    ok: true;
    value: T;
    measurement: BaselineOperationMeasurement;
}

interface FailureEnvelope {
    ok: false;
    error: string;
}

const DRIVER_SOURCE = `
import { createInterface } from "node:readline";
import { SafeJSON } from "@genesiscz/utils/json";

const RealDate = globalThis.Date;
const fixedNow = new RealDate(process.env.BASELINE_FIXED_NOW);
class FixedDate extends RealDate {
    constructor(...args) {
        if (args.length === 0) {
            super(fixedNow.getTime());
        } else if (args.length === 1) {
            super(args[0]);
        } else {
            super(...args);
        }
    }
    static now() {
        return fixedNow.getTime();
    }
}
const actualProbe = new FixedDate(2020, 1, 2, 3, 4, 5, 6).getTime();
const expectedProbe = new RealDate(2020, 1, 2, 3, 4, 5, 6).getTime();
if (actualProbe !== expectedProbe) {
    throw new Error("Fixed baseline clock changed multi-argument Date construction");
}
globalThis.Date = FixedDate;
const history = await import("./src/claude/lib/history/search.ts");
const cache = await import("./src/utils/claude/history-cache.ts");
const schemaStarted = performance.now();
cache.getDatabase();
const schemaInitMs = performance.now() - schemaStarted;
const writeProtocolLine = async (line) => {
    await new Promise((resolve, reject) => {
        process.stdout.write(line + "\\n", (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
};
await writeProtocolLine("${BASELINE_READY_PREFIX}" + SafeJSON.stringify({ schemaInitMs, driverPid: process.pid }));

const reviveFilters = (filters) => {
    const result = { ...filters };
    for (const key of ["since", "until", "conversationDate", "conversationDateUntil"]) {
        if (typeof result[key] === "string") {
            result[key] = new RealDate(result[key]);
        }
    }
    return result;
};
const execute = async (request) => {
    if (request.operation === "metadata-store") {
        cache.closeDatabase();
        const started = performance.now();
        const database = cache.getDatabase(request.directory);
        database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
        for (const record of request.records) {
            cache.upsertSessionMetadata(record);
        }
        const buildMs = performance.now() - started;
        return { buildMs, metadata: cache.getAllSessionMetadata() };
    }
    if (request.operation === "list") {
        return history.searchConversations({ ...reviveFilters(request.filters), query: undefined });
    }
    if (request.operation === "summary") {
        return history.searchConversations({ ...reviveFilters(request.filters), summaryOnly: true });
    }
    if (request.operation === "content") {
        return history.searchConversations({ ...reviveFilters(request.filters), summaryOnly: false });
    }
    if (request.operation === "detail") {
        return history.getConversationBySessionId(request.sessionId);
    }
    if (request.operation === "statistics") {
        return history.getConversationStatsWithCache({
            forceRefresh: request.forceRefresh,
            dateRange: request.from || request.to ? { from: request.from, to: request.to } : undefined,
        });
    }
    if (request.operation === "probe-failure") {
        throw new Error(request.message);
    }
    throw new Error("Unsupported baseline oracle operation");
};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
    for await (const rawLine of lines) {
        if (!rawLine.trim()) {
            continue;
        }
        const request = SafeJSON.parse(rawLine, { strict: true });
        const started = performance.now();
        const cpuStarted = process.cpuUsage();
        try {
            const value = await execute(request);
            const cpu = process.cpuUsage(cpuStarted);
            const measurement = {
                elapsedMs: performance.now() - started,
                cpuUserMicros: cpu.user,
                cpuSystemMicros: cpu.system,
                peakRssBytes: process.resourceUsage().maxRSS,
                driverPid: process.pid,
            };
            const serialized = SafeJSON.stringify({ ok: true, value, measurement });
            await writeProtocolLine("${BASELINE_RESULT_PREFIX}" + serialized);
        } catch (error) {
            await writeProtocolLine("${BASELINE_RESULT_PREFIX}" + SafeJSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            }));
            if (process.env.BASELINE_ONE_SHOT === "1") {
                process.exitCode = 1;
            }
        }
    }
} finally {
    cache.closeDatabase();
}
`;

async function spawnChecked(options: {
    command: string[];
    cwd: string;
    environment: Record<string, string>;
    stdin?: Uint8Array;
}): Promise<{ stdout: Uint8Array; stderr: string }> {
    const child = Bun.spawn(options.command, {
        cwd: options.cwd,
        env: options.environment,
        stdin: options.stdin,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).bytes(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (exitCode !== 0) {
        throw new Error(`Baseline command failed (${options.command.join(" ")}): ${stderr.trim()}`);
    }

    return { stdout, stderr };
}

function packageNameFromInput(path: string): string | undefined {
    const marker = "node_modules/";
    const start = path.lastIndexOf(marker);
    if (start < 0) {
        return undefined;
    }
    const segments = path.slice(start + marker.length).split("/");
    if (segments[0]?.startsWith("@")) {
        return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
    }

    return segments[0];
}

async function runtimeDependencies(checkout: string, metafilePath: string): Promise<Record<string, string>> {
    const metafile = SafeJSON.parse(await Bun.file(metafilePath).text(), { strict: true }) as {
        inputs: Record<string, object>;
    };
    const names = [
        ...new Set(
            Object.keys(metafile.inputs)
                .map(packageNameFromInput)
                .filter((name) => name !== undefined)
        ),
    ].sort();
    const versions: Record<string, string> = {};
    for (const name of names) {
        const packagePath = join(checkout, "node_modules", name, "package.json");
        const packageJson = SafeJSON.parse(await Bun.file(packagePath).text(), { strict: true }) as { version: string };
        versions[name] = packageJson.version;
    }

    return versions;
}

async function hashFile(path: string): Promise<string> {
    return createHash("sha256")
        .update(await Bun.file(path).bytes())
        .digest("hex");
}

async function verifyStoredMaterialization(options: {
    checkout: string;
    archivePath: string;
    manifest: BaselineOracleManifest;
}): Promise<void> {
    if (options.manifest.revision !== BASELINE_REVISION) {
        throw new Error(`Baseline revision mismatch: ${options.manifest.revision}`);
    }
    const bundleHash = await hashFile(join(options.checkout, "baseline-driver.bundle.js"));
    if (bundleHash !== options.manifest.runtimeBundleSha256) {
        throw new Error("Baseline oracle bundle hash mismatch");
    }
    const archiveHash = await hashFile(options.archivePath);
    if (archiveHash !== options.manifest.archiveSha256) {
        throw new Error("Baseline oracle source archive hash mismatch");
    }
    for (const [path, expected] of Object.entries(options.manifest.sourceHashes)) {
        if ((await hashFile(join(options.checkout, path))) !== expected) {
            throw new Error(`Baseline oracle source hash mismatch: ${path}`);
        }
    }
}

async function materialize(options: {
    world: HistoryFixtureWorld;
    repositoryRoot: string;
}): Promise<{ checkout: string; manifest: BaselineOracleManifest; elapsedMs: number }> {
    const started = performance.now();
    const checkout = join(options.world.root, `baseline-${BASELINE_REVISION}`);
    const bundlePath = join(checkout, "baseline-driver.bundle.js");
    const storedManifestPath = join(checkout, "baseline-oracle-manifest.json");
    const archivePath = join(options.world.root, "baseline-source.tar");
    if (existsSync(bundlePath) && existsSync(storedManifestPath) && existsSync(archivePath)) {
        const manifest = SafeJSON.parse(await Bun.file(storedManifestPath).text(), {
            strict: true,
        }) as BaselineOracleManifest;
        await verifyStoredMaterialization({ checkout, archivePath, manifest });
        return { checkout, manifest, elapsedMs: performance.now() - started };
    }

    options.world.assertOwnedPath(checkout);
    options.world.assertOwnedPath(archivePath);
    const archive = await spawnChecked({
        command: ["git", "archive", "--format=tar", BASELINE_REVISION, "--", ...ARCHIVE_PATHS],
        cwd: options.repositoryRoot,
        environment: options.world.environment,
    });
    await Bun.write(archivePath, archive.stdout);
    await mkdir(checkout, { recursive: true });
    await spawnChecked({
        command: ["tar", "-xf", archivePath, "-C", checkout],
        cwd: options.world.root,
        environment: options.world.environment,
    });
    const dependencyLink = join(checkout, "node_modules");
    await symlink(join(options.repositoryRoot, "node_modules"), dependencyLink, "dir");
    await Bun.write(join(checkout, "baseline-driver.ts"), DRIVER_SOURCE);
    const metafilePath = join(checkout, "baseline-driver.meta.json");
    await spawnChecked({
        command: [
            "bun",
            "build",
            "baseline-driver.ts",
            "--outfile",
            "baseline-driver.bundle.js",
            "--target=bun",
            "--metafile=baseline-driver.meta.json",
        ],
        cwd: checkout,
        environment: options.world.environment,
    });
    const dependencies = await runtimeDependencies(checkout, metafilePath);
    await unlink(dependencyLink);

    const sourceHashes: Record<string, string> = {};
    for (const path of HASHED_PATHS) {
        sourceHashes[path] = await hashFile(join(checkout, path));
    }
    const runtimeBundleBytes = await Bun.file(bundlePath).bytes();
    const archiveSha256 = createHash("sha256").update(new Uint8Array(archive.stdout)).digest("hex");
    const runtimeDependencyHash = createHash("sha256").update(SafeJSON.stringify(dependencies)).digest("hex");
    const manifest: BaselineOracleManifest = {
        revision: BASELINE_REVISION,
        archiveSha256,
        runtimeBundleSha256: createHash("sha256").update(runtimeBundleBytes).digest("hex"),
        runtimeDependencyHash,
        runtimeDependencies: dependencies,
        sourceHashes,
        dependencyManifestHashes: {
            packageJson: sourceHashes["package.json"]!,
            bunLock: sourceHashes["bun.lock"]!,
        },
    };
    await Bun.write(storedManifestPath, SafeJSON.stringify(manifest));
    return { checkout, manifest, elapsedMs: performance.now() - started };
}

function createLineReader(stream: AsyncIterable<Uint8Array>): () => Promise<string | undefined> {
    const iterator = stream[Symbol.asyncIterator]();
    const decoder = new TextDecoder();
    let buffer = "";
    return async () => {
        while (true) {
            const newline = buffer.indexOf("\n");
            if (newline >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                return line;
            }
            const next = await iterator.next();
            if (next.done) {
                const finalLine = buffer + decoder.decode();
                buffer = "";
                return finalLine || undefined;
            }
            buffer += decoder.decode(next.value, { stream: true });
        }
    };
}

async function readStreamText(stream: AsyncIterable<Uint8Array>): Promise<string> {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream) {
        text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
}

async function writeProtocolRequest(
    child: ChildProcessWithoutNullStreams,
    request: BaselineOracleRequest
): Promise<void> {
    const line = `${SafeJSON.stringify(request)}\n`;
    await new Promise<void>((resolve, reject) => {
        child.stdin.write(line, (error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

async function readProtocolLine(options: {
    nextLine: () => Promise<string | undefined>;
    prefix: string;
    child: { exited: Promise<number> };
    stderr: Promise<string>;
}): Promise<string> {
    while (true) {
        const line = await options.nextLine();
        if (line?.startsWith(options.prefix)) {
            return line.slice(options.prefix.length);
        }
        if (line === undefined) {
            const exitCode = await options.child.exited;
            throw new Error(`Baseline oracle exited ${exitCode}: ${(await options.stderr).trim()}`);
        }
    }
}

function reviveResult(result: BaselineSearchResult): BaselineSearchResult {
    return { ...result, timestamp: new Date(result.timestamp) };
}

function reviveMeasuredResults(
    measured: BaselineMeasured<BaselineSearchResult[]>
): BaselineMeasured<BaselineSearchResult[]> {
    return { ...measured, value: measured.value.map(reviveResult) };
}

export async function createBaselineOracle(options: {
    world: HistoryFixtureWorld;
    repositoryRoot?: string;
    cacheNamespace?: string;
    cacheHome?: string;
}): Promise<BaselineOracle> {
    const repositoryRoot = resolve(options.repositoryRoot ?? defaultRepositoryRoot());
    const materialized = await materialize({ world: options.world, repositoryRoot });
    if (options.cacheHome !== undefined && options.cacheNamespace !== undefined) {
        throw new Error("Choose cacheHome or cacheNamespace, not both");
    }
    let cacheHome = options.world.environment.GENESIS_TOOLS_HOME!;
    let databasePath = options.world.databases.legacy;
    if (options.cacheHome !== undefined) {
        cacheHome = options.world.assertOwnedPath(options.cacheHome);
        await mkdir(cacheHome, { recursive: true });
        databasePath = join(cacheHome, ".genesis-tools", "claude-history", "index.db");
    } else if (options.cacheNamespace !== undefined) {
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(options.cacheNamespace)) {
            throw new Error("Baseline cache namespace must contain only letters, digits, and hyphens");
        }
        cacheHome = options.world.assertOwnedPath(
            join(options.world.root, "baseline-instance-caches", options.cacheNamespace)
        );
        await mkdir(cacheHome, { recursive: true });
        databasePath = join(cacheHome, ".genesis-tools", "claude-history", "index.db");
    }
    const environment = {
        ...options.world.environment,
        GENESIS_TOOLS_HOME: cacheHome,
        BASELINE_FIXED_NOW: options.world.now.toISOString(),
    };
    const bundlePath = join(materialized.checkout, "baseline-driver.bundle.js");
    const driverStarted = performance.now();
    const child = spawn("bun", [bundlePath], {
        cwd: options.world.git.root,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const exited = new Promise<number>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("close", (code) => resolveExit(code ?? 1));
    });
    const nextLine = createLineReader(child.stdout);
    const stderr = readStreamText(child.stderr);
    const processState = { exited };
    const ready = SafeJSON.parse(
        await readProtocolLine({ nextLine, prefix: BASELINE_READY_PREFIX, child: processState, stderr }),
        { strict: true }
    ) as ReadyEnvelope;
    let closed = false;
    let queue: Promise<void> = Promise.resolve();

    function serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = queue.then(operation, operation);
        queue = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    function invokeMeasured<T>(request: BaselineOracleRequest): Promise<BaselineMeasured<T>> {
        return serialize(async () => {
            if (closed) {
                throw new Error("Baseline oracle is closed");
            }
            await writeProtocolRequest(child, request);
            const payload = await readProtocolLine({
                nextLine,
                prefix: BASELINE_RESULT_PREFIX,
                child: processState,
                stderr,
            });
            const response = SafeJSON.parse(payload, { strict: true }) as SuccessEnvelope<T> | FailureEnvelope;
            if (!response.ok) {
                throw new Error(`Baseline oracle failed: ${response.error}`);
            }

            return { value: response.value, measurement: response.measurement };
        });
    }

    const measureResults = async (request: BaselineOracleRequest): Promise<BaselineMeasured<BaselineSearchResult[]>> =>
        reviveMeasuredResults(await invokeMeasured<BaselineSearchResult[]>(request));
    const measureDetail = async (sessionId: string): Promise<BaselineMeasured<BaselineSearchResult | null>> => {
        const measured = await invokeMeasured<BaselineSearchResult | null>({ operation: "detail", sessionId });
        return { ...measured, value: measured.value ? reviveResult(measured.value) : null };
    };
    const measureStatistics = (
        statisticsOptions: { forceRefresh?: boolean; from?: string; to?: string } = {}
    ): Promise<BaselineMeasured<BaselineConversationStats>> =>
        invokeMeasured<BaselineConversationStats>({
            operation: "statistics",
            forceRefresh: statisticsOptions.forceRefresh ?? true,
            from: statisticsOptions.from,
            to: statisticsOptions.to,
        });

    const oracle: BaselineOracle = {
        databasePath,
        manifest: materialized.manifest,
        startupMeasurement: {
            materializeMs: materialized.elapsedMs,
            driverStartMs: performance.now() - driverStarted,
            schemaInitMs: ready.schemaInitMs,
        },
        measureList: (filters = {}) => measureResults({ operation: "list", filters }),
        measureSearchSummaries: (filters) => measureResults({ operation: "summary", filters }),
        measureSearchContent: (filters) => measureResults({ operation: "content", filters }),
        measureSelectedDetail: measureDetail,
        measureStatistics,
        async buildMetadataStore({ directory, records }) {
            const ownedDirectory = options.world.assertOwnedPath(directory);
            return (
                await invokeMeasured<BaselineMetadataStoreResult>({
                    operation: "metadata-store",
                    directory: ownedDirectory,
                    records,
                })
            ).value;
        },
        async list(filters = {}) {
            return (await oracle.measureList(filters)).value;
        },
        async searchSummaries(filters) {
            return (await oracle.measureSearchSummaries(filters)).value;
        },
        async searchContent(filters) {
            return (await oracle.measureSearchContent(filters)).value;
        },
        async getSelectedDetail(sessionId) {
            return (await oracle.measureSelectedDetail(sessionId)).value;
        },
        async getStatistics(statisticsOptions = {}) {
            return (await oracle.measureStatistics(statisticsOptions)).value;
        },
        async buildFreshProcessInvocation({ request, cacheNamespace }) {
            if (!/^[a-z0-9][a-z0-9-]*$/i.test(cacheNamespace)) {
                throw new Error("Baseline cache namespace must contain only letters, digits, and hyphens");
            }
            const cacheHome = options.world.assertOwnedPath(
                join(options.world.root, "baseline-cold-caches", cacheNamespace)
            );
            await mkdir(cacheHome, { recursive: true });
            return {
                command: ["bun", bundlePath],
                cwd: options.world.git.root,
                environment: { ...environment, GENESIS_TOOLS_HOME: cacheHome, BASELINE_ONE_SHOT: "1" },
                stdin: `${SafeJSON.stringify(request)}\n`,
                resultPrefix: BASELINE_RESULT_PREFIX,
                databasePath: join(cacheHome, ".genesis-tools", "claude-history", "index.db"),
            };
        },
        async probeFailure(message) {
            await invokeMeasured({ operation: "probe-failure", message });
        },
        async close() {
            await serialize(async () => {
                if (closed) {
                    return;
                }
                closed = true;
                child.stdin.end();
                const exitCode = await exited;
                if (exitCode !== 0) {
                    throw new Error(`Baseline oracle close exited ${exitCode}: ${(await stderr).trim()}`);
                }
            });
        },
    };
    return oracle;
}
