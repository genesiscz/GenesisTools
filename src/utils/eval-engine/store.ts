/**
 * The run folder, reading and writing. No other file knows a file name inside a run folder.
 *
 *   <runsDir>/<run>/manifest.json          written once, never changed (also not by --resume)
 *   <runsDir>/<run>/conversations/<key>.json   one per finished conversation, created once, never replaced
 *   <runsDir>/<run>/errors/<key>.jsonl     one line per attempt that ended without a record (diagnostic)
 *   <runsDir>/<run>/prompts/<hash>.txt     each distinct system prompt once
 *   <runsDir>/<run>/summary.json           an export of the last `run` output; no command reads it
 *   <runsDir>/<run>/run.lock               the process that plays the run now; removed when it ends
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, link, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { CellRef, ConversationRecord } from "./conversation";
import { EvalConfigError, type ScenarioOrigin, sha256 } from "./document";
import type { CheckVerdict, ExpectationVerdict } from "./evaluate";
import { type RunPlan, slug } from "./plan";
import type { Json, SystemErrorKind, SystemInfo } from "./system";

export interface HarnessSettings {
    judge: string | null;
    judgePromptVersion: number;
    simulator: string | null;
    simulatorPromptVersion: number;
}

/** Written once when the run is created. */
export interface RunManifest {
    schema: "eval-manifest/1";
    /** "<local time to the second>-<label>": sorts by time, so "the last two runs" needs no pointer file. */
    run: string;
    label: string;
    createdAt: string;
    /** The moment the setups were resolved. `--resume` resolves again with it and requires the same result. */
    plannedAt: string;
    project: string;
    target: string | null;
    rubricVersion: number;
    signalsVersion: number;
    plan: RunPlan;
    /** Every scenario document of the run, so a run can be resumed and compared when the files have changed. */
    scenarios: Record<string, { hash: string; origin: ScenarioOrigin; doc: Json }>;
    /** Scenario id → the resolved setup `open` receives. */
    setups: Record<string, Json>;
    system: SystemInfo;
    harness: HarnessSettings;
    maxCostUsd: number | null;
    argv: string[];
}

export type ErrorLineKind = SystemErrorKind | "cost-limit";

export interface RunStore {
    readonly dir: string;
    readonly manifest: RunManifest;
    /** Creates `conversations/<key>.json` atomically (a temporary file, then a hard link). "exists": never replaced. */
    writeFinal(record: ConversationRecord): Promise<"written" | "exists">;
    /** Appends one line to `errors/<key>.jsonl`. */
    writeError(key: string, attempt: number, kind: ErrorLineKind, message: string): Promise<void>;
    /** Writes `prompts/<hash>.txt` when it is missing (once per store instance). Returns the hash (sha256, 8 hex). */
    putPrompt(text: string): Promise<string>;
    finalKeys(): Promise<Set<string>>;
    finalRecords(): Promise<ConversationRecord[]>;
    /** `summary.json`: an export for a person. Replaced on every run or resume. */
    writeSummary(summary: unknown): Promise<void>;
    /**
     * Claims the run for this process (`run.lock`) before it reads which conversations are missing, so two
     * `run --resume` of one run never open the same conversation twice. Throws `run-in-use` while another live
     * process holds it; a lock whose process on this computer has ended is taken over.
     */
    claim(): Promise<RunClaim>;
}

export interface RunClaim {
    release(): Promise<void>;
}

/** A run as readers see it: the manifest, every final record, and the planned keys without one. */
export interface RunView {
    dir: string;
    manifest: RunManifest;
    records: ConversationRecord[];
    missing: { key: string; cell: CellRef; kind: ErrorLineKind | "not-run"; message: string }[];
    /** Key → the transcript's path. */
    recordFiles: Record<string, string>;
    /** Prompt hash → the prompt file's path. */
    promptFiles: Record<string, string>;
}

// ── Schemas of what is on disk ───────────────────────────────────────────────

