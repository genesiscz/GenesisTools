#!/usr/bin/env bun
/**
 * Measurements for Report 13 performance opportunities P01-P04.
 *
 * Every worker gets an isolated synthetic vault, an invented key and no network/keychain.
 * Separate processes keep RSS and CPU counters from one arm contaminating another.
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetMcpFetchForTest, _setMcpFetchForTest, mcpFetch, readJsonRecord } from "@app/mcp-manager/lib/auth/fetch";
import {
    readAccessToken,
    readExpiresAt,
    readRefreshToken,
    readServerTokenSnapshot,
} from "@app/mcp-manager/lib/auth/secrets";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import {
    _resetMasterKeyProviders,
    _setMasterKeyProvidersForTest,
    masterKeyId,
} from "@genesiscz/utils/security/MasterKey";
import {
    _resetSecretsForTest,
    _setSecretStoreOperationObserverForTest,
    encryptEntry,
    resolveSecretSync,
    secretSnapshotResolver,
    secrets,
    secureRef,
    vaultAdmin,
} from "@genesiscz/utils/security/SecretStore";
import { emptyVault } from "@genesiscz/utils/security/vault-format";
import { formatTable } from "@genesiscz/utils/table";
import { Command } from "commander";

const WORKER_ARG = "--worker";
const SCRATCH_ROOT = join(
    tmpdir(),
    "cc",
    "GenesisTools",
    "finish-sol-report-fixes-credentials",
    "r13-credential-costs"
);
const KEY = Buffer.alloc(32, 0x3a);

type Arm =
    | "p01-repeated"
    | "p01-snapshot"
    | "p02-individual"
    | "p02-snapshot"
    | "p03-eager"
    | "p03-lazy"
    | "p04-unbounded"
    | "p04-bounded";

interface WorkerResult {
    arm: Arm;
    cpuMs: number;
    wallMs: number;
    rssBytes: number;
    rssDeltaBytes: number;
    operations: number;
    bytesConsumed?: number;
    deadlineSignal?: number;
    vaultReads: number;
    vaultParses: number;
    decryptions: number;
    encryptions: number;
    digest: string;
}

interface WorkerOptions {
    arm: Arm;
    entries: number;
    fields: number;
    iterations: number;
    bodyBytes: number;
}

function digest(value: unknown): string {
    return createHash("sha256").update(SafeJSON.stringify(value)).digest("hex").slice(0, 16);
}

function fakeKeyring() {
    return [
        {
            id: "keychain" as const,
            available: async () => true,
            get: async () => KEY,
            getSync: () => KEY,
            set: async () => {},
        },
    ];
}

function prepareVault(entries: Record<string, string>): void {
    mkdirSync(SCRATCH_ROOT, { recursive: true });
    const root = join(SCRATCH_ROOT, `${process.pid}-${crypto.randomUUID()}`);
    env.testing.set("GENESIS_TOOLS_HOME", root);
    _setMasterKeyProvidersForTest(fakeKeyring());
    _resetSecretsForTest();
    const vault = emptyVault();
    vault.keyId = masterKeyId(KEY);

    for (const [path, value] of Object.entries(entries)) {
        vault.entries[path] = encryptEntry(KEY, path, value);
    }

    vaultAdmin.write(vault);
}

async function measureWorker<T>(arm: Arm, operations: number, fn: () => Promise<T>): Promise<WorkerResult> {
    const counts = { vaultReads: 0, vaultParses: 0, decryptions: 0, encryptions: 0 };
    _setSecretStoreOperationObserverForTest((operation) => {
        if (operation === "vault-read") {
            counts.vaultReads += 1;
        } else if (operation === "vault-parse") {
            counts.vaultParses += 1;
        } else if (operation === "decrypt") {
            counts.decryptions += 1;
        } else {
            counts.encryptions += 1;
        }
    });
    const rssBefore = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const wallBefore = performance.now();
    const value = await fn();
    const wallMs = performance.now() - wallBefore;
    const cpu = process.cpuUsage(cpuBefore);
    const rssBytes = process.memoryUsage().rss;

    return {
        arm,
        cpuMs: (cpu.user + cpu.system) / 1000,
        wallMs,
        rssBytes,
        rssDeltaBytes: rssBytes - rssBefore,
        operations,
        ...counts,
        digest: digest(value),
    };
}

function credentialEntries(entries: number, fields: number): { vault: Record<string, string>; paths: string[] } {
    const vault: Record<string, string> = {};
    const paths: string[] = [];

    for (let account = 0; account < entries; account++) {
        for (let field = 0; field < fields; field++) {
            const path = `ai/acc_fixture_${account}/field_${field}`;
            vault[path] = `invented-value-${account}-${field}-${"x".repeat(24)}`;
            paths.push(path);
        }
    }

    return { vault, paths };
}

async function runP01(options: WorkerOptions): Promise<WorkerResult> {
    const fixture = credentialEntries(options.entries, options.fields);
    prepareVault(fixture.vault);
    const refs = fixture.paths.map((path) => secureRef(path));
    const operations = refs.length * options.iterations;

    if (options.arm === "p01-repeated") {
        return measureWorker(options.arm, operations, async () => {
            const output: Array<Array<string | undefined>> = [];
            for (let iteration = 0; iteration < options.iterations; iteration++) {
                output.push(refs.map((ref) => resolveSecretSync(ref)));
            }
            return output;
        });
    }

    return measureWorker(options.arm, operations, async () => {
        const output: Array<Array<string | undefined>> = [];
        for (let iteration = 0; iteration < options.iterations; iteration++) {
            const resolve = secretSnapshotResolver();
            output.push(refs.map((ref) => resolve(ref)));
        }
        return output;
    });
}

function mcpFixture(unrelated: number): Record<string, string> {
    const entries = credentialEntries(unrelated, 1).vault;
    entries["mcp/fixture/access-token"] = "invented-access";
    entries["mcp/fixture/refresh-token"] = "invented-refresh";
    entries["mcp/fixture/token-expires-at"] = String(1_900_000_000_000);
    entries["mcp/fixture/client-id"] = "invented-client";
    entries["mcp/fixture/client-secret"] = "invented-client-secret";
    return entries;
}

async function runP02(options: WorkerOptions): Promise<WorkerResult> {
    prepareVault(mcpFixture(options.entries));
    const operations = options.iterations;

    if (options.arm === "p02-individual") {
        return measureWorker(options.arm, operations, async () => {
            const output = [];
            for (let iteration = 0; iteration < options.iterations; iteration++) {
                output.push({
                    accessToken: await readAccessToken("fixture"),
                    expiresAt: await readExpiresAt("fixture"),
                    hasRefresh: Boolean(await readRefreshToken("fixture")),
                });
            }
            return output;
        });
    }

    return measureWorker(options.arm, operations, async () => {
        const output = [];
        for (let iteration = 0; iteration < options.iterations; iteration++) {
            const snapshot = await readServerTokenSnapshot("fixture");
            output.push({
                accessToken: snapshot.accessToken,
                expiresAt: snapshot.expiresAt,
                hasRefresh: snapshot.hasRefresh,
            });
        }
        return output;
    });
}

async function runP03(options: WorkerOptions): Promise<WorkerResult> {
    const fixture = credentialEntries(options.entries, 1);
    prepareVault(fixture.vault);
    const store = await secrets();
    const operations = fixture.paths.length * options.iterations;

    return measureWorker(options.arm, operations, async () => {
        for (let iteration = 0; iteration < options.iterations; iteration++) {
            for (const path of fixture.paths) {
                const value = fixture.vault[path];

                if (options.arm === "p03-eager") {
                    // The reviewed implementation performed this encryption before the
                    // unchanged-value check, then discarded the ciphertext.
                    encryptEntry(KEY, path, value);
                }

                await store.set(path, value);
            }
        }

        return store.list();
    });
}

function byteStream(totalBytes: number, onBytes: (bytes: number) => void): ReadableStream<Uint8Array> {
    const chunkBytes = 64 * 1024;
    let sent = 0;

    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (sent >= totalBytes) {
                controller.close();
                return;
            }

            const bytes = Math.min(chunkBytes, totalBytes - sent);
            sent += bytes;
            onBytes(bytes);
            controller.enqueue(new Uint8Array(bytes));
        },
    });
}

async function runP04(options: WorkerOptions): Promise<WorkerResult> {
    let bytesConsumed = 0;
    let deadlineSignal = 0;
    const response = new Response(byteStream(options.bodyBytes, (bytes) => (bytesConsumed += bytes)));
    const measured = await measureWorker(options.arm, 1, async () => {
        if (options.arm === "p04-unbounded") {
            await response.text();
        } else {
            await readJsonRecord(response).catch((err: unknown) => {
                if (!(err instanceof Error && err.message.includes("MCP auth response limit"))) {
                    throw err;
                }
            });
        }

        _setMcpFetchForTest(async (_input, init) => {
            deadlineSignal = init?.signal instanceof AbortSignal ? 1 : 0;
            return Response.json({ ok: true });
        });
        await mcpFetch("https://identity.example/token", { method: "POST" });
        _resetMcpFetchForTest();
        return { bytesConsumed, deadlineSignal };
    });

    return { ...measured, bytesConsumed, deadlineSignal };
}

async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
    try {
        if (options.arm.startsWith("p01-")) {
            return await runP01(options);
        }
        if (options.arm.startsWith("p02-")) {
            return await runP02(options);
        }
        if (options.arm.startsWith("p03-")) {
            return await runP03(options);
        }
        return await runP04(options);
    } finally {
        _setSecretStoreOperationObserverForTest(undefined);
        _resetMcpFetchForTest();
        _resetMasterKeyProviders();
        _resetSecretsForTest();
    }
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function spawnWorker(options: WorkerOptions): Promise<WorkerResult> {
    const proc = Bun.spawn(
        [
            process.execPath,
            import.meta.path,
            WORKER_ARG,
            options.arm,
            String(options.entries),
            String(options.fields),
            String(options.iterations),
            String(options.bodyBytes),
        ],
        { stdout: "pipe", stderr: "pipe", env: process.env }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (exitCode !== 0) {
        throw new Error(`R13 benchmark worker ${options.arm} failed (${exitCode}): ${stderr}`);
    }

    return SafeJSON.parse(stdout, { strict: true }) as WorkerResult;
}

function mib(bytes: number): number {
    return Number((bytes / 1024 / 1024).toFixed(2));
}

if (process.argv[2] === WORKER_ARG) {
    const options: WorkerOptions = {
        arm: process.argv[3] as Arm,
        entries: Number(process.argv[4]),
        fields: Number(process.argv[5]),
        iterations: Number(process.argv[6]),
        bodyBytes: Number(process.argv[7]),
    };
    process.stdout.write(SafeJSON.stringify(await runWorker(options)));
    process.exit(0);
}

const program = new Command()
    .name("r13-credential-costs")
    .option("--runs <n>", "Measured worker processes per arm", "3")
    .option("--json", "Emit machine-readable medians on stdout");
await program.parseAsync(process.argv);
const flags = program.opts<{ runs: string; json?: boolean }>();
const runs = Math.max(1, Number.parseInt(flags.runs, 10) || 3);
const arms: WorkerOptions[] = [
    { arm: "p01-repeated", entries: 100, fields: 2, iterations: 10, bodyBytes: 0 },
    { arm: "p01-snapshot", entries: 100, fields: 2, iterations: 10, bodyBytes: 0 },
    { arm: "p02-individual", entries: 1000, fields: 1, iterations: 100, bodyBytes: 0 },
    { arm: "p02-snapshot", entries: 1000, fields: 1, iterations: 100, bodyBytes: 0 },
    { arm: "p03-eager", entries: 100, fields: 1, iterations: 5, bodyBytes: 0 },
    { arm: "p03-lazy", entries: 100, fields: 1, iterations: 5, bodyBytes: 0 },
    { arm: "p04-unbounded", entries: 0, fields: 0, iterations: 1, bodyBytes: 4 * 1024 * 1024 },
    { arm: "p04-bounded", entries: 0, fields: 0, iterations: 1, bodyBytes: 4 * 1024 * 1024 },
];
const samples = new Map<Arm, WorkerResult[]>();

for (const options of arms) {
    const results: WorkerResult[] = [];
    for (let run = 0; run < runs; run++) {
        out.log.info(`${options.arm} — worker ${run + 1}/${runs}`);
        results.push(await spawnWorker(options));
    }
    samples.set(options.arm, results);
}

const medians = Object.fromEntries(
    arms.map(({ arm }) => {
        const rows = samples.get(arm) ?? [];
        return [
            arm,
            {
                cpuMs: median(rows.map((row) => row.cpuMs)),
                wallMs: median(rows.map((row) => row.wallMs)),
                rssMiB: median(rows.map((row) => mib(row.rssBytes))),
                rssDeltaMiB: median(rows.map((row) => mib(row.rssDeltaBytes))),
                operations: rows[0]?.operations ?? 0,
                bytesConsumed: median(rows.map((row) => row.bytesConsumed ?? 0)),
                deadlineSignal: median(rows.map((row) => row.deadlineSignal ?? 0)),
                vaultReads: median(rows.map((row) => row.vaultReads)),
                vaultParses: median(rows.map((row) => row.vaultParses)),
                decryptions: median(rows.map((row) => row.decryptions)),
                encryptions: median(rows.map((row) => row.encryptions)),
                digest: rows[0]?.digest ?? "",
            },
        ];
    })
) as Record<
    Arm,
    {
        cpuMs: number;
        wallMs: number;
        rssMiB: number;
        rssDeltaMiB: number;
        operations: number;
        bytesConsumed: number;
        deadlineSignal: number;
        vaultReads: number;
        vaultParses: number;
        decryptions: number;
        encryptions: number;
        digest: string;
    }
>;

for (const [before, after] of [
    ["p01-repeated", "p01-snapshot"],
    ["p02-individual", "p02-snapshot"],
    ["p03-eager", "p03-lazy"],
] as const) {
    if (medians[before].digest !== medians[after].digest) {
        throw new Error(`${before}/${after} output mismatch`);
    }
}

const table = arms.map(({ arm }) => {
    const row = medians[arm];
    return [
        arm,
        String(row.operations),
        row.cpuMs.toFixed(2),
        row.wallMs.toFixed(2),
        row.rssMiB.toFixed(2),
        row.rssDeltaMiB.toFixed(2),
        String(row.bytesConsumed),
        String(row.deadlineSignal),
        String(row.vaultReads),
        String(row.vaultParses),
        String(row.decryptions),
        String(row.encryptions),
    ];
});
out.println("\nR13 credential performance measurements");
out.println("Synthetic vault/key/response only; separate worker process per sample; median shown.");
out.println(
    formatTable(
        table,
        [
            "ARM",
            "OPS",
            "CPU MS",
            "WALL MS",
            "RSS MIB",
            "RSS Δ MIB",
            "BYTES",
            "DEADLINE",
            "READS",
            "PARSES",
            "DECRYPT",
            "ENCRYPT",
        ],
        { alignRight: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] }
    )
);

if (flags.json) {
    out.result(SafeJSON.stringify({ runs, medians }, null, 4));
}
