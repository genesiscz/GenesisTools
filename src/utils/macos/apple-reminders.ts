import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import type { DarwinKit, ReminderInfo, ReminderListInfo } from "@genesiscz/darwinkit";
import { DarwinKitError, ReminderPriority } from "@genesiscz/darwinkit";
import { closeDarwinKit, getDarwinKit } from "./darwinkit";

export type { ReminderInfo, ReminderListInfo };
export { ReminderPriority };

export function todoPriorityToApple(priority: "critical" | "high" | "medium" | "low"): number {
    return ReminderPriority[priority === "critical" ? "high" : priority];
}

const PROCESS_START_MS = Date.now();
const DIAGNOSTIC_DIR = join(homedir(), "Library/Logs/DiagnosticReports");
const STDERR_BUFFER_LINES = 50;

function resolveDefaultTimeoutMs(): number {
    const raw = process.env.DARWINKIT_TIMEOUT_MS;

    if (!raw) {
        return 10_000;
    }

    const parsed = Number.parseInt(raw, 10);

    if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
    }

    return 10_000;
}

interface DarwinkitDiagnostics {
    reportPath?: string;
    stderrTail?: string;
}

export class DarwinkitTimeoutError extends Error {
    readonly name = "DarwinkitTimeoutError";
    readonly operation: string;
    readonly timeoutMs: number;
    readonly diagnostics: DarwinkitDiagnostics;

    constructor(operation: string, timeoutMs: number, diagnostics: DarwinkitDiagnostics) {
        super(buildErrorMessage(`darwinkit ${operation} timed out after ${timeoutMs}ms`, diagnostics));
        this.operation = operation;
        this.timeoutMs = timeoutMs;
        this.diagnostics = diagnostics;
    }
}

export class DarwinkitCrashError extends Error {
    readonly name = "DarwinkitCrashError";
    readonly operation: string;
    readonly exitCode: number | null;
    readonly diagnostics: DarwinkitDiagnostics;

    constructor(operation: string, exitCode: number | null, diagnostics: DarwinkitDiagnostics) {
        const codeLabel = exitCode === null ? "unknown" : String(exitCode);
        super(buildErrorMessage(`darwinkit child died during ${operation} (exit=${codeLabel})`, diagnostics));
        this.operation = operation;
        this.exitCode = exitCode;
        this.diagnostics = diagnostics;
    }
}

function buildErrorMessage(prefix: string, d: DarwinkitDiagnostics): string {
    const parts = [prefix];

    if (d.reportPath) {
        parts.push(`crash report: ${d.reportPath}`);
    }

    if (d.stderrTail) {
        parts.push(`stderr (last lines):\n${d.stderrTail}`);
    }

    return parts.join("\n");
}

function findRecentDiagnosticReport(): string | undefined {
    if (!existsSync(DIAGNOSTIC_DIR)) {
        return undefined;
    }

    try {
        const entries = readdirSync(DIAGNOSTIC_DIR);
        const candidates: { path: string; mtimeMs: number }[] = [];

        for (const name of entries) {
            if (!name.startsWith("darwinkit-") || !name.endsWith(".ips")) {
                continue;
            }

            const full = join(DIAGNOSTIC_DIR, name);
            const stat = statSync(full);

            if (stat.mtimeMs >= PROCESS_START_MS) {
                candidates.push({ path: full, mtimeMs: stat.mtimeMs });
            }
        }

        if (candidates.length === 0) {
            return undefined;
        }

        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return candidates[0].path;
    } catch (error) {
        logger.warn({ error }, "Failed to scan DiagnosticReports for darwinkit crash");
        return undefined;
    }
}

interface InternalChild {
    pid: number | null;
    stderr: NodeJS.ReadableStream | null;
}