const JsonSchema = z.json();
const UsageSchema = z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedInputTokens: z.number().optional(),
    costUsd: z.number().optional(),
});
const ToolCallSchema = z.object({
    name: z.string(),
    input: JsonSchema,
    output: JsonSchema.optional(),
    error: z.string().optional(),
});
const ResultSchema = z.enum(["pass", "fail", "inconclusive"]);
const SeveritySchema = z.enum(["safety", "gate", "advisory"]);
const CheckVerdictSchema: z.ZodType<CheckVerdict> = z.lazy(() =>
    z.object({
        label: z.string(),
        name: z.string().optional(),
        result: ResultSchema,
        reason: z.string(),
        branch: z.string().optional(),
        children: z.array(CheckVerdictSchema).optional(),
    })
);
const VerdictSchema: z.ZodType<ExpectationVerdict> = z.object({
    id: z.string(),
    severity: SeveritySchema,
    place: z.enum(["turn", "always", "final", "binding", "choose"]),
    turn: z.number(),
    result: ResultSchema,
    reason: z.string(),
    check: JsonSchema,
    branch: z.string().nullable(),
    tree: CheckVerdictSchema,
});
const CellSchema = z.object({ scenario: z.string(), scenarioHash: z.string(), model: z.string(), variant: z.string() });
const ErrorKindSchema = z.enum(["rate-limit", "transient", "blocked", "cost-limit"]);

const RecordSchema: z.ZodType<ConversationRecord> = z.object({
    schema: z.literal("eval-conversation/1"),
    run: z.string(),
    key: z.string(),
    cell: CellSchema,
    repeat: z.number(),
    outcome: z.enum(["passed", "failed", "inconclusive"]),
    safetyMiss: z.boolean(),
    safetyUnverified: z.boolean(),
    completed: z.boolean(),
    brokenBy: z.object({ kind: z.enum(["rate-limit", "transient", "blocked"]), message: z.string() }).nullable(),
    closeError: z.string().nullable(),
    attempt: z.number(),
    startedAt: z.string(),
    finishedAt: z.string(),
    setup: JsonSchema,
    bindings: z.record(z.string(), JsonSchema),
    turns: z.array(
        z.object({
            turn: z.number(),
            step: z.number(),
            choice: z.string().nullable(),
            user: z.object({ text: z.string(), source: z.enum(["script", "simulator"]) }),
            reply: z.string(),
            toolCalls: z.array(ToolCallSchema),
            toolEvidence: z.enum(["observed", "unavailable"]),
            signals: JsonSchema,
            promptHash: z.string().nullable(),
            context: z.string().nullable(),
            observedModel: z.string().nullable(),
            steps: z.array(
                z.object({
                    text: z.string(),
                    toolCalls: z.array(ToolCallSchema),
                    finishReason: z.string().nullable(),
                    usage: UsageSchema,
                })
            ),
            usage: UsageSchema,
            latencyMs: z.number(),
            firstTokenMs: z.number().nullable(),
            verdicts: z.array(VerdictSchema),
        })
    ),
    final: z.array(VerdictSchema),
    simulator: z.array(
        z.object({ step: z.number(), turns: z.number(), endedBy: z.enum(["until", "stop-word", "max-turns"]) })
    ),
    systemUsage: UsageSchema,
    harnessUsage: UsageSchema,
});

const PlanSchema: z.ZodType<RunPlan> = z.object({
    cells: z.array(CellSchema.extend({ threshold: z.number() })),
    conversations: z.array(z.object({ key: z.string(), cell: CellSchema, repeat: z.number() })),
    repeats: z.number(),
    maxErrorRate: z.number(),
    hash: z.string(),
});

const ManifestSchema: z.ZodType<RunManifest> = z.object({
    schema: z.literal("eval-manifest/1"),
    run: z.string(),
    label: z.string(),
    createdAt: z.string(),
    plannedAt: z.string(),
    project: z.string(),
    target: z.string().nullable(),
    rubricVersion: z.number(),
    signalsVersion: z.number(),
    plan: PlanSchema,
    scenarios: z.record(
        z.string(),
        z.object({ hash: z.string(), origin: z.enum(["file", "stdin", "flags", "manifest"]), doc: JsonSchema })
    ),
    setups: z.record(z.string(), JsonSchema),
    system: z.object({
        models: z.array(z.object({ id: z.string(), label: z.string(), limitKey: z.string() })),
        variants: z.array(z.string()),
        fingerprint: z.string().nullable(),
    }),
    harness: z.object({
        judge: z.string().nullable(),
        judgePromptVersion: z.number(),
        simulator: z.string().nullable(),
        simulatorPromptVersion: z.number(),
    }),
    maxCostUsd: z.number().nullable(),
    argv: z.array(z.string()),
});

const ErrorLineSchema = z.object({ attempt: z.number(), kind: ErrorKindSchema, message: z.string(), at: z.string() });

// ── Paths ────────────────────────────────────────────────────────────────────

const Files = {
    manifest: "manifest.json",
    summary: "summary.json",
    conversations: "conversations",
    errors: "errors",
    prompts: "prompts",
    lock: "run.lock",
} as const;

