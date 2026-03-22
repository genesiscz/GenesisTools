import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Mirror the BenchmarkResult interface from benchmark.ts
interface BenchmarkResult {
    timestamp: string;
    target: string;
    indexName: string;
    phases: {
        scanAndChunkMs: number;
        embedMs: number;
        totalMs: number;
    };
    counts: {
        filesScanned: number;
        chunksCreated: number;
        embeddingsGenerated: number;
    };
    throughput: {
        chunksPerSec: number;
        embeddingsPerSec: number;
    };
    search: {
        queries: string[];
        latencies: number[];
        avgLatencyMs: number;
    };
    dbSizeBytes: number;
    provider: string;
    model: string;
}

// Standard queries used by the benchmark command (from benchmark.ts BENCHMARK_QUERIES const)
const BENCHMARK_QUERIES = [
    "function that handles authentication",
    "error handling and retry logic",
    "database connection setup",
    "import statements and dependencies",
    "configuration and environment variables",
];

const BENCHMARKS_DIR = resolve(join(import.meta.dir, "../../../.claude/benchmarks"));

function loadBenchmarkFile(name: string): BenchmarkResult {
    const filePath = join(BENCHMARKS_DIR, name);
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as BenchmarkResult;
}

/** Shared schema and consistency checks reused for each benchmark file */
function describeSharedBenchmarkChecks(filename: string): void {
    const result = loadBenchmarkFile(filename);

    describe("schema — required top-level fields", () => {
        it("has a timestamp string", () => {
            expect(typeof result.timestamp).toBe("string");
            expect(result.timestamp.length).toBeGreaterThan(0);
        });

        it("has a target string", () => {
            expect(typeof result.target).toBe("string");
            expect(result.target.length).toBeGreaterThan(0);
        });

        it("has an indexName string", () => {
            expect(typeof result.indexName).toBe("string");
            expect(result.indexName.length).toBeGreaterThan(0);
        });

        it("has a phases object with numeric fields", () => {
            expect(typeof result.phases).toBe("object");
            expect(result.phases).not.toBeNull();
            expect(typeof result.phases.scanAndChunkMs).toBe("number");
            expect(typeof result.phases.embedMs).toBe("number");
            expect(typeof result.phases.totalMs).toBe("number");
        });

        it("has a counts object with numeric fields", () => {
            expect(typeof result.counts).toBe("object");
            expect(result.counts).not.toBeNull();
            expect(typeof result.counts.filesScanned).toBe("number");
            expect(typeof result.counts.chunksCreated).toBe("number");
            expect(typeof result.counts.embeddingsGenerated).toBe("number");
        });

        it("has a throughput object with numeric fields", () => {
            expect(typeof result.throughput).toBe("object");
            expect(result.throughput).not.toBeNull();
            expect(typeof result.throughput.chunksPerSec).toBe("number");
            expect(typeof result.throughput.embeddingsPerSec).toBe("number");
        });

        it("has a search object with arrays and avgLatencyMs", () => {
            expect(typeof result.search).toBe("object");
            expect(result.search).not.toBeNull();
            expect(Array.isArray(result.search.queries)).toBe(true);
            expect(Array.isArray(result.search.latencies)).toBe(true);
            expect(typeof result.search.avgLatencyMs).toBe("number");
        });

        it("has numeric dbSizeBytes", () => {
            expect(typeof result.dbSizeBytes).toBe("number");
        });

        it("has provider and model strings", () => {
            expect(typeof result.provider).toBe("string");
            expect(result.provider.length).toBeGreaterThan(0);
            expect(typeof result.model).toBe("string");
            expect(result.model.length).toBeGreaterThan(0);
        });
    });

    describe("timestamp", () => {
        it("is a valid ISO 8601 date", () => {
            const d = new Date(result.timestamp);
            expect(isNaN(d.getTime())).toBe(false);
        });

        it("is not in the far future", () => {
            const d = new Date(result.timestamp);
            expect(d.getTime()).toBeLessThan(Date.now() + 365 * 24 * 60 * 60 * 1000);
        });
    });

    describe("phases — timing data integrity", () => {
        it("scanAndChunkMs is a non-negative integer", () => {
            expect(result.phases.scanAndChunkMs).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(result.phases.scanAndChunkMs)).toBe(true);
        });

        it("embedMs is a non-negative integer", () => {
            expect(result.phases.embedMs).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(result.phases.embedMs)).toBe(true);
        });

        it("totalMs is a positive integer", () => {
            expect(result.phases.totalMs).toBeGreaterThan(0);
            expect(Number.isInteger(result.phases.totalMs)).toBe(true);
        });

        it("totalMs approximately equals scanAndChunkMs + embedMs (within 1%)", () => {
            const expected = result.phases.scanAndChunkMs + result.phases.embedMs;
            const actual = result.phases.totalMs;
            const tolerance = Math.max(expected * 0.01, 100);
            expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
        });

        it("component phases do not exceed totalMs", () => {
            expect(result.phases.embedMs).toBeLessThanOrEqual(result.phases.totalMs);
            expect(result.phases.scanAndChunkMs).toBeLessThanOrEqual(result.phases.totalMs);
        });
    });

    describe("counts — indexing statistics", () => {
        it("filesScanned is a positive integer", () => {
            expect(result.counts.filesScanned).toBeGreaterThan(0);
            expect(Number.isInteger(result.counts.filesScanned)).toBe(true);
        });

        it("chunksCreated is a positive integer", () => {
            expect(result.counts.chunksCreated).toBeGreaterThan(0);
            expect(Number.isInteger(result.counts.chunksCreated)).toBe(true);
        });

        it("embeddingsGenerated is a non-negative integer", () => {
            expect(result.counts.embeddingsGenerated).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(result.counts.embeddingsGenerated)).toBe(true);
        });

        it("embeddingsGenerated does not exceed chunksCreated", () => {
            expect(result.counts.embeddingsGenerated).toBeLessThanOrEqual(result.counts.chunksCreated);
        });

        it("chunksCreated is at least as large as filesScanned", () => {
            expect(result.counts.chunksCreated).toBeGreaterThanOrEqual(result.counts.filesScanned);
        });
    });

    describe("throughput — performance metrics", () => {
        it("chunksPerSec is a positive integer", () => {
            expect(result.throughput.chunksPerSec).toBeGreaterThan(0);
            expect(Number.isInteger(result.throughput.chunksPerSec)).toBe(true);
        });

        it("embeddingsPerSec is a positive integer", () => {
            expect(result.throughput.embeddingsPerSec).toBeGreaterThan(0);
            expect(Number.isInteger(result.throughput.embeddingsPerSec)).toBe(true);
        });

        it("chunksPerSec is consistent with counts and scan phase timing (within 10%)", () => {
            const scanMs = result.phases.scanAndChunkMs;
            if (scanMs > 0) {
                const computed = Math.round((result.counts.chunksCreated / scanMs) * 1000);
                const ratio = result.throughput.chunksPerSec / computed;
                expect(ratio).toBeGreaterThan(0.9);
                expect(ratio).toBeLessThan(1.1);
            }
        });

        it("embeddingsPerSec is consistent with counts and embed phase timing (within 10%)", () => {
            const embedMs = result.phases.embedMs;
            if (embedMs > 0 && result.counts.embeddingsGenerated > 0) {
                const computed = Math.round((result.counts.embeddingsGenerated / embedMs) * 1000);
                const ratio = result.throughput.embeddingsPerSec / computed;
                expect(ratio).toBeGreaterThan(0.9);
                expect(ratio).toBeLessThan(1.1);
            }
        });
    });

    describe("search — query benchmarks", () => {
        it("uses the standard BENCHMARK_QUERIES", () => {
            expect(result.search.queries).toEqual(BENCHMARK_QUERIES);
        });

        it("has exactly 5 queries", () => {
            expect(result.search.queries.length).toBe(BENCHMARK_QUERIES.length);
        });

        it("latencies array length matches queries array length", () => {
            expect(result.search.latencies.length).toBe(result.search.queries.length);
        });

        it("all latencies are positive numbers", () => {
            for (const lat of result.search.latencies) {
                expect(typeof lat).toBe("number");
                expect(lat).toBeGreaterThan(0);
            }
        });

        it("avgLatencyMs is positive", () => {
            expect(result.search.avgLatencyMs).toBeGreaterThan(0);
        });

        it("avgLatencyMs matches arithmetic mean of latencies (within ±0.1ms)", () => {
            const sum = result.search.latencies.reduce((a, b) => a + b, 0);
            const computed = Math.round((sum / result.search.latencies.length) * 100) / 100;
            expect(Math.abs(result.search.avgLatencyMs - computed)).toBeLessThan(0.1);
        });
    });

    describe("dbSizeBytes", () => {
        it("is a positive integer", () => {
            expect(result.dbSizeBytes).toBeGreaterThan(0);
            expect(Number.isInteger(result.dbSizeBytes)).toBe(true);
        });

        it("is a multiple of 4096 (SQLite page-size alignment)", () => {
            expect(result.dbSizeBytes % 4096).toBe(0);
        });
    });

    describe("indexName format", () => {
        it("starts with 'bench_'", () => {
            expect(result.indexName).toMatch(/^bench_/);
        });

        it("has a numeric timestamp suffix", () => {
            const match = result.indexName.match(/^bench_(\d+)$/);
            expect(match).not.toBeNull();
            if (match) {
                expect(parseInt(match[1], 10)).toBeGreaterThan(0);
            }
        });
    });
}

