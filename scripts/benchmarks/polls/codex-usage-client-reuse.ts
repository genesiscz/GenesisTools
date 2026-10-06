#!/usr/bin/env bun
/**
 * Decision benchmark for R03-P04: should Codex usage polling keep app-server clients alive?
 *
 * The scheduler launches poll-daemon.ts as a fresh child for every scheduled round. This
 * benchmark therefore measures three distinct shapes:
 *
 * 1. current: one synthetic app-server per account, closed by pollCodexAccount;
 * 2. task-local pool: a pool inside each scheduled child, destroyed after that one round;
 * 3. persistent pool: the hypothetical service rewrite required to reuse across rounds.
 *
 * The local child is a protocol substitute, not a provider: no account file, vault, keychain,
 * network, OAuth token or refresh grant is read. It makes Bun process startup, IPC CPU and RSS
 * measurable while pollCodexAccount still maps the real rate-limit result.
 */
import { type BaselineMetrics, sampleProcess } from "@app/benchmark/lib";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import type { UsagePollOptions } from "@genesiscz/utils/ai/providers/account-features";
import { type CodexUsageClient, pollCodexAccount } from "@genesiscz/utils/ai/providers/plugins/openai-sub/usage";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { addCommonOptions, type CommonFlags, runPollBenchmark } from "./harness";

const CHILD_ARG = "--synthetic-app-server";
const SAMPLE_WINDOW_MS = 20;

interface ChildMetrics {
    cpuMs: number;
    rssBytes: number;
}

interface PoolKey {
    accountId: string;
    generation: number;
}

interface PoolClient extends CodexUsageClient {
    readonly pid: number;
    alive(): boolean;
}

interface Counters {
    opens: number;
    initializes: number;
    logins: number;
    reads: number;
    closes: number;
    childCpuMs: number;
    peakResidentBytes: number;
}

interface ArmResult {
    counters: Counters;
    parentCpuMs: number;
    wallMs: number;
    output: string;
    idleResidentBytes: number;
}

function writeChild(value: unknown): void {
    process.stdout.write(`${SafeJSON.stringify(value)}\n`);
}

async function readLines(
    stream: ReadableStream<Uint8Array>,
    onLine: (line: string) => boolean | undefined
): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            buffered += decoder.decode(value, { stream: !done });
            const lines = buffered.split("\n");
            buffered = lines.pop() ?? "";

            for (const line of lines) {
                if (line && onLine(line) === false) {
                    return;
                }
            }

            if (done) {
                if (buffered) {
                    onLine(buffered);
                }

                return;
            }
        }
    } finally {
        reader.releaseLock();
    }
}

async function runSyntheticAppServer(accountId: string): Promise<void> {
    writeChild({ type: "ready", accountId });

    await readLines(Bun.stdin.stream(), (line) => {
        const command = SafeJSON.parse(line, { strict: true }) as { type: string };

        if (command.type === "initialize" || command.type === "login") {
            writeChild({ type: command.type, ok: true });
            return;
        }

        if (command.type === "read") {
            writeChild({
                type: "result",
                result: {
                    rateLimits: {
                        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 },
                        secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
                        planType: "synthetic",
                    },
                },
            });
            return;
        }

        if (command.type === "close") {
            const cpu = process.cpuUsage();
            writeChild({
                type: "closed",
                metrics: {
                    cpuMs: (cpu.user + cpu.system) / 1000,
                    rssBytes: process.memoryUsage().rss,
                },
            });
            return false;
        }

        throw new Error(`Unknown synthetic app-server command: ${command.type}`);
    });
}

class JsonLineReader {
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
    private readonly decoder = new TextDecoder();
    private buffered = "";

    constructor(stream: ReadableStream<Uint8Array>) {
        this.reader = stream.getReader();
    }

    async next<T>(): Promise<T> {
        while (true) {
            const newline = this.buffered.indexOf("\n");
            if (newline >= 0) {
                const line = this.buffered.slice(0, newline);
                this.buffered = this.buffered.slice(newline + 1);
                return SafeJSON.parse(line, { strict: true }) as T;
            }

            const { done, value } = await this.reader.read();
            if (done) {
                throw new Error("synthetic app-server closed before replying");
            }

            this.buffered += this.decoder.decode(value, { stream: true });
        }
    }
}

