import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { claudeHistoryReader } from "@genesiscz/utils/agent-sessions/compact-readers";
import { initializeCompactHistorySchema } from "@genesiscz/utils/agent-sessions/migrations";
import {
    type HistorySearchResponse,
    type HistorySearchResult,
    HistoryService,
} from "@genesiscz/utils/agent-sessions/service";
import { HistorySyncRepository } from "@genesiscz/utils/agent-sessions/sync-repository";
import type { HistorySourceRecord, NativeSessionReader } from "@genesiscz/utils/agent-sessions/types";
import { SafeJSON } from "@genesiscz/utils/json";
import type {
    BenchmarkCounters,
    BenchmarkInvocationResult,
    BenchmarkOperation,
    BenchmarkVariant,
    BenchmarkVariantFactory,
} from "./benchmark";

const PROVIDER_ID = "anthropic-sub";
const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const SOURCE_CODE_FILES = {
    candidate: resolve(import.meta.dir, "compact-candidate.ts"),
    claudePaths: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/readers/claude-paths.ts"),
    compactReaders: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/compact-readers.ts"),
    migrations: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/migrations.ts"),
    fingerprint: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/fingerprint.ts"),
    metadata: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/metadata.ts"),
    repository: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/repository.ts"),
    searchCandidates: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/search-candidates.ts"),
    searchOccurrences: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/search-occurrences.ts"),
    searchPlan: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/search-plan.ts"),
    searchRank: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/search-rank.ts"),
    searchSource: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/search-source.ts"),
    service: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/service.ts"),
    sourceScan: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/source-scan.ts"),
    sourceDiscovery: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/source-discovery.ts"),
    sync: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/sync.ts"),
    syncRepository: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/sync-repository.ts"),
    types: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/types.ts"),
    claudeDiscovery: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/readers/claude-discovery.ts"),
    claudeReader: resolve(REPOSITORY_ROOT, "src/utils/agent-sessions/readers/claude.ts"),
} as const;

interface CandidateSourceState {
    revision: string;
    hashes: Record<keyof typeof SOURCE_CODE_FILES, string>;
}