/**
 * Reaches into @genesiscz/darwinkit private internals to get the child PID + stderr.
 * The package's transport layer drops stderr (`stderr.on('data', ()=>{})`) and keeps
 * the ChildProcess private. EventEmitter allows multiple 'data' listeners, so attaching
 * our own does not fight the package's no-op listener. Falls back to null if the package
 * shape changes; callers degrade to closeDarwinKit() + diagnostic-report-only error context.
 */
function getInternalChild(dk: DarwinKit): InternalChild | null {
    try {
        const internal = dk as unknown as {
            transport?: { process?: { pid?: number; stderr?: NodeJS.ReadableStream | null } | null };
        };
        const proc = internal.transport?.process;

        if (!proc) {
            return null;
        }

        return {
            pid: typeof proc.pid === "number" ? proc.pid : null,
            stderr: proc.stderr ?? null,
        };
    } catch {
        return null;
    }
}

const stderrTails = new WeakMap<DarwinKit, string[]>();
const wiredClients = new WeakSet<DarwinKit>();

function ensureStderrCapture(dk: DarwinKit): void {
    if (wiredClients.has(dk)) {
        return;
    }

    const child = getInternalChild(dk);

    if (!child?.stderr) {
        return;
    }

    const buffer: string[] = [];
    stderrTails.set(dk, buffer);
    let pending = "";

    child.stderr.on("data", (chunk: Buffer | string) => {
        pending += chunk.toString("utf8");
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";

        for (const line of lines) {
            buffer.push(line);

            while (buffer.length > STDERR_BUFFER_LINES) {
                buffer.shift();
            }
        }
    });

    wiredClients.add(dk);
}

function readStderrTail(dk: DarwinKit): string | undefined {
    const buf = stderrTails.get(dk);

    if (!buf || buf.length === 0) {
        return undefined;
    }

    return buf.join("\n");
}

function killChild(dk: DarwinKit): void {
    const child = getInternalChild(dk);

    if (child?.pid && child.pid > 0) {
        try {
            process.kill(child.pid, "SIGKILL");
        } catch (error) {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;

            if (code !== "ESRCH") {
                logger.warn({ error, pid: child.pid }, "Failed to SIGKILL darwinkit child");
            }
        }
    }

    closeDarwinKit();
}

interface GuardOptions {
    timeoutMs?: number;
}

/**
 * Wraps a DarwinKit call with:
 *  - per-request timeout (default 10s, overridable via DARWINKIT_TIMEOUT_MS or options)
 *  - disconnect/error detection that rejects in-flight requests with DarwinkitCrashError
 *    instead of waiting for the package's reconnect retries (which can wedge for seconds)
 *  - diagnostic-report capture (~/Library/Logs/DiagnosticReports/darwinkit-*.ips since
 *    process start) and stderr tail attached to the resulting error
 *
 * Concurrency note: each `tools` invocation is its own process with its own DarwinKit
 * child — the 6-parallel-todos scenario is 6 separate children, no shared pipe. Within
 * one process, @genesiscz/darwinkit serializes JSON-RPC requests internally via per-id
 * routing, so we don't add an explicit serialization layer on top.
 */
