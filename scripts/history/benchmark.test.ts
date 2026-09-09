import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateHistoryCorpus } from "../../src/utils/agent-sessions/testing/corpus";
import { createFixtureWorld } from "../../src/utils/agent-sessions/testing/fixture-world";
import { withBaseline } from "../../src/utils/agent-sessions/testing/with-baseline";
import { SafeJSON } from "../../src/utils/json";
import {
    type BenchmarkOperation,
    type BenchmarkVariant,
    createBaselineBenchmarkVariant,
    inspectSqliteStorage,
    parseBenchmarkCliArgs,
    runBenchmarkCli,
    runBenchmarkMatrix,
    runGeneratedHistoryBenchmark,
} from "./benchmark";

function resultFor(operation: BenchmarkOperation) {
    const ids = operation === "metadata-list" ? ["session-main", "session-agent"] : ["session-main"];

    return {
        value: ids.map((sessionId) => ({ sessionId, title: `${operation} fixture` })),
        counters: { parsedRecords: 12, candidates: ids.length },
    };
}

describe("compact history benchmark matrix", () => {
    test("interleaves 30 warm service samples while preserving ordered parity", async () => {
        const calls: string[] = [];
        const variants: BenchmarkVariant[] = ["baseline", "candidate"].map((name) => ({
            name,
            async open() {
                return {
                    async execute(operation) {
                        calls.push(`${name}:${operation}`);
                        return resultFor(operation);
                    },
                };
            },
        }));

        const report = await runBenchmarkMatrix({
            variants,
            operations: ["metadata-list", "content-rare"],
            warmRepetitions: 30,
            coldRepetitions: 0,
            includeCli: false,
            cacheRoot: "/owned/cache",
        });

        expect(report.parity).toMatchObject([
            {
                operation: "metadata-list",
                baseline: "baseline",
                variant: "candidate",
                equalIds: true,
                equalStructure: true,
                baselineIds: ["session-main", "session-agent"],
                variantIds: ["session-main", "session-agent"],
                structuralMismatches: [],
            },
            {
                operation: "content-rare",
                baseline: "baseline",
                variant: "candidate",
                equalIds: true,
                equalStructure: true,
                baselineIds: ["session-main"],
                variantIds: ["session-main"],
                structuralMismatches: [],
            },
        ]);
        expect(report.measurements.filter((measurement) => measurement.phase === "warm-service")).toHaveLength(120);
        const warmServiceSummaries = report.summaries.filter((summary) => summary.phase === "warm-service");
        expect(warmServiceSummaries.every((summary) => summary.samples === 30 && summary.p95Ms >= 0)).toBe(true);
        expect(calls.slice(4, 8)).toEqual([
            "baseline:metadata-list",
            "candidate:metadata-list",
            "candidate:content-rare",
            "baseline:content-rare",
        ]);
    });
});

test("keeps CLI startup samples separate and preserves nonzero exits", async () => {
    const variants: BenchmarkVariant[] = ["baseline", "candidate"].map((name) => ({
        name,
        async open() {
            return {
                async execute(operation) {
                    return resultFor(operation);
                },
            };
        },
        command({ operation }) {
            return {
                argv: ["fixture-cli", name, operation],
                cwd: "/owned",
                env: { HOME: "/owned/home", GENESIS_TOOLS_HOME: "/owned/home" },
            };
        },
    }));

    const report = await runBenchmarkMatrix({
        variants,
        operations: ["content-absent"],
        warmRepetitions: 2,
        coldRepetitions: 0,
        includeCli: true,
        cacheRoot: "/owned/cache",
        async runCommand(command) {
            return {
                exitStatus: command.argv[1] === "candidate" ? 7 : 0,
                userCpuMs: 2,
                systemCpuMs: 1,
                peakRssBytes: 4_096,
                failure: command.argv[1] === "candidate" ? "fixture failure" : undefined,
            };
        },
    });

    const cli = report.measurements.filter((measurement) => measurement.phase === "warm-cli");
    expect(cli).toHaveLength(4);
    expect(cli.find((measurement) => measurement.variant === "candidate")).toMatchObject({
        exitStatus: 7,
        failure: "fixture failure",
        counters: {
            sourceBytesRead: "unavailable",
            parsedRecords: "unavailable",
            candidates: "unavailable",
            metadataReads: "unavailable",
            sourceHydrations: "unavailable",
            transactions: "unavailable",
        },
    });
    expect(
        report.summaries.find((summary) => summary.variant === "candidate" && summary.phase === "warm-cli")
    ).toMatchObject({ samples: 2, nonzeroExitStatuses: [7, 7] });
});