class SyntheticClient implements PoolClient {
    readonly pid: number;
    private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
    private readonly lines: JsonLineReader;
    private closed = false;
    private queue: Promise<unknown> = Promise.resolve();

    private constructor(
        process: Bun.Subprocess<"pipe", "pipe", "pipe">,
        lines: JsonLineReader,
        private readonly counters: Counters
    ) {
        this.process = process;
        this.lines = lines;
        this.pid = process.pid;
    }

    static async open(account: AccountEntry, counters: Counters): Promise<SyntheticClient> {
        counters.opens += 1;
        const child = Bun.spawn([process.execPath, import.meta.path, CHILD_ARG, account.id], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
            env: process.env,
        });
        const lines = new JsonLineReader(child.stdout);
        const ready = await lines.next<{ type: string; accountId: string }>();
        if (ready.type !== "ready" || ready.accountId !== account.id) {
            child.kill();
            throw new Error(`synthetic app-server bound the wrong identity for ${account.id}`);
        }

        const client = new SyntheticClient(child, lines, counters);
        await client.command("initialize");
        counters.initializes += 1;
        await client.command("login");
        counters.logins += 1;
        return client;
    }

    alive(): boolean {
        return !this.closed && this.process.exitCode === null;
    }

    async request<T>(method: string): Promise<T> {
        if (method !== "account/rateLimits/read") {
            throw new Error(`unexpected benchmark request ${method}`);
        }

        this.counters.reads += 1;
        return this.serial(async () => {
            await this.write({ type: "read" });
            const response = await this.lines.next<{ type: string; result: T }>();
            if (response.type !== "result") {
                throw new Error(`unexpected synthetic response ${response.type}`);
            }

            return response.result;
        });
    }

    async notify(): Promise<void> {}

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }

        this.closed = true;
        await this.write({ type: "close" });
        const response = await this.lines.next<{ type: string; metrics: ChildMetrics }>();
        if (response.type !== "closed") {
            throw new Error(`unexpected synthetic close response ${response.type}`);
        }

        this.counters.childCpuMs += response.metrics.cpuMs;
        this.counters.closes += 1;
        this.process.stdin.end();
        const exitCode = await this.process.exited;
        if (exitCode !== 0) {
            const stderr = await new Response(this.process.stderr).text();
            throw new Error(`synthetic app-server exited ${exitCode}: ${stderr}`);
        }
    }

    private command(type: "initialize" | "login"): Promise<void> {
        return this.serial(async () => {
            await this.write({ type });
            const response = await this.lines.next<{ type: string; ok: boolean }>();
            if (response.type !== type || !response.ok) {
                throw new Error(`synthetic ${type} handshake failed`);
            }
        });
    }

    private async write(value: unknown): Promise<void> {
        this.process.stdin.write(`${SafeJSON.stringify(value)}\n`);
        await this.process.stdin.flush();
    }

    private serial<T>(fn: () => Promise<T>): Promise<T> {
        const next = this.queue.then(fn, fn);
        this.queue = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }
}

interface PoolEntry {
    key: PoolKey;
    client: PoolClient;
    lastUsed: number;
    queue: Promise<unknown>;
}

class PrototypePool {
    private readonly entries = new Map<string, PoolEntry>();
    private readonly pending = new Map<string, Promise<PoolEntry>>();

    constructor(
        private readonly options: {
            maxClients: number;
            idleMs: number;
            now: () => number;
            generation: (account: AccountEntry) => number;
            open: (account: AccountEntry, options: UsagePollOptions) => Promise<PoolClient>;
        }
    ) {}

    async lease(account: AccountEntry, pollOptions: UsagePollOptions): Promise<CodexUsageClient> {
        await this.evictIdle();
        const key = { accountId: account.id, generation: this.options.generation(account) };
        await this.evictOtherGenerations(key);
        let entry = this.entries.get(account.id);

        if (entry && !entry.client.alive()) {
            await this.evict(account.id);
            entry = undefined;
        }

        if (!entry) {
            const pending = this.pending.get(account.id) ?? this.open(account, pollOptions, key);
            this.pending.set(account.id, pending);
            entry = await pending.finally(() => this.pending.delete(account.id));
        }

        entry.lastUsed = this.options.now();
        const client = entry.client;

        return {
            request: async <T>(method: string, params?: unknown) => {
                const run = entry.queue.then(() => client.request<T>(method, params));
                entry.queue = run.then(
                    () => undefined,
                    () => undefined
                );

                try {
                    return await run;
                } catch (err) {
                    await this.evict(account.id);
                    throw err;
                }
            },
            notify: (method, params) => client.notify(method, params),
            close: async () => {
                entry.lastUsed = this.options.now();
            },
        };
    }