export async function runDarwinkitGuarded<T>(
    dk: DarwinKit,
    operation: string,
    fn: (client: DarwinKit) => Promise<T>,
    options?: GuardOptions
): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? resolveDefaultTimeoutMs();

    await dk.connect().catch(() => {
        // connection errors will surface via fn() below
    });

    ensureStderrCapture(dk);

    let timer: ReturnType<typeof setTimeout> | null = null;
    type Unsubscribe = () => void;
    const unsubscribers: Unsubscribe[] = [];

    const guardedPromise = new Promise<T>((resolve, reject) => {
        let settled = false;

        const settleReject = (err: Error) => {
            if (settled) {
                return;
            }

            settled = true;
            reject(err);
        };

        const settleResolve = (value: T) => {
            if (settled) {
                return;
            }

            settled = true;
            resolve(value);
        };

        timer = setTimeout(() => {
            const diagnostics: DarwinkitDiagnostics = {
                reportPath: findRecentDiagnosticReport(),
                stderrTail: readStderrTail(dk),
            };

            killChild(dk);
            settleReject(new DarwinkitTimeoutError(operation, timeoutMs, diagnostics));
        }, timeoutMs);

        unsubscribers.push(
            dk.on("disconnect", ({ code }) => {
                const diagnostics: DarwinkitDiagnostics = {
                    reportPath: findRecentDiagnosticReport(),
                    stderrTail: readStderrTail(dk),
                };

                closeDarwinKit();
                settleReject(new DarwinkitCrashError(operation, code, diagnostics));
            })
        );

        unsubscribers.push(
            dk.on("error", ({ error }) => {
                const diagnostics: DarwinkitDiagnostics = {
                    reportPath: findRecentDiagnosticReport(),
                    stderrTail: readStderrTail(dk),
                };

                closeDarwinKit();
                const wrapped = new DarwinkitCrashError(operation, null, diagnostics);
                wrapped.cause = error;
                settleReject(wrapped);
            })
        );

        fn(dk).then(settleResolve, (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);

            if (err instanceof DarwinKitError && /timed out after/.test(message)) {
                const diagnostics: DarwinkitDiagnostics = {
                    reportPath: findRecentDiagnosticReport(),
                    stderrTail: readStderrTail(dk),
                };

                killChild(dk);
                settleReject(new DarwinkitTimeoutError(operation, timeoutMs, diagnostics));
                return;
            }

            // Other crash-flavored rejections from the package: pending cleanup after
            // close(), connection failure before ready, or post-reconnect-exhaustion.
            // Rewrap so callers see a consistent DarwinkitCrashError type.
            if (
                /^Client closed$/.test(message) ||
                /^Disconnected$/.test(message) ||
                /^Server exited$/.test(message) ||
                /exited with code .* before ready/.test(message) ||
                /^Transport not connected$/.test(message)
            ) {
                const diagnostics: DarwinkitDiagnostics = {
                    reportPath: findRecentDiagnosticReport(),
                    stderrTail: readStderrTail(dk),
                };

                const wrapped = new DarwinkitCrashError(operation, null, diagnostics);

                if (err instanceof Error) {
                    wrapped.cause = err;
                }

                settleReject(wrapped);
                return;
            }

            settleReject(err instanceof Error ? err : new Error(String(err)));
        });
    });

    try {
        return await guardedPromise;
    } finally {
        if (timer) {
            clearTimeout(timer);
        }

        for (const unsub of unsubscribers) {
            unsub();
        }
    }
}

export class MacReminders {
    static async ensureAuthorized(options?: GuardOptions): Promise<void> {
        const auth = await runDarwinkitGuarded(
            getDarwinKit(),
            "reminders.authorized",
            (dk) => dk.reminders.authorized({ timeout: options?.timeoutMs ?? resolveDefaultTimeoutMs() }),
            options
        );

        if (!auth.authorized) {
            throw new Error(
                `Reminders access not authorized (status: ${auth.status}). Grant access in System Settings > Privacy & Security > Reminders.`
            );
        }
    }

    static async listLists(options?: GuardOptions): Promise<ReminderListInfo[]> {
        const result = await runDarwinkitGuarded(
            getDarwinKit(),
            "reminders.lists",
            (dk) => dk.reminders.lists({ timeout: options?.timeoutMs ?? resolveDefaultTimeoutMs() }),
            options
        );
        return result.lists;
    }