test("uses a fresh derived cache for each cold sample and withholds cold p95", async () => {
    const opened = new Map<string, string[]>();
    const variants: BenchmarkVariant[] = ["baseline", "candidate"].map((name) => ({
        name,
        async open(context) {
            opened.set(name, [...(opened.get(name) ?? []), context.cachePath]);
            return {
                async execute(operation) {
                    return resultFor(operation);
                },
            };
        },
    }));

    const report = await runBenchmarkMatrix({
        variants,
        operations: ["metadata-list"],
        warmRepetitions: 0,
        coldRepetitions: 3,
        includeCli: false,
        cacheRoot: "/owned/cache",
    });

    expect(opened.get("baseline")?.slice(1)).toEqual([
        "/owned/cache/cold/0/metadata-list/service/baseline",
        "/owned/cache/cold/1/metadata-list/service/baseline",
        "/owned/cache/cold/2/metadata-list/service/baseline",
    ]);
    expect(new Set(opened.get("candidate")?.slice(1)).size).toBe(3);
    expect(
        report.summaries.find((summary) => summary.variant === "baseline" && summary.phase === "cold-service")
    ).toMatchObject({ samples: 3, p95Ms: "unavailable" });
    expect(
        report.summaries.find((summary) => summary.variant === "baseline" && summary.phase === "cold-initialize")
    ).toMatchObject({ samples: 3, p95Ms: "unavailable" });
});

test("reports SQLite main and sidecar bytes with table and index pages", async () => {
    const world = await createFixtureWorld();
    try {
        const database = new Database(world.databases.candidate);
        database.exec(
            "PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT); CREATE INDEX sessions_title ON sessions(title); INSERT INTO sessions VALUES ('fixture', 'Invented');"
        );
        const footprint = inspectSqliteStorage(world.databases.candidate, database);

        expect(footprint.files.main).toBeGreaterThan(0);
        expect(footprint.files.wal).toBeGreaterThanOrEqual(0);
        expect(footprint.files.shm).toBeGreaterThanOrEqual(0);
        if (footprint.objects === "unavailable") {
            // Linux CI links a SQLite without SQLITE_ENABLE_DBSTAT_VTAB; the helper reports why
            // rather than inventing a page breakdown, and the storage budget is measured on macOS.
            expect(footprint.unavailableReason).toContain("dbstat");
        } else {
            expect(footprint.objects.find((entry) => entry.name === "sessions")?.kind).toBe("table");
            expect(footprint.objects.find((entry) => entry.name === "sessions_title")?.kind).toBe("index");
            expect(footprint.objects.every((entry) => entry.bytes > 0 && entry.pages > 0)).toBe(true);
        }
        expect(inspectSqliteStorage(join(world.root, "missing.db"))).toMatchObject({
            files: { main: 0, wal: 0, shm: 0 },
            objects: "unavailable",
            unavailableReason: "database file does not exist",
        });
        database.close();
    } finally {
        await world.dispose();
    }
});