    size(): number {
        return this.entries.size;
    }

    clients(): PoolClient[] {
        return [...this.entries.values()].map((entry) => entry.client);
    }

    async closeAll(): Promise<void> {
        const ids = [...this.entries.keys()];
        await Promise.all(ids.map((id) => this.evict(id)));
    }

    private async open(account: AccountEntry, pollOptions: UsagePollOptions, key: PoolKey): Promise<PoolEntry> {
        while (this.entries.size >= this.options.maxClients) {
            const oldest = [...this.entries.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
            if (!oldest) {
                break;
            }

            await this.evict(oldest[0]);
        }

        const entry = {
            key,
            client: await this.options.open(account, pollOptions),
            lastUsed: this.options.now(),
            queue: Promise.resolve(),
        };
        this.entries.set(account.id, entry);
        return entry;
    }

    private async evictOtherGenerations(key: PoolKey): Promise<void> {
        const existing = this.entries.get(key.accountId);
        if (existing && existing.key.generation !== key.generation) {
            await this.evict(key.accountId);
        }
    }

    private async evictIdle(): Promise<void> {
        const cutoff = this.options.now() - this.options.idleMs;
        const stale = [...this.entries.entries()].filter(([, entry]) => entry.lastUsed < cutoff).map(([id]) => id);
        await Promise.all(stale.map((id) => this.evict(id)));
    }

    private async evict(accountId: string): Promise<void> {
        const entry = this.entries.get(accountId);
        if (!entry) {
            return;
        }

        this.entries.delete(accountId);
        await entry.client.close();
    }
}

function account(index: number, generation = 1): AccountEntry {
    return {
        id: `acc_fixture_${index}`,
        name: `fixture-${index}`,
        provider: "openai-sub",
        enabled: true,
        billing: { mode: "subscription" },
        credentials: { dataDir: `/synthetic/codex-${index}`, expiresAt: generation },
        useEnvApiKey: false,
    };
}

function emptyCounters(): Counters {
    return {
        opens: 0,
        initializes: 0,
        logins: 0,
        reads: 0,
        closes: 0,
        childCpuMs: 0,
        peakResidentBytes: 0,
    };
}

function normalizedOutput(snapshots: unknown[]): string {
    return SafeJSON.stringify(
        snapshots.map((round) =>
            Array.isArray(round)
                ? round.map((snapshot) =>
                      snapshot && typeof snapshot === "object"
                          ? { ...snapshot, fetchedAt: "synthetic-observation-time" }
                          : snapshot
                  )
                : round
        )
    );
}

async function sampleResident(clients: readonly PoolClient[]): Promise<number> {
    const samples = await Promise.all(
        clients.map((client) => sampleProcess(client.pid, { windowMs: SAMPLE_WINDOW_MS }))
    );
    return samples.reduce((total, sample) => total + (sample.alive ? sample.rssBytes : 0), 0);
}

async function runCurrent(accounts: AccountEntry[], rounds: number): Promise<ArmResult> {
    const counters = emptyCounters();
    const output: unknown[] = [];
    const startedCpu = process.cpuUsage();
    const startedAt = performance.now();

    for (let round = 0; round < rounds; round++) {
        const clients: PoolClient[] = [];
        let release: (() => void) | undefined;
        const allOpened = new Promise<void>((resolve) => {
            release = resolve;
        });
        const snapshots = await Promise.all(
            accounts.map((selected) =>
                pollCodexAccount(
                    selected,
                    {},
                    {
                        openClient: async () => {
                            const client = await SyntheticClient.open(selected, counters);
                            clients.push(client);

                            if (clients.length === accounts.length) {
                                counters.peakResidentBytes = Math.max(
                                    counters.peakResidentBytes,
                                    await sampleResident(clients)
                                );
                                release?.();
                            }

                            await allOpened;
                            return client;
                        },
                    }
                )
            )
        );
        output.push(snapshots);
    }

    const cpu = process.cpuUsage(startedCpu);
    return {
        counters,
        parentCpuMs: (cpu.user + cpu.system) / 1000,
        wallMs: performance.now() - startedAt,
        output: normalizedOutput(output),
        idleResidentBytes: 0,
    };
}

async function runPooled(accounts: AccountEntry[], rounds: number, persistent: boolean): Promise<ArmResult> {
    const counters = emptyCounters();
    const output: unknown[] = [];
    const startedCpu = process.cpuUsage();
    const startedAt = performance.now();
    let idleResidentBytes = 0;
    let persistentPool: PrototypePool | undefined;

    const createPool = () =>
        new PrototypePool({
            maxClients: accounts.length,
            idleMs: 10 * 60_000,
            now: Date.now,
            generation: (selected) => selected.credentials.expiresAt ?? 0,
            open: (selected) => SyntheticClient.open(selected, counters),
        });

    for (let round = 0; round < rounds; round++) {
        if (persistent && !persistentPool) {
            persistentPool = createPool();
        }

        const pool = persistentPool ?? createPool();
        const snapshots = await Promise.all(
            accounts.map((selected) =>
                pollCodexAccount(selected, {}, { openClient: (bound, options) => pool.lease(bound, options) })
            )
        );
        output.push(snapshots);
        const resident = await sampleResident(pool.clients());
        counters.peakResidentBytes = Math.max(counters.peakResidentBytes, resident);

        if (persistent && round < rounds - 1) {
            idleResidentBytes = resident;
        }

        if (!persistent) {
            await pool.closeAll();
        }
    }

    await persistentPool?.closeAll();
    const cpu = process.cpuUsage(startedCpu);
    return {
        counters,
        parentCpuMs: (cpu.user + cpu.system) / 1000,
        wallMs: performance.now() - startedAt,
        output: normalizedOutput(output),
        idleResidentBytes,
    };
}

async function verifyPoolControls(): Promise<number> {
    let now = 1_800_000_000_000;
    let opens = 0;
    let closes = 0;
    let refreshes = 0;
    let requestActive = 0;
    let maxRequestActive = 0;
    const dead = new Set<number>();
    const clientIds = new WeakMap<PoolClient, number>();
    const expectCounts = (expected: { opens: number; refreshes: number; closes: number }, label: string): void => {
        if (opens !== expected.opens || refreshes !== expected.refreshes || closes !== expected.closes) {
            throw new Error(`${label} control failed`);
        }
    };

    const pool = new PrototypePool({
        maxClients: 2,
        idleMs: 100,
        now: () => now,
        generation: (selected) => selected.credentials.expiresAt ?? 0,
        open: async (selected, options) => {
            const id = ++opens;
            const irreversibleRefresh = (): void => {
                refreshes += 1;

                if (options.probe) {
                    throw new Error("single-use refresh reached during probe");
                }
            };

            if (!options.probe) {
                irreversibleRefresh();
            }

            const client: PoolClient = {
                pid: process.pid,
                alive: () => !dead.has(id),
                async request<T>(): Promise<T> {
                    requestActive += 1;
                    maxRequestActive = Math.max(maxRequestActive, requestActive);
                    await Promise.resolve();
                    requestActive -= 1;

                    if (selected.id === "acc_fixture_5") {
                        throw new Error("synthetic account/rateLimits/read timed out");
                    }

                    return { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 } } } as T;
                },
                async notify() {},
                async close() {
                    closes += 1;
                },
            };
            clientIds.set(client, id);
            return client;
        },
    });
    const first = account(1, 1);
    const firstLease = await pool.lease(first, { probe: true });
    const reused = await pool.lease(first, { probe: true });
    expectCounts({ opens: 1, refreshes: 0, closes: 0 }, "probe/reuse");

    await Promise.all([firstLease.request("account/rateLimits/read"), reused.request("account/rateLimits/read")]);
    if (maxRequestActive !== 1) {
        throw new Error("same-client requests were not serialized");
    }

    await pool.lease(account(1, 2), {});
    expectCounts({ opens: 2, refreshes: 1, closes: 1 }, "credential-generation invalidation");

    const current = pool.clients()[0];
    const currentId = current ? clientIds.get(current) : undefined;
    if (currentId === undefined) {
        throw new Error("pool lost the generation-replacement client");
    }

    dead.add(currentId);
    await pool.lease(account(1, 2), {});
    expectCounts({ opens: 3, refreshes: 2, closes: 2 }, "dead-process invalidation");

    await pool.lease(account(2), {});
    const sameNameDifferentId = { ...account(3), name: first.name };
    await pool.lease(sameNameDifferentId, {});
    if (pool.size() !== 2) {
        throw new Error("identity/pool-bound control failed");
    }

    now += 101;
    await pool.lease(account(4), {});
    if (pool.size() !== 1) {
        throw new Error("idle eviction control failed");
    }

    const timeoutLease = await pool.lease(account(5), {});
    const timeout = await timeoutLease.request("account/rateLimits/read").catch((err: unknown) => err);
    if (!(timeout instanceof Error && timeout.message.includes("timed out")) || pool.size() !== 1) {
        throw new Error("request-failure eviction control failed");
    }

    await pool.closeAll();
    if (pool.size() !== 0 || closes !== opens) {
        throw new Error("shutdown cleanup control failed");
    }

    return 10;
}