    static async listReminders(
        listName?: string,
        options?: GuardOptions & { includeCompleted?: boolean }
    ): Promise<ReminderInfo[]> {
        let listIdentifiers: string[] | undefined;

        if (listName) {
            const lists = await MacReminders.listLists(options);
            const match = lists.find((l) => l.title === listName);

            if (!match) {
                return [];
            }

            listIdentifiers = [match.identifier];
        }

        const callTimeout = options?.timeoutMs ?? resolveDefaultTimeoutMs();

        if (options?.includeCompleted) {
            const result = await runDarwinkitGuarded(
                getDarwinKit(),
                "reminders.items",
                (dk) => dk.reminders.items({ list_identifiers: listIdentifiers }, { timeout: callTimeout }),
                options
            );
            return result.reminders;
        }

        const result = await runDarwinkitGuarded(
            getDarwinKit(),
            "reminders.incomplete",
            (dk) => dk.reminders.incomplete({ list_identifiers: listIdentifiers }, { timeout: callTimeout }),
            options
        );
        return result.reminders;
    }

    static async searchReminders(query: string, listName?: string, options?: GuardOptions): Promise<ReminderInfo[]> {
        const reminders = await MacReminders.listReminders(listName, { ...options, includeCompleted: true });
        const q = query.toLowerCase();
        return reminders.filter((r) => r.title.toLowerCase().includes(q) || r.notes?.toLowerCase().includes(q));
    }

    static async createReminder(options: {
        title: string;
        notes?: string;
        dueDate?: Date;
        priority?: number;
        listName?: string;
        url?: string;
        timeoutMs?: number;
    }): Promise<string> {
        const listId = await MacReminders.ensureListExists(options.listName ?? "GenesisTools", undefined, {
            timeoutMs: options.timeoutMs,
        });

        const result = await runDarwinkitGuarded(
            getDarwinKit(),
            "reminders.save_item",
            (dk) =>
                dk.reminders.saveItem(
                    {
                        calendar_identifier: listId,
                        title: options.title,
                        notes: options.notes,
                        due_date: options.dueDate?.toISOString(),
                        priority: options.priority ?? 0,
                        url: options.url,
                    },
                    { timeout: options.timeoutMs ?? resolveDefaultTimeoutMs() }
                ),
            { timeoutMs: options.timeoutMs }
        );

        if (!result.success || !result.identifier) {
            throw new Error(`Failed to create reminder: ${result.error ?? "unknown error"}`);
        }

        return result.identifier;
    }

    static async completeReminder(options: { reminderId: string; timeoutMs?: number }): Promise<boolean> {
        try {
            await runDarwinkitGuarded(
                getDarwinKit(),
                "reminders.complete_item",
                (dk) =>
                    dk.reminders.completeItem(
                        { identifier: options.reminderId },
                        { timeout: options.timeoutMs ?? resolveDefaultTimeoutMs() }
                    ),
                { timeoutMs: options.timeoutMs }
            );
            return true;
        } catch (error) {
            if (error instanceof DarwinkitTimeoutError || error instanceof DarwinkitCrashError) {
                throw error;
            }

            logger.error({ error, reminderId: options.reminderId }, "Failed to complete reminder");
            return false;
        }
    }

    static async deleteReminder(options: { reminderId: string; timeoutMs?: number }): Promise<boolean> {
        try {
            const result = await runDarwinkitGuarded(
                getDarwinKit(),
                "reminders.remove_item",
                (dk) =>
                    dk.reminders.removeItem(
                        { identifier: options.reminderId },
                        { timeout: options.timeoutMs ?? resolveDefaultTimeoutMs() }
                    ),
                { timeoutMs: options.timeoutMs }
            );
            return result.ok;
        } catch (error) {
            if (error instanceof DarwinkitTimeoutError || error instanceof DarwinkitCrashError) {
                throw error;
            }

            logger.error({ error, reminderId: options.reminderId }, "Failed to delete reminder");
            return false;
        }
    }

    static async ensureListExists(name: string, lists?: ReminderListInfo[], options?: GuardOptions): Promise<string> {
        const allLists = lists ?? (await MacReminders.listLists(options));
        const existing = allLists.find((l) => l.title === name);

        if (existing) {
            return existing.identifier;
        }

        throw new Error(`Reminder list "${name}" does not exist. Create it manually in Reminders.app.`);
    }
}