// ─── File existence ────────────────────────────────────────────────────────────

describe(".claude/benchmarks directory", () => {
    it("directory exists", () => {
        expect(existsSync(BENCHMARKS_DIR)).toBe(true);
    });

    it("genesis-tools.json exists", () => {
        expect(existsSync(join(BENCHMARKS_DIR, "genesis-tools.json"))).toBe(true);
    });

    it("reservine-front.json exists", () => {
        expect(existsSync(join(BENCHMARKS_DIR, "reservine-front.json"))).toBe(true);
    });
});

// ─── genesis-tools.json ───────────────────────────────────────────────────────

describe("genesis-tools.json — shared schema checks", () => {
    describeSharedBenchmarkChecks("genesis-tools.json");
});

describe("genesis-tools.json — specific data values", () => {
    const result = loadBenchmarkFile("genesis-tools.json");

    it("target contains GenesisTools", () => {
        expect(result.target).toContain("GenesisTools");
    });

    it("indexed 956 files", () => {
        expect(result.counts.filesScanned).toBe(956);
    });

    it("created 9713 chunks", () => {
        expect(result.counts.chunksCreated).toBe(9713);
    });

    it("generated 9401 embeddings", () => {
        expect(result.counts.embeddingsGenerated).toBe(9401);
    });

    it("avg search latency is 32.2ms", () => {
        expect(result.search.avgLatencyMs).toBe(32.2);
    });

    it("db size is 51732480 bytes (~49.3 MB)", () => {
        expect(result.dbSizeBytes).toBe(51732480);
    });

    it("provider is darwinkit", () => {
        expect(result.provider).toBe("darwinkit");
    });

    it("model is default", () => {
        expect(result.model).toBe("default");
    });

    it("first search latency (cold query) is higher than subsequent latencies", () => {
        expect(result.search.latencies[0]).toBeGreaterThan(result.search.latencies[1]);
    });

    it("scan phase took under 5 seconds", () => {
        expect(result.phases.scanAndChunkMs).toBeLessThan(5000);
    });
});