function armMetrics(prefix: string, arm: ArmResult): BaselineMetrics {
    return {
        [`${prefix}Opens`]: arm.counters.opens,
        [`${prefix}Initializes`]: arm.counters.initializes,
        [`${prefix}Logins`]: arm.counters.logins,
        [`${prefix}Reads`]: arm.counters.reads,
        [`${prefix}Closes`]: arm.counters.closes,
        [`${prefix}ChildCpuMs`]: Number(arm.counters.childCpuMs.toFixed(2)),
        [`${prefix}ParentCpuMs`]: Number(arm.parentCpuMs.toFixed(2)),
        [`${prefix}WallMs`]: Number(arm.wallMs.toFixed(2)),
        [`${prefix}PeakResidentMiB`]: Number((arm.counters.peakResidentBytes / 1024 / 1024).toFixed(2)),
        [`${prefix}IdleResidentMiB`]: Number((arm.idleResidentBytes / 1024 / 1024).toFixed(2)),
    };
}

async function measure(accounts: number, rounds: number): Promise<BaselineMetrics> {
    const fixtures = Array.from({ length: accounts }, (_, index) => account(index + 1));
    const current = await runCurrent(fixtures, rounds);
    const taskLocal = await runPooled(fixtures, rounds, false);
    const persistent = await runPooled(fixtures, rounds, true);
    const controlChecks = await verifyPoolControls();
    const outputMismatchCount =
        Number(current.output !== taskLocal.output) + Number(current.output !== persistent.output);

    if (taskLocal.counters.opens !== current.counters.opens) {
        throw new Error("A task-local pool unexpectedly crossed the scheduler process boundary");
    }

    return {
        ...armMetrics("current", current),
        ...armMetrics("taskLocalPool", taskLocal),
        ...armMetrics("hypotheticalPersistent", persistent),
        currentScheduledTaskStarts: rounds,
        taskLocalPoolScheduledTaskStarts: rounds,
        hypotheticalPersistentScheduledTaskStarts: 1,
        controlFailureCount: 10 - controlChecks,
        outputMismatchCount,
    };
}

