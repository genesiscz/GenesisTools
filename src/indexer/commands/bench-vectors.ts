import type { Command } from "commander";
import pc from "picocolors";

interface BenchmarkResult {
    backend: string;
    insertTimeMs: number;
    searchTimeMs: number;
    searchesPerSecond: number;
    totalVectors: number;
    dimensions: number;
    memoryMB: number;
}

export function registerBenchVectorsCommand(program: Command): void {
    program
        .command("bench-vectors")
        .description("Micro-benchmark: compare vector search backends (sqlite-vec vs brute-force)")
        .option("--vectors <n>", "Number of vectors to index", "10000")
        .option("--dimensions <n>", "Vector dimensions", "768")
        .option("--queries <n>", "Number of search queries", "100")
        .option("--limit <n>", "Results per query (k)", "10")
        .option("--backends <list>", "Comma-separated backends to benchmark", "sqlite-vec,sqlite-brute")
        .action(async (opts) => {
            const { mkdtempSync, rmSync } = await import("node:fs");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");

            // Must be called before any Database instance is created
            const { ensureExtensionCapableSQLite } = await import(
                "@app/utils/search/stores/sqlite-vec-loader"
            );
            ensureExtensionCapableSQLite();

            const { Database } = await import("bun:sqlite");

            const numVectors = parseInt(opts.vectors, 10);
            const dimensions = parseInt(opts.dimensions, 10);
            const numQueries = parseInt(opts.queries, 10);
            const limit = parseInt(opts.limit, 10);

            for (const [name, value] of [
                ["vectors", numVectors],
                ["dimensions", dimensions],
                ["queries", numQueries],
                ["limit", limit],
            ] as const) {
                if (Number.isNaN(value) || value <= 0) {
                    console.error(pc.red(`Invalid --${name}: must be a positive integer`));
                    process.exit(1);
                }
            }

            const backends = (opts.backends as string).split(",").map((b: string) => b.trim());

            console.log(pc.bold("\nVector Search Benchmark"));
            console.log(`  Vectors: ${numVectors.toLocaleString()}`);
            console.log(`  Dimensions: ${dimensions}`);
            console.log(`  Queries: ${numQueries}`);
            console.log(`  k (limit): ${limit}`);
            console.log(`  Backends: ${backends.join(", ")}\n`);

            // Generate random normalized vectors
            console.log("Generating random vectors...");
            const vectors = generateRandomVectors(numVectors, dimensions);
            const queryVectors = generateRandomVectors(numQueries, dimensions);

            const results: BenchmarkResult[] = [];

            for (const backend of backends) {
                console.log(pc.cyan(`\nBenchmarking: ${backend}`));
                const tmpDir = mkdtempSync(join(tmpdir(), `bench-${backend}-`));

                try {
                    const store = await createStore({ backend, tmpDir, dimensions, DatabaseClass: Database });

                    // Benchmark inserts
                    const insertStart = performance.now();

                    for (let i = 0; i < vectors.length; i++) {
                        store.store(String(i), vectors[i]);
                    }

                    const insertTimeMs = performance.now() - insertStart;

                    // Benchmark searches
                    const searchTimes: number[] = [];

                    for (const qVec of queryVectors) {
                        const searchStart = performance.now();
                        store.search(qVec, limit);
                        searchTimes.push(performance.now() - searchStart);
                    }

                    const avgSearchMs = searchTimes.reduce((a, b) => a + b, 0) / searchTimes.length;
                    const memUsage = process.memoryUsage();

                    const result: BenchmarkResult = {
                        backend,
                        insertTimeMs,
                        searchTimeMs: avgSearchMs,
                        searchesPerSecond: 1000 / avgSearchMs,
                        totalVectors: vectors.length,
                        dimensions,
                        memoryMB: memUsage.heapUsed / 1024 / 1024,
                    };

                    results.push(result);

                    console.log(
                        `  Insert: ${result.insertTimeMs.toFixed(0)}ms | ` +
                            `Search avg: ${result.searchTimeMs.toFixed(2)}ms | ` +
                            `${result.searchesPerSecond.toFixed(0)} q/s`,
                    );
                } catch (err) {
                    console.log(pc.red(`  FAILED: ${err}`));
                } finally {
                    rmSync(tmpDir, { recursive: true, force: true });
                }
            }

            printResultsTable(results);
        });
}