async function candidateSourceState(): Promise<CandidateSourceState> {
    const processHandle = Bun.spawn(["git", "rev-parse", "HEAD"], {
        cwd: REPOSITORY_ROOT,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [revision, errorText, exitCode] = await Promise.all([
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
        processHandle.exited,
    ]);
    if (exitCode !== 0) {
        throw new Error(`Could not resolve candidate revision: ${errorText.trim()}`);
    }

    const hashes = Object.fromEntries(
        await Promise.all(
            Object.entries(SOURCE_CODE_FILES).map(async ([name, path]) => [
                name,
                createHash("sha256")
                    .update(await readFile(path))
                    .digest("hex"),
            ])
        )
    ) as CandidateSourceState["hashes"];
    return { revision: revision.trim(), hashes };
}

async function assertCandidateSourceState(expected: CandidateSourceState): Promise<void> {
    const actual = await candidateSourceState();
    if (SafeJSON.stringify(actual, { strict: true }) !== SafeJSON.stringify(expected, { strict: true })) {
        throw new Error("Compact candidate source changed during benchmark");
    }
}

type CandidateCounters = Pick<
    BenchmarkCounters,
    "sourceBytesRead" | "candidates" | "metadataReads" | "sourceHydrations" | "transactions"
>;

function resetCounters(counters: CandidateCounters): void {
    counters.sourceBytesRead = 0;
    counters.candidates = 0;
    counters.metadataReads = 0;
    counters.sourceHydrations = 0;
    counters.transactions = 0;
}

function addSourceBytes(counters: CandidateCounters, filePath: string): void {
    counters.sourceBytesRead += statSync(filePath).size;
}

function measuredReader(options: { roots: string[]; counters: CandidateCounters }): NativeSessionReader<"claude"> {
    const readMetadata = claudeHistoryReader.readMetadata;
    const scan = claudeHistoryReader.scan;
    const readRecords = claudeHistoryReader.readRecords;
    if (!readMetadata || !scan || !readRecords) {
        throw new Error("Claude compact reader is missing required history operations");
    }

    return {
        ...claudeHistoryReader,
        roots: () => options.roots,
        async discover(roots, discoveryOptions) {
            const result = await claudeHistoryReader.discover(roots, discoveryOptions);
            options.counters.candidates += result.sources.length;
            return result;
        },
        async readMetadata(source, readOptions) {
            options.counters.metadataReads += 1;
            addSourceBytes(options.counters, source.filePath);
            return readMetadata(source, readOptions);
        },
        async *scan(source, readOptions) {
            options.counters.sourceHydrations += 1;
            addSourceBytes(options.counters, source.filePath);
            for await (const record of scan(source, readOptions)) {
                yield record;
            }
        },
        async readRecords(source, readOptions) {
            options.counters.sourceHydrations += 1;
            addSourceBytes(options.counters, source.filePath);
            return readRecords(source, readOptions);
        },
    };
}

class MeasuredSyncRepository extends HistorySyncRepository {
    constructor(
        database: Database,
        private readonly counters: CandidateCounters
    ) {
        super(database);
    }

    override transaction<T>(operation: () => T): T {
        this.counters.transactions += 1;
        return super.transaction(operation);
    }
}

function parsedOriginal(record: HistorySourceRecord): object {
    const parsed = SafeJSON.parse(record.original, { strict: true });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("Claude source record is not a JSON object");
    }

    return parsed;
}

interface CandidatePathMapping {
    canonicalRoot: string;
    publicRoot: string;
}

function publicFilePath(filePath: string, mapping: CandidatePathMapping): string {
    const suffix = relative(mapping.canonicalRoot, filePath);
    if (suffix === ".." || suffix.startsWith("../")) {
        throw new Error("Candidate result escaped the explicit Claude fixture root");
    }

    return join(mapping.publicRoot, suffix);
}

function publicClaudeDto(options: {
    result: HistorySearchResult;
    includeRelevance: boolean;
    pathMapping: CandidatePathMapping;
}): object {
    const { result } = options;
    const sessionId = result.metadata.sessionId;
    if (sessionId === null) {
        throw new Error("Candidate metadata omitted the legacy public Claude session ID");
    }

    const value: Record<string, object | object[] | string | number | boolean | Date> = {
        filePath: publicFilePath(result.metadata.filePath, options.pathMapping),
        project: result.metadata.project ?? "",
        sessionId,
        timestamp: result.timestamp,
        matchedMessages: result.matchedRecords.map(parsedOriginal),
        isSubagent: result.metadata.isSubagent,
    };
    if (result.metadata.summary !== null) {
        value.summary = result.metadata.summary;
    }
    if (result.metadata.customTitle !== null) {
        value.customTitle = result.metadata.customTitle;
    }
    if (result.metadata.gitBranch !== null) {
        value.gitBranch = result.metadata.gitBranch;
    }
    if (options.includeRelevance) {
        value.relevanceScore = result.relevanceScore;
    }

    return value;
}

async function executeCandidate(options: {
    service: HistoryService;
    operation: BenchmarkOperation;
    commonQuery: string;
    rareQuery: string;
    absentQuery: string;
    counters: CandidateCounters;
    pathMapping: CandidatePathMapping;
    expectedSessions: number;
}): Promise<BenchmarkInvocationResult> {
    resetCounters(options.counters);
    let response: HistorySearchResponse;
    switch (options.operation) {
        case "metadata-list": {
            const synchronized = await options.service.sync();
            if (synchronized.report.issues.length > 0) {
                throw new Error(
                    `Compact candidate metadata sync reported issues: ${SafeJSON.stringify(synchronized.report, { strict: true })}`
                );
            }
            response = options.service.cached({ limit: Number.MAX_SAFE_INTEGER });
            if (response.results.length !== options.expectedSessions) {
                throw new Error(
                    `Compact candidate metadata sync incomplete: expected ${options.expectedSessions}, received ${response.results.length}; ${SafeJSON.stringify(synchronized.report, { strict: true })}`
                );
            }
            break;
        }
        case "summary-search":
            response = await options.service.search({ query: options.commonQuery, limit: 20, summaryOnly: true });
            break;
        case "content-rare":
            response = await options.service.search({ query: options.rareQuery, limit: 20 });
            break;
        case "content-common":
            response = await options.service.search({ query: options.commonQuery, limit: 20 });
            break;
        case "content-absent":
            response = await options.service.search({ query: options.absentQuery, limit: 20 });
            break;
    }

    if (response.issues.length > 0) {
        throw new Error(`Compact candidate reported source issues: ${response.issues[0]?.message ?? "unknown issue"}`);
    }

    return {
        value: response.results.map((result) =>
            publicClaudeDto({
                result,
                includeRelevance: options.operation !== "metadata-list",
                pathMapping: options.pathMapping,
            })
        ),
        counters: { ...options.counters },
    };
}

export const createBenchmarkVariant: BenchmarkVariantFactory = async ({ world, corpus }): Promise<BenchmarkVariant> => {
    const storagePaths = new Set<string>();
    const sourceCode = await candidateSourceState();
    return {
        name: "candidate",
        async open(context) {
            await assertCandidateSourceState(sourceCode);
            await mkdir(dirname(context.cachePath), { recursive: true });
            const database = new Database(context.cachePath, { create: true });
            database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000");
            const schemaStarted = performance.now();
            initializeCompactHistorySchema(database);
            const schemaInitMs = performance.now() - schemaStarted;
            storagePaths.add(context.cachePath);
            const counters: CandidateCounters = {
                sourceBytesRead: 0,
                candidates: 0,
                metadataReads: 0,
                sourceHydrations: 0,
                transactions: 0,
            };
            const roots = [world.sources.claude];
            const pathMapping = {
                canonicalRoot: realpathSync(world.sources.claude),
                publicRoot: world.sources.claude,
            };
            const reader = measuredReader({ roots, counters });
            const repository = new MeasuredSyncRepository(database, counters);
            const service = new HistoryService({
                providerId: PROVIDER_ID,
                reader,
                repository,
                roots,
                now: () => world.now,
            });
            return {
                initializationDetails: { schemaInitMs },
                execute: (operation) =>
                    executeCandidate({
                        service,
                        operation,
                        commonQuery: corpus.queries.common,
                        rareQuery: corpus.queries.rare,
                        absentQuery: corpus.queries.absent,
                        counters,
                        pathMapping,
                        expectedSessions: corpus.logical.sessions,
                    }),
                close: async () => {
                    database.close();
                    await assertCandidateSourceState(sourceCode);
                },
            };
        },
        storagePaths: () => [...storagePaths].toSorted(),
        manifest: () => ({
            engine: "HistoryService",
            providerId: PROVIDER_ID,
            database: "compact",
            serviceOnly: true,
            cliMeasurements: false,
            sourceCode,
        }),
    };
};