const recordPath = (dir: string, key: string) => join(dir, Files.conversations, `${key}.json`);
const errorPath = (dir: string, key: string) => join(dir, Files.errors, `${key}.jsonl`);
const promptPath = (dir: string, hash: string) => join(dir, Files.prompts, `${hash}.txt`);

function isErrno(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (isErrno(error, "ENOENT")) {
            return false;
        }
        throw error;
    }
}

interface LockHolder {
    pid: number;
    host: string;
    at: string;
}

function parseLockHolder(text: string): LockHolder | null {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        // A half-written or foreign lock file names no holder to ask; the caller treats it as held.
        return null;
    }
    if (
        typeof value === "object" &&
        value !== null &&
        "pid" in value &&
        typeof value.pid === "number" &&
        "host" in value &&
        typeof value.host === "string" &&
        "at" in value &&
        typeof value.at === "string"
    ) {
        return { pid: value.pid, host: value.host, at: value.at };
    }
    return null;
}

/** `ps -o etime=` resolves to whole seconds, so allow two of them either way. */
const StartTolerance = 2_000;

/**
 * A holder on another computer counts as alive. On this one, the lock pid must still run the process that wrote the
 * lock: a program that started after the lock time holds a recycled pid, so the lock is stale. The engine imports only
 * node built-ins, so it asks `ps` how long the pid has run (elapsed time has no time zone, unlike a start date); when
 * `ps` cannot answer, the holder counts as alive.
 */
function holderIsAlive(holder: LockHolder): boolean {
    if (holder.host !== hostname()) {
        return true;
    }

    // lint-rules-ignore: the engine imports only node built-ins (boundary.test.ts), and this runs once per claim that finds a held lock
    const ps = spawnSync("ps", ["-o", "etime=", "-p", String(holder.pid)], { encoding: "utf8", timeout: 5_000 });
    if (ps.error) {
        return true;
    }

    if (ps.status !== 0) {
        return false;
    }

    const elapsed = elapsedMs(ps.stdout.trim());
    const startedAt = elapsed === null ? Number.NaN : Date.now() - elapsed;
    const lockedAt = Date.parse(holder.at);
    return !Number.isFinite(startedAt) || !Number.isFinite(lockedAt) || startedAt <= lockedAt + StartTolerance;
}

/** `[[dd-]hh:]mm:ss` from `ps -o etime=` in milliseconds, or null for any other text. */
function elapsedMs(text: string): number | null {
    const match = text.match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/);
    if (!match) {
        return null;
    }

    const [, days = "0", hours = "0", minutes, seconds] = match;
    return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

async function readLockFile(path: string): Promise<string | null> {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if (isErrno(error, "ENOENT")) {
            return null;
        }
        throw error;
    }
}

/** How many guards of a guard a claim may clear; each level needs a process that died while it held a guard. */
const MaxGuardDepth = 3;

/**
 * Removes the lock at `path` only when it still holds `text`, the stale text this process read. Only the process that
 * creates `<path>.<hash of text>.takeover` with an exclusive create may remove it, so two processes that read the same
 * stale lock never both act, and no remover can take away a lock written after its read: the lock it read stays in
 * place until a guard holder removes it. A guard whose process died is cleared the same way, one level deeper.
 * Returns the live process that holds the guard (it takes the run over now), or null when the caller should look again.
 */
async function removeStaleLock(path: string, text: string, depth = 0): Promise<LockHolder | null> {
    const guard = `${path}.${sha256(text, 16)}.takeover`;
    try {
        await writeFile(guard, lockText(), { flag: "wx" });
    } catch (error) {
        if (!isErrno(error, "EEXIST")) {
            throw error;
        }

        const held = await readLockFile(guard);
        const holder = held === null ? null : parseLockHolder(held);
        if (held === null || !holder) {
            return null;
        }

        if (holderIsAlive(holder)) {
            return holder;
        }

        return depth < MaxGuardDepth ? removeStaleLock(guard, held, depth + 1) : null;
    }

    try {
        if ((await readLockFile(path)) === text) {
            await unlink(path);
        }

        return null;
    } finally {
        await unlink(guard);
    }
}

/** The holder of a lock, with a random id so that no two claims ever write the same text. */
function lockText(): string {
    const id = randomBytes(6).toString("hex");
    return `${JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), id })}\n`;
}

/**
 * Takes `run.lock` with an exclusive create. A lock left by an ended process on this computer is removed through
 * `removeStaleLock`, so of several processes that find it stale at the same time exactly one removes it.
 */