function generateRandomVectors(count: number, dims: number): Float32Array[] {
    const vecs: Float32Array[] = [];

    for (let i = 0; i < count; i++) {
        const vec = new Float32Array(dims);

        for (let j = 0; j < dims; j++) {
            vec[j] = Math.random() * 2 - 1;
        }

        // Normalize
        let norm = 0;

        for (let j = 0; j < dims; j++) {
            norm += vec[j] * vec[j];
        }

        norm = Math.sqrt(norm);

        if (norm > 0) {
            for (let j = 0; j < dims; j++) {
                vec[j] /= norm;
            }
        }

        vecs.push(vec);
    }

    return vecs;
}

interface CreateStoreOptions {
    backend: string;
    tmpDir: string;
    dimensions: number;
    DatabaseClass: typeof import("bun:sqlite").Database;
}

async function createStore(opts: CreateStoreOptions): Promise<import("@app/utils/search/stores/vector-store").VectorStore> {
    const { backend, tmpDir, dimensions, DatabaseClass } = opts;
    const { join } = await import("node:path");
    const dbPath = join(tmpDir, "bench.db");

    switch (backend) {
        case "sqlite-brute": {
            const { SqliteVectorStore } = await import("@app/utils/search/stores/sqlite-vector-store");
            const db = new DatabaseClass(dbPath);
            db.run("PRAGMA journal_mode = WAL");
            return new SqliteVectorStore(db, { tableName: "bench", dimensions });
        }

        case "sqlite-vec": {
            const { loadSqliteVec } = await import("@app/utils/search/stores/sqlite-vec-loader");
            const db = new DatabaseClass(dbPath);
            const loaded = loadSqliteVec(db);

            if (!loaded) {
                throw new Error(
                    "sqlite-vec extension failed to load. " +
                        "On macOS, install Homebrew sqlite3: brew install sqlite3",
                );
            }

            db.run("PRAGMA journal_mode = WAL");
            const { SqliteVecVectorStore } = await import("@app/utils/search/stores/sqlite-vec-store");
            return new SqliteVecVectorStore(db, { tableName: "bench", dimensions });
        }

        default:
            throw new Error(`Unknown backend: ${backend}. Supported: sqlite-vec, sqlite-brute`);
    }
}

function printResultsTable(results: BenchmarkResult[]): void {
    if (results.length === 0) {
        return;
    }

    console.log(pc.bold("\n\nResults Summary:"));
    console.log("=".repeat(80));
    console.log(
        "Backend".padEnd(16) +
            "Insert (ms)".padStart(14) +
            "Search avg (ms)".padStart(18) +
            "Queries/sec".padStart(14) +
            "Memory (MB)".padStart(14),
    );
    console.log("-".repeat(80));

    for (const r of results) {
        console.log(
            r.backend.padEnd(16) +
                r.insertTimeMs.toFixed(0).padStart(14) +
                r.searchTimeMs.toFixed(2).padStart(18) +
                r.searchesPerSecond.toFixed(0).padStart(14) +
                r.memoryMB.toFixed(1).padStart(14),
        );
    }

    console.log("=".repeat(80));

    // Find fastest search
    const fastest = results.reduce((a, b) => (a.searchTimeMs < b.searchTimeMs ? a : b));

    console.log(pc.green(`\nFastest search: ${fastest.backend} (${fastest.searchTimeMs.toFixed(2)}ms avg)`));

    for (const r of results) {
        if (r.backend !== fastest.backend) {
            const ratio = r.searchTimeMs / fastest.searchTimeMs;
            console.log(pc.dim(`  ${r.backend}: ${ratio.toFixed(1)}x slower`));
        }
    }
}