test("detects value drift without copying DTO payloads into parity evidence", async () => {
    const variants: BenchmarkVariant[] = [
        {
            name: "baseline",
            async open() {
                return {
                    async execute() {
                        return { value: [{ sessionId: "same-id", title: "/tmp/world-a/Original" }] };
                    },
                };
            },
        },
        {
            name: "candidate",
            async open() {
                return {
                    async execute() {
                        return { value: [{ sessionId: "same-id", title: "/tmp/world-b/Changed" }] };
                    },
                };
            },
        },
    ];

    const report = await runBenchmarkMatrix({
        variants,
        operations: ["metadata-list"],
        warmRepetitions: 0,
        coldRepetitions: 0,
        includeCli: false,
        cacheRoot: "/owned/cache",
        normalizePrefixes: ["/tmp/world-a", "/tmp/world-b"],
    });

    expect(report.parity[0]).toMatchObject({
        equalIds: true,
        equalStructure: true,
        equalValues: false,
        valueMismatches: ["$[0].title: value differs"],
    });
    expect(report.parity[0]?.baselineHash).not.toBe(report.parity[0]?.variantHash);
    expect(SafeJSON.stringify(report)).not.toContain("Original");
    expect(SafeJSON.stringify(report)).not.toContain("Changed");
});

test("closes already-open adapters when a later variant fails to initialize", async () => {
    let closes = 0;
    const variants: BenchmarkVariant[] = [
        {
            name: "baseline",
            async open() {
                return {
                    async execute(operation) {
                        return resultFor(operation);
                    },
                    close() {
                        closes += 1;
                    },
                };
            },
        },
        {
            name: "candidate",
            async open() {
                throw new Error("candidate initialization failed");
            },
        },
    ];

    await expect(
        runBenchmarkMatrix({
            variants,
            operations: ["metadata-list"],
            warmRepetitions: 0,
            coldRepetitions: 0,
            includeCli: false,
            cacheRoot: "/owned/cache",
        })
    ).rejects.toThrow("candidate initialization failed");
    expect(closes).toBe(1);
});

test("separates warm initialization and marks baseline-only parity pending", async () => {
    const report = await runBenchmarkMatrix({
        variants: [
            {
                name: "baseline",
                async open() {
                    return {
                        async execute(operation) {
                            return resultFor(operation);
                        },
                    };
                },
            },
        ],
        operations: ["metadata-list"],
        warmRepetitions: 0,
        coldRepetitions: 0,
        includeCli: false,
        cacheRoot: "/owned/cache",
    });

    expect(report.comparisonStatus).toBe("pending-no-candidate");
    expect(report.measurements.map(({ variant, operation, phase }) => ({ variant, operation, phase }))).toEqual([
        {
            variant: "baseline",
            operation: "initialize",
            phase: "warm-initialize",
        },
    ]);
    expect(report.parity).toEqual([]);
    expect(report.summaries).toMatchObject([{ phase: "warm-initialize", samples: 1, p95Ms: "unavailable" }]);
});

test("uses inner service metrics supplied by an isolated adapter", async () => {
    const report = await runBenchmarkMatrix({
        variants: [
            {
                name: "baseline",
                async open() {
                    return {
                        async execute() {
                            return {
                                value: [],
                                metrics: { wallMs: 12.5, userCpuMs: 3, systemCpuMs: 2, peakRssBytes: 8_192 },
                            };
                        },
                    };
                },
            },
        ],
        operations: ["content-rare"],
        warmRepetitions: 1,
        coldRepetitions: 0,
        includeCli: false,
        cacheRoot: "/owned/cache",
    });

    expect(report.measurements.find((measurement) => measurement.phase === "warm-service")).toMatchObject({
        wallMs: 12.5,
        userCpuMs: 3,
        systemCpuMs: 2,
        peakRssBytes: 8_192,
    });
});

test("requires an explicit owned root and complete corpus distribution", () => {
    expect(() => parseBenchmarkCliArgs([])).toThrow("--root is required");
    expect(() =>
        parseBenchmarkCliArgs([
            "--root",
            "relative",
            "--output",
            "/owned/report.json",
            "--sessions",
            "4",
            "--records",
            "12",
            "--main-sessions",
            "3",
            "--subagent-sessions",
            "1",
        ])
    ).toThrow("--root must be absolute");

    expect(
        parseBenchmarkCliArgs([
            "--root",
            "/owned/benchmark",
            "--output",
            "/owned/benchmark/report.json",
            "--sessions",
            "12_000",
            "--records",
            "240_000",
            "--main-sessions",
            "10_000",
            "--subagent-sessions",
            "2_000",
            "--seed",
            "73",
            "--warm",
            "30",
            "--cold",
            "5",
        ])
    ).toEqual({
        root: "/owned/benchmark",
        output: "/owned/benchmark/report.json",
        sessionCount: 12_000,
        recordCount: 240_000,
        mainSessionCount: 10_000,
        subagentSessionCount: 2_000,
        seed: 73,
        warmRepetitions: 30,
        coldRepetitions: 5,
        candidateModule: undefined,
    });
});