async function claimRun(dir: string): Promise<RunClaim> {
    const path = join(dir, Files.lock);
    const mine = lockText();
    const inUse = (holder: LockHolder | null) =>
        new EvalConfigError(
            "run-in-use",
            holder
                ? `the run in ${dir} is being played by pid ${holder.pid} on ${holder.host} since ${holder.at}; remove ${path} only when that process is gone`
                : `the run in ${dir} is being played by another process (${path} names none); remove it only when no process plays the run`
        );
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await writeFile(path, mine, { flag: "wx" });
            return {
                async release() {
                    if ((await readLockFile(path)) === mine) {
                        await unlink(path);
                    }
                },
            };
        } catch (error) {
            if (!isErrno(error, "EEXIST")) {
                throw error;
            }
        }
        const text = await readLockFile(path);
        if (text === null) {
            continue;
        }
        const holder = parseLockHolder(text);
        if (!holder || holderIsAlive(holder)) {
            throw inUse(holder);
        }
        const taker = await removeStaleLock(path, text);
        if (taker) {
            throw inUse(taker);
        }
    }
    throw inUse(parseLockHolder((await readLockFile(path)) ?? ""));
}

/** "2026-11-10T19-42-07-<label>" in the local time of this computer. */
export function makeEvalRunId(now: Date, label: string): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return `${time}-${slug(label) || "run"}`;
}

const RunIdPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/;