// ─── reservine-front.json ─────────────────────────────────────────────────────

describe("reservine-front.json — shared schema checks", () => {
    describeSharedBenchmarkChecks("reservine-front.json");
});

describe("reservine-front.json — specific data values", () => {
    const result = loadBenchmarkFile("reservine-front.json");

    it("target contains ReservineFront", () => {
        expect(result.target).toContain("ReservineFront");
    });

    it("indexed 2306 files", () => {
        expect(result.counts.filesScanned).toBe(2306);
    });

    it("created 19171 chunks", () => {
        expect(result.counts.chunksCreated).toBe(19171);
    });

    it("generated 18707 embeddings", () => {
        expect(result.counts.embeddingsGenerated).toBe(18707);
    });

    it("avg search latency is 50.45ms", () => {
        expect(result.search.avgLatencyMs).toBe(50.45);
    });

    it("db size is 122859520 bytes (~117.2 MB)", () => {
        expect(result.dbSizeBytes).toBe(122859520);
    });

    it("provider is darwinkit", () => {
        expect(result.provider).toBe("darwinkit");
    });

    it("model is default", () => {
        expect(result.model).toBe("default");
    });

    it("first search latency (cold query) is higher than subsequent latencies", () => {
        expect(result.search.latencies[0]).toBeGreaterThan(result.search.latencies[1]);
    });

    it("scan phase took under 10 seconds", () => {
        expect(result.phases.scanAndChunkMs).toBeLessThan(10000);
    });
});

// ─── Cross-benchmark comparisons ─────────────────────────────────────────────

describe("cross-benchmark comparisons", () => {
    const genesis = loadBenchmarkFile("genesis-tools.json");
    const reservine = loadBenchmarkFile("reservine-front.json");

    it("reservine has more files scanned than genesis", () => {
        expect(reservine.counts.filesScanned).toBeGreaterThan(genesis.counts.filesScanned);
    });

    it("reservine has more chunks created than genesis", () => {
        expect(reservine.counts.chunksCreated).toBeGreaterThan(genesis.counts.chunksCreated);
    });

    it("reservine db is larger than genesis db", () => {
        expect(reservine.dbSizeBytes).toBeGreaterThan(genesis.dbSizeBytes);
    });

    it("reservine has higher avg search latency (proportionally more data)", () => {
        expect(reservine.search.avgLatencyMs).toBeGreaterThan(genesis.search.avgLatencyMs);
    });

    it("both benchmarks use the same provider", () => {
        expect(genesis.provider).toBe(reservine.provider);
    });

    it("both benchmarks use the same model", () => {
        expect(genesis.model).toBe(reservine.model);
    });

    it("both benchmarks use identical search queries", () => {
        expect(genesis.search.queries).toEqual(reservine.search.queries);
    });

    it("reservine was run after genesis (timestamps in chronological order)", () => {
        const genesisTime = new Date(genesis.timestamp).getTime();
        const reservineTime = new Date(reservine.timestamp).getTime();
        expect(reservineTime).toBeGreaterThan(genesisTime);
    });

    it("genesis embedding rate is higher than reservine (smaller project, fewer batches)", () => {
        // Smaller project = more CPU-cache-friendly = slightly higher throughput
        // This is a soft assertion — both ran with darwinkit, genesis is smaller
        expect(genesis.throughput.embeddingsPerSec).toBeGreaterThan(reservine.throughput.embeddingsPerSec);
    });

    it("both have the same number of search latency samples", () => {
        expect(genesis.search.latencies.length).toBe(reservine.search.latencies.length);
    });
});