test("writes a generated-corpus artifact with hashes but without transcript payloads", async () => {
    const owner = await createFixtureWorld();
    try {
        const output = join(owner.root, "benchmark-report.json");
        const startedAt = Date.now();
        const artifact = await runGeneratedHistoryBenchmark({
            config: {
                root: owner.root,
                output,
                sessionCount: 3,
                recordCount: 9,
                mainSessionCount: 2,
                subagentSessionCount: 1,
                seed: 73,
                warmRepetitions: 0,
                coldRepetitions: 0,
            },
            async createVariants() {
                return [
                    {
                        name: "baseline",
                        async open() {
                            return {
                                async execute(operation) {
                                    return resultFor(operation);
                                },
                            };
                        },
                    },
                ];
            },
            includeCli: false,
        });
        const serialized = await readFile(output, "utf8");

        expect(new Date(artifact.generatedAt).getTime()).toBeGreaterThanOrEqual(startedAt);
        expect(new Date(artifact.generatedAt).getTime()).toBeLessThanOrEqual(Date.now());
        expect(artifact.corpus).toMatchObject({
            sourceCount: 12,
            logical: { sessions: 3, records: 9, main: 2, subagent: 1 },
            providers: { claude: 3, codex: 3, grok: 3 },
        });
        expect(artifact.corpus.sources).toHaveLength(12);
        expect(artifact.corpus.sources.every((source) => /^[0-9a-f]{64}$/.test(source.sha256))).toBe(true);
        expect(artifact.matrix.comparisonStatus).toBe("pending-no-candidate");
        expect(serialized).not.toContain("seed-73 session-");
        expect(serialized).not.toContain("record-0 token-");
    } finally {
        await owner.dispose();
    }
});

withBaseline(
    "benchmark CLI can run a service-only candidate module",
    async () => {
        // Regression test: PR #370 review thread 13 — compact-candidate has no fresh-process command factory.
        const owner = await createFixtureWorld();
        try {
            const root = join(owner.root, "service-only-cli");
            const artifact = await runBenchmarkCli([
                "--root",
                root,
                "--output",
                join(root, "report.json"),
                "--sessions",
                "1",
                "--records",
                "3",
                "--main-sessions",
                "1",
                "--subagent-sessions",
                "0",
                "--warm",
                "0",
                "--cold",
                "0",
                "--candidate-module",
                join(import.meta.dir, "compact-candidate.ts"),
                "--include-cli",
                "false",
            ]);

            expect(artifact.matrix.comparisonStatus).toBe("compared");
            expect(artifact.matrix.prewarm).toEqual([]);
        } finally {
            await owner.dispose();
        }
    },
    120_000
);

withBaseline(
    "runs measured baseline service and fresh-process samples against one generated corpus",
    async () => {
        const world = await createFixtureWorld();
        try {
            const corpus = await generateHistoryCorpus({
                root: world.root,
                seed: 73,
                sessionCount: 1,
                recordCount: 3,
                distribution: { main: 1, subagent: 0 },
            });
            const baseline = createBaselineBenchmarkVariant({ world, corpus });
            const report = await runBenchmarkMatrix({
                variants: [baseline],
                operations: ["content-rare"],
                warmRepetitions: 2,
                coldRepetitions: 0,
                includeCli: true,
                cacheRoot: join(world.root, "benchmark-cache"),
                normalizePrefixes: [world.root],
            });

            expect(report.comparisonStatus).toBe("pending-no-candidate");
            expect(report.measurements.find((measurement) => measurement.phase === "warm-service")).toMatchObject({
                exitStatus: 0,
                counters: { parsedRecords: "unavailable" },
            });
            expect(report.measurements.find((measurement) => measurement.phase === "warm-cli")).toMatchObject({
                exitStatus: 0,
                failure: undefined,
            });
            expect(baseline.manifest?.()).toMatchObject({ revision: "010697b869a34af0e79363b5c74bfc4946f74b96" });
            expect(baseline.storagePaths?.()).toHaveLength(2);
        } finally {
            await world.dispose();
        }
    },
    120_000
);