if (process.argv[2] === CHILD_ARG) {
    await runSyntheticAppServer(process.argv[3] ?? "missing-account");
    process.exit(0);
}

const program = addCommonOptions(
    new Command()
        .name("codex-usage-client-reuse")
        .description("Decide whether Codex usage client pooling pays under the scheduled-process lifecycle")
        .option("--accounts <n>", "Synthetic accounts per eligible round", "6")
        .option("--rounds <n>", "Eligible rounds to compare", "5")
);
await program.parseAsync(process.argv);
const flags = program.opts<CommonFlags & { accounts: string; rounds: string }>();
const accounts = Math.max(1, Number.parseInt(flags.accounts, 10) || 6);
const rounds = Math.max(2, Number.parseInt(flags.rounds, 10) || 5);

out.log.warn(
    "Decision rule: a task-local pool must reduce opens under the current scheduler boundary; otherwise production pooling is rejected."
);
out.log.info(
    "The persistent arm is a hypothetical service rewrite and reports the resident-memory cost of keeping clients between rounds."
);

await runPollBenchmark({
    stem: "codex-usage-client-reuse",
    title: "Codex usage client reuse — scheduled process boundary versus persistent service",
    setup: `${accounts} invented accounts, ${rounds} eligible rounds, local Bun app-server substitute, no credentials/network`,
    flags,
    measure: () => measure(accounts, rounds),
});