/** Makes `<runsDir>/<run>/` with its manifest. A second run in the same second gets "-2", "-3", … */
export async function createRun(
    runsDir: string,
    options: { now: Date; label: string },
    makeManifest: (run: string) => RunManifest
): Promise<RunStore> {
    const base = resolve(runsDir);
    await mkdir(base, { recursive: true });
    const id = makeEvalRunId(options.now, options.label);
    for (let n = 1; ; n++) {
        const run = n === 1 ? id : `${id}-${n}`;
        const dir = join(base, run);
        try {
            await mkdir(dir);
        } catch (error) {
            if (isErrno(error, "EEXIST")) {
                continue;
            }
            throw error;
        }
        for (const folder of [Files.conversations, Files.errors, Files.prompts]) {
            await mkdir(join(dir, folder));
        }
        const manifest = makeManifest(run);
        await writeFile(join(dir, Files.manifest), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
        return storeFor(dir, manifest);
    }
}

/** The folder of a run given as a path or as a run id under `runsDir`. */
async function runDir(dirOrId: string, runsDir: string): Promise<string> {
    const candidates =
        isAbsolute(dirOrId) || dirOrId.includes("/")
            ? [resolve(dirOrId)]
            : [resolve(runsDir, dirOrId), resolve(dirOrId)];
    for (const dir of candidates) {
        if (await exists(join(dir, Files.manifest))) {
            return dir;
        }
    }
    throw new EvalConfigError("unknown-run", `no run "${dirOrId}" in ${resolve(runsDir)}`);
}

async function readJson(path: string): Promise<unknown> {
    return JSON.parse(await readFile(path, "utf8"));
}

async function readManifest(dir: string): Promise<RunManifest> {
    const parsed = ManifestSchema.safeParse(await readJson(join(dir, Files.manifest)));
    if (!parsed.success) {
        throw new EvalConfigError(
            "unknown-run",
            `${join(dir, Files.manifest)} is not a manifest of this engine: ${parsed.error.issues[0]?.message ?? ""}`
        );
    }
    return parsed.data;
}

/** Opens an existing run to continue it. The caller checks that the plan still matches. */
export async function openRun(dirOrId: string, runsDir: string): Promise<RunStore> {
    const dir = await runDir(dirOrId, runsDir);
    return storeFor(dir, await readManifest(dir));
}

async function listNames(dir: string, suffix: string): Promise<string[]> {
    try {
        return (await readdir(dir))
            .filter((name) => name.endsWith(suffix) && !name.startsWith("."))
            .map((name) => name.slice(0, -suffix.length));
    } catch (error) {
        if (isErrno(error, "ENOENT")) {
            return [];
        }
        throw error;
    }
}

async function readRecord(path: string): Promise<ConversationRecord> {
    const parsed = RecordSchema.safeParse(await readJson(path));
    if (!parsed.success) {
        throw new Error(`${path} is not a conversation record: ${parsed.error.issues[0]?.message ?? ""}`);
    }
    return parsed.data;
}

function storeFor(dir: string, manifest: RunManifest): RunStore {
    // A system prompt is the same text for most turns of a run: hash it and write it once per store instance.
    const hashes = new Map<string, string>();
    const stored = new Set<string>();
    return {
        dir,
        manifest,
        async writeFinal(record) {
            const target = recordPath(dir, record.key);
            const temporary = join(
                dir,
                Files.conversations,
                `.${record.key}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
            );
            await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
            try {
                await link(temporary, target);
                return "written";
            } catch (error) {
                if (isErrno(error, "EEXIST")) {
                    return "exists";
                }
                throw error;
            } finally {
                await unlink(temporary);
            }
        },
        async writeError(key, attempt, kind, message) {
            const line = { attempt, kind, message, at: new Date().toISOString() };
            await appendFile(errorPath(dir, key), `${JSON.stringify(line)}\n`);
        },
        async putPrompt(text) {
            let hash = hashes.get(text);
            if (hash === undefined) {
                hash = sha256(text, 8);
                hashes.set(text, hash);
            }
            if (stored.has(hash)) {
                return hash;
            }
            try {
                await writeFile(promptPath(dir, hash), text, { flag: "wx" });
            } catch (error) {
                if (!isErrno(error, "EEXIST")) {
                    throw error;
                }
            }
            stored.add(hash);
            return hash;
        },
        async finalKeys() {
            return new Set(await listNames(join(dir, Files.conversations), ".json"));
        },
        async finalRecords() {
            const keys = await listNames(join(dir, Files.conversations), ".json");
            return Promise.all(keys.sort().map((key) => readRecord(recordPath(dir, key))));
        },
        async writeSummary(summary) {
            await writeFile(join(dir, Files.summary), `${JSON.stringify(summary, null, 2)}\n`);
        },
        claim: () => claimRun(dir),
    };
}

async function lastErrorLine(dir: string, key: string): Promise<z.infer<typeof ErrorLineSchema> | null> {
    let text: string;
    try {
        text = await readFile(errorPath(dir, key), "utf8");
    } catch (error) {
        if (isErrno(error, "ENOENT")) {
            return null;
        }
        throw error;
    }
    const lines = text.trim().split("\n").filter(Boolean);
    try {
        const parsed = lines.length ? ErrorLineSchema.safeParse(JSON.parse(lines[lines.length - 1])) : null;
        return parsed?.success ? parsed.data : null;
    } catch (error) {
        if (error instanceof SyntaxError) {
            return null;
        }
        throw error;
    }
}

/** Reads a run by folder or by id. Always folds the records; `summary.json` is never an input. */
export async function loadRun(dirOrId: string, runsDir: string): Promise<RunView> {
    const dir = await runDir(dirOrId, runsDir);
    const manifest = await readManifest(dir);
    const store = storeFor(dir, manifest);
    const planned = new Set(manifest.plan.conversations.map((c) => c.key));
    const records = (await store.finalRecords()).filter((record) => planned.has(record.key));
    const done = new Set(records.map((record) => record.key));
    const missing: RunView["missing"] = await Promise.all(
        manifest.plan.conversations
            .filter((conversation) => !done.has(conversation.key))
            .map(async (conversation) => {
                const line = await lastErrorLine(dir, conversation.key);
                return {
                    key: conversation.key,
                    cell: conversation.cell,
                    kind: line ? line.kind : "not-run",
                    message: line ? line.message : "the conversation was not played",
                };
            })
    );
    const recordFiles: Record<string, string> = {};
    for (const record of records) {
        recordFiles[record.key] = recordPath(dir, record.key);
    }
    const promptFiles: Record<string, string> = {};
    for (const hash of await listNames(join(dir, Files.prompts), ".txt")) {
        promptFiles[hash] = promptPath(dir, hash);
    }
    return { dir, manifest, records, missing, recordFiles, promptFiles };
}

/** Run ids under `runsDir`, newest first. */
export async function listRuns(runsDir: string): Promise<string[]> {
    let names: string[];
    try {
        names = await readdir(resolve(runsDir));
    } catch (error) {
        if (isErrno(error, "ENOENT")) {
            return [];
        }
        throw error;
    }
    const candidates = names.filter((name) => RunIdPattern.test(name));
    const hasManifest = await Promise.all(
        candidates.map((name) => exists(join(resolve(runsDir), name, Files.manifest)))
    );
    return candidates
        .filter((_, index) => hasManifest[index])
        .sort()
        .reverse();
}

/** One transcript of a run by its key. */
export async function readConversation(view: RunView, key: string): Promise<ConversationRecord> {
    const record = view.records.find((r) => r.key === key);
    if (!record) {
        const known = view.records.map((r) => r.key);
        throw new EvalConfigError(
            "unknown-run",
            `run ${view.manifest.run} has no finished conversation "${key}"; finished: ${known.slice(0, 10).join(", ")}${known.length > 10 ? ", …" : ""}`
        );
    }
    return record;
}