test("preserves a failed service sample and continues later repetitions", async () => {
    let calls = 0;
    const report = await runBenchmarkMatrix({
        variants: [
            {
                name: "baseline",
                async open() {
                    return {
                        async execute(operation) {
                            calls += 1;
                            if (calls === 2) {
                                throw new Error("fixture service failed");
                            }
                            return resultFor(operation);
                        },
                    };
                },
            },
        ],
        operations: ["metadata-list"],
        warmRepetitions: 2,
        coldRepetitions: 0,
        includeCli: false,
        cacheRoot: "/owned/cache",
    });

    expect(report.measurements.filter((measurement) => measurement.phase === "warm-service")).toMatchObject([
        { repetition: 0, exitStatus: 1, failure: "fixture service failed" },
        { repetition: 1, exitStatus: 0, failure: undefined },
    ]);
    expect(report.summaries.find((summary) => summary.phase === "warm-service")).toMatchObject({
        samples: 2,
        nonzeroExitStatuses: [1],
    });
});

// Regression test: executable smoke 2026-09-08 — Bun subprocess resource counters must remain JSON serializable.
test("serializes measurements captured from a real subprocess", async () => {
    const report = await runBenchmarkMatrix({
        variants: [
            {
                name: "baseline",
                async open() {
                    return {
                        async execute(operation) {
                            return resultFor(operation);
                        },
                    };
                },
                command() {
                    return {
                        argv: ["/usr/bin/true"],
                        cwd: "/tmp",
                        env: { HOME: "/tmp", GENESIS_TOOLS_HOME: "/tmp" },
                    };
                },
            },
        ],
        operations: ["metadata-list"],
        warmRepetitions: 1,
        coldRepetitions: 0,
        includeCli: true,
        cacheRoot: "/tmp/benchmark-cache",
    });

    expect(() => SafeJSON.stringify(report, { strict: true })).not.toThrow();
    expect(report.measurements.every((measurement) => measurement.peakRssBytes < 1_000_000_000)).toBe(true);
});

test("prewarms each CLI operation in a cache separate from service measurements", async () => {
    const commandContexts: Array<{ cachePath: string; prewarm: boolean }> = [];
    const report = await runBenchmarkMatrix({
        variants: [
            {
                name: "baseline",
                async open() {
                    return {
                        async execute(operation) {
                            return resultFor(operation);
                        },
                    };
                },
                command(context) {
                    commandContexts.push({ cachePath: context.cachePath, prewarm: context.prewarm });
                    return {
                        argv: ["fixture"],
                        cwd: "/owned",
                        env: { HOME: "/owned/home", GENESIS_TOOLS_HOME: "/owned/home" },
                    };
                },
            },
        ],
        operations: ["content-common"],
        warmRepetitions: 1,
        coldRepetitions: 0,
        includeCli: true,
        cacheRoot: "/owned/cache",
        async runCommand() {
            return { exitStatus: 0, userCpuMs: 0, systemCpuMs: 0, peakRssBytes: 0 };
        },
    });

    expect(commandContexts).toEqual([
        { cachePath: "/owned/cache/warm-cli/content-common/baseline", prewarm: true },
        { cachePath: "/owned/cache/warm-cli/content-common/baseline", prewarm: false },
    ]);
    expect(report.prewarm).toEqual([
        {
            variant: "baseline",
            operation: "content-common",
            exitStatus: 0,
            failure: undefined,
        },
    ]);
});
