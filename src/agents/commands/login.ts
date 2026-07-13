import { logger, out } from "@app/logger";
import { isInteractive } from "@app/utils/cli";
import { watchFileFeed } from "@app/utils/fs/file-feed-watcher";
import { SafeJSON } from "@app/utils/json";
import type { Command } from "commander";
import { readCursor, writeCursor } from "../lib/cursor";
import { deriveRegistry, findById, findByName, nextSubagentId } from "../lib/derived-registry";
import { FriendlyError, runWithFriendlyErrors } from "../lib/errors";
import { readFeedSince, withFeedLock } from "../lib/feed";
import { isVisibleToAgent } from "../lib/filter";
import { formatEventPretty } from "../lib/format-pretty";
import { deriveMainAgentId, isMainId } from "../lib/id-gen";
import { onShutdown } from "../lib/lifecycle";
import { ensureSessionDir, sessionPaths } from "../lib/paths";
import { readSessionMeta, type SessionMeta } from "../lib/session-meta";
import { resolveSession } from "../lib/session-resolve";
import { readSlotPayload, releaseSlot, runStaleSweep, slotLockPath, tryAcquireSlot } from "../lib/slot-lock";
import type { AgentRecord, FeedEvent, SessionPaths, SlotLockPayload } from "../lib/types";

const ONE_HOUR_MS = 60 * 60 * 1000;

const log = logger.child({ component: "agents:login" });

interface LoginOpts {
    agentId?: string;
    agentName?: string;
    agentMain?: boolean;
    role?: string;
    meta?: string;
    debug?: boolean;
    once?: boolean;
    session?: string;
    observer?: boolean;
    format?: "pretty" | "json";
}

interface ActiveLogin {
    paths: SessionPaths;
    record: AgentRecord;
    lockPath: string;
    mode: "stream" | "once";
    meta: SessionMeta;
    observer: boolean;
    format: "pretty" | "json";
    cursorSeq: number;
}

async function pickAgent(records: AgentRecord[]): Promise<AgentRecord | null> {
    if (records.length === 0) {
        return null;
    }

    if (records.length === 1 && records[0]) {
        return records[0];
    }

    if (!isInteractive()) {
        return null;
    }

    const { select } = await import("@app/utils/prompts/clack");
    const choices = records.map((r) => ({
        label: `${r.agent_name} (${r.agent_id || "awaiting login"})${r.is_main ? " — main" : ""}`,
        value: r.agent_id || r.agent_name,
    }));
    const picked = await select({ message: "Which agent should I log in as?", options: choices });

    if (typeof picked !== "string") {
        return null;
    }

    const found = findById(records, picked) ?? records.find((r) => r.agent_name === picked) ?? null;
    return found;
}

function parseMeta(raw: string | undefined): Record<string, unknown> {
    if (!raw) {
        return {};
    }

    const parsed = SafeJSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new FriendlyError("--meta must be a JSON object", `Example: --meta '{"role":"reader"}'`);
    }

    return parsed as Record<string, unknown>;
}

/**
 * Resolve which agent we're attaching as — or atomically register a new one.
 *
 * Both branches (lookup-existing + create-new) run inside ONE withFeedLock
 * critical section so two parallel `login --agent-name X` invocations cannot
 * derive the same agt_xxxx id and double-register.
 */
async function findOrRegisterAgent(paths: SessionPaths, opts: LoginOpts): Promise<AgentRecord> {
    if (!opts.agentId && !opts.agentName) {
        // No --agent-id/--agent-name to resolve or register — just an interactive
        // pick from the existing registry. Read outside withFeedLock so
        // pickAgent()'s prompt (which can wait indefinitely on user input) never
        // holds the feed lock and blocks every other agent's send/login/lifecycle
        // append for the session.
        const { readFeed } = await import("../lib/feed");
        const registry = deriveRegistry(await readFeed(paths));
        const picked = await pickAgent(registry);

        if (picked) {
            return picked;
        }

        throw new FriendlyError(
            registry.length === 0
                ? `no agents in session "${paths.session}"; log in with --agent-name <name>`
                : "--agent-id or --agent-name is required (multiple agents in session; could not auto-pick)",
            registry.length === 0
                ? `Example:\n  tools agents login --agent-name lead --agent-main\n  tools agents login --agent-name researcher`
                : `Available agents in "${paths.session}":\n  ${registry.map((r) => `tools agents login --agent-name ${r.agent_name}`).join("\n  ")}`
        );
    }

    return withFeedLock(paths, async ({ events, appendNonMessage }) => {
        const registry = deriveRegistry(events);

        if (opts.agentId) {
            const found = findById(registry, opts.agentId);

            if (found) {
                if (opts.agentName && found.agent_name !== opts.agentName) {
                    throw new FriendlyError(
                        `agent_id ${opts.agentId} belongs to "${found.agent_name}", not "${opts.agentName}"`,
                        "Pass either the matching --agent-name, or omit --agent-name when using --agent-id."
                    );
                }

                return found;
            }

            // explicit id, not registered — register with that exact id
            const isMain = opts.agentMain ?? isMainId(opts.agentId);

            if (isMain && registry.some((r) => r.is_main)) {
                const existingMain = registry.find((r) => r.is_main);
                throw new FriendlyError(
                    `a main agent is already registered for this session (${existingMain?.agent_name ?? "?"})`,
                    `Pick a different --agent-name without --agent-main, OR target a fresh --session.`
                );
            }

            return registerInLock({
                appendNonMessage,
                agentId: opts.agentId,
                agentName: opts.agentName ?? opts.agentId,
                isMain,
                role: opts.role ?? null,
                meta: parseMeta(opts.meta),
            });
        }

        if (opts.agentName) {
            const found = findByName(registry, opts.agentName);

            if (found) {
                return found;
            }

            const isMain = Boolean(opts.agentMain);

            if (isMain && registry.some((r) => r.is_main)) {
                const existingMain = registry.find((r) => r.is_main);
                throw new FriendlyError(
                    `a main agent is already registered for this session (${existingMain?.agent_name ?? "?"})`,
                    `Pick a different --agent-name without --agent-main, OR target a fresh --session.`
                );
            }

            const id = isMain ? deriveMainAgentId(paths.session) : nextSubagentId(registry);

            if (findById(registry, id)) {
                throw new FriendlyError(
                    `derived agent_id ${id} is already taken`,
                    `Pass an explicit --agent-id instead.`
                );
            }

            return registerInLock({
                appendNonMessage,
                agentId: id,
                agentName: opts.agentName,
                isMain,
                role: opts.role ?? null,
                meta: parseMeta(opts.meta),
            });
        }

        // unreachable: the !opts.agentId && !opts.agentName case is handled above,
        // before entering withFeedLock, and one of opts.agentId/opts.agentName is
        // always set by the time we reach here.
        throw new FriendlyError(
            "--agent-id or --agent-name is required",
            `Example:\n  tools agents login --agent-name lead --agent-main\n  tools agents login --agent-name researcher`
        );
    });
}

function registerInLock(opts: {
    appendNonMessage: (event: {
        type: "registered";
        agent_name: string;
        agent_id: string;
        awaiting_login: boolean;
        is_main: boolean;
        role: string | null;
        meta: Record<string, unknown>;
    }) => FeedEvent;
    agentId: string;
    agentName: string;
    isMain: boolean;
    role: string | null;
    meta: Record<string, unknown>;
}): AgentRecord {
    log.debug({ agentName: opts.agentName, agentId: opts.agentId }, "auto-registering via login");

    const event = opts.appendNonMessage({
        type: "registered",
        agent_name: opts.agentName,
        agent_id: opts.agentId,
        awaiting_login: false,
        is_main: opts.isMain,
        role: opts.role,
        meta: opts.meta,
    });

    return {
        agent_id: opts.agentId,
        agent_name: opts.agentName,
        is_main: opts.isMain,
        role: opts.role,
        registered_at: event.ts,
        logged_in_at: null,
        logged_out_at: null,
        mode: null,
        meta: opts.meta,
    };
}

function claimSlot({ paths, record, mode }: { paths: SessionPaths; record: AgentRecord; mode: "stream" | "once" }): {
    lockPath: string;
} {
    const lockPath = slotLockPath(paths, record.agent_id);
    const payload: SlotLockPayload = {
        pid: process.pid,
        since: new Date().toISOString(),
        owner: record.agent_id,
        kind: "login",
        mode,
    };

    if (!tryAcquireSlot(lockPath, payload)) {
        const existing = readSlotPayload(lockPath);
        const heldBy = existing ? `pid ${existing.pid} since ${existing.since}` : "an unknown process";
        throw new FriendlyError(
            `another login for ${payload.owner} is already held by ${heldBy}`,
            existing
                ? `Stop the other login first: kill ${existing.pid}\nDead PIDs are reaped automatically on the next register/login.`
                : "Try again — the stale-lock sweep should reap unreadable locks on the next attempt."
        );
    }

    return { lockPath };
}

function emitVisibleEvent(event: FeedEvent, active: ActiveLogin): boolean {
    if (!active.observer && !isVisibleToAgent(event, active.record, active.meta)) {
        return false;
    }

    if (active.format === "pretty") {
        out.println(formatEventPretty(event));
    } else {
        out.println(SafeJSON.stringify(event, { strict: true }));
    }

    return true;
}

async function drainPending(active: ActiveLogin): Promise<number> {
    const events = await readFeedSince(active.paths, active.cursorSeq);
    let lastSeq = active.cursorSeq;
    let emitted = 0;

    for (const event of events) {
        if (emitVisibleEvent(event, active)) {
            emitted += 1;
        }

        if (event.seq > lastSeq) {
            lastSeq = event.seq;
        }
    }

    if (lastSeq > active.cursorSeq) {
        active.cursorSeq = lastSeq;
        writeCursor(active.paths, active.record.agent_id, lastSeq);
    }

    return emitted;
}

async function watchUntilDeadline(active: ActiveLogin, deadlineAt: number, exitOnFirst: boolean): Promise<void> {
    await watchFileFeed({
        path: active.paths.feedPath,
        deadlineAt,
        onChange: async () => {
            const before = active.cursorSeq;
            const emitted = await drainPending(active);

            if (emitted > 0) {
                log.debug({ before, after: active.cursorSeq }, "drained while watching");

                if (exitOnFirst) {
                    return { done: true };
                }
            }
        },
    });
}

async function emitLoggedIn({
    paths,
    record,
    mode,
}: {
    paths: SessionPaths;
    record: AgentRecord;
    mode: "stream" | "once";
}): Promise<void> {
    const { appendFeed } = await import("../lib/feed");
    await appendFeed(paths, {
        type: "logged_in",
        agent_id: record.agent_id,
        agent_name: record.agent_name,
        mode,
    });
}

async function emitLoggedOut({
    paths,
    record,
    reason,
    mode,
}: {
    paths: SessionPaths;
    record: AgentRecord;
    reason: "signal" | "clean_exit" | "cap";
    mode: "stream" | "once";
}): Promise<void> {
    const { appendFeed } = await import("../lib/feed");
    await appendFeed(paths, {
        type: "logged_out",
        agent_id: record.agent_id,
        reason,
        mode,
    });
}

function emitResumeHint(record: AgentRecord, mode: "stream" | "once"): void {
    const parts = ["tools", "agents", "login", "--agent-id", record.agent_id];

    if (mode === "once") {
        parts.push("--once");
    }

    process.stderr.write(`\n# To resume listening:\n${parts.join(" ")}\n`);
}

async function runLoginImpl(opts: LoginOpts): Promise<void> {
    const resolved = resolveSession(opts.session);

    if (resolved.note) {
        out.log.warn(resolved.note);
    }

    const paths = sessionPaths(resolved.session);
    ensureSessionDir(paths);
    await runStaleSweep(paths);

    if (opts.debug) {
        const { updateSessionMeta } = await import("../lib/session-meta");
        await updateSessionMeta(paths, { debug: true });
        log.debug({ session: paths.session }, "session debug mode enabled");
    }

    const record = await findOrRegisterAgent(paths, opts);
    const mode: "stream" | "once" = opts.once ? "once" : "stream";
    const { lockPath } = claimSlot({ paths, record, mode });

    // claimSlot() succeeded — from here until the onShutdown handler below is
    // registered, a thrown error would otherwise skip releaseSlot() entirely
    // (no finally covers this span), permanently locking out this agent_id
    // until stale-lock reaping. Release explicitly on any setup failure.
    let active: ActiveLogin;

    try {
        const meta = readSessionMeta(paths);
        const format: "pretty" | "json" = opts.format ?? (opts.observer && process.stdout.isTTY ? "pretty" : "json");
        active = {
            paths,
            record,
            lockPath,
            mode,
            meta,
            observer: Boolean(opts.observer),
            format,
            cursorSeq: readCursor(paths, record.agent_id),
        };

        await emitLoggedIn({ paths, record, mode });
    } catch (err) {
        releaseSlot(lockPath);
        throw err;
    }

    let exitReason: "signal" | "clean_exit" | "cap" = "clean_exit";

    onShutdown(async (reason) => {
        exitReason = reason;

        // Release the PID lock BEFORE any feed I/O: if the process dies
        // mid-drain (force-kill, lock timeout), the slot must not stay
        // orphaned. Worst case of the reversed order is a same-agent relogin
        // racing the final cursor write — duplicate delivery, never loss.
        releaseSlot(lockPath);

        try {
            await drainPending(active);
        } catch (err) {
            log.warn({ err }, "final drain failed during shutdown");
        }

        try {
            await emitLoggedOut({ paths, record: active.record, reason, mode });
        } catch (err) {
            log.warn({ err }, "logged_out emit failed during shutdown");
        }

        emitResumeHint(active.record, mode);
    });

    if (isMainId(record.agent_id)) {
        log.debug({ agentId: record.agent_id }, "main agent logged in");
    }

    try {
        if (mode === "once") {
            const initialEmitted = await drainPending(active);

            if (initialEmitted === 0) {
                const deadline = Date.now() + ONE_HOUR_MS;
                await watchUntilDeadline(active, deadline, true);
            }
        } else {
            const deadline = Date.now() + ONE_HOUR_MS;
            await watchUntilDeadline(active, deadline, false);
            exitReason = "cap";
        }
    } finally {
        releaseSlot(lockPath);

        try {
            await drainPending(active);
        } catch (err) {
            log.warn({ err }, "final drain failed");
        }

        try {
            await emitLoggedOut({ paths, record: active.record, reason: exitReason, mode });
        } catch (err) {
            log.warn({ err }, "logged_out emit failed on exit");
        }

        emitResumeHint(active.record, mode);
    }
}

export async function runLogin(opts: LoginOpts): Promise<void> {
    await runWithFriendlyErrors(() => runLoginImpl(opts));
}

export function registerLoginCommand(program: Command): void {
    program
        .command("login")
        .description("Attach as an agent and receive messages (auto-registers if --agent-name is new)")
        .option("--agent-id <id>", "Agent ID (auto-generated if omitted; main_ prefix added when --agent-main)")
        .option("--agent-name <name>", "Agent name (unique per session; auto-registers if new)")
        .option("--agent-main", "Mark this agent as the session's main (one per session, must come with --agent-name)")
        .option("--role <role>", "Optional role label stored on the agent record")
        .option("--meta <json>", "Optional JSON object stored on the agent record")
        .option("--debug", "Enable session debug mode: lifecycle events visible to all agents on the feed")
        .option("--once", "Read pending and exit (or wait for first message, then exit)")
        .option("--session <id>", "Override session resolution")
        .option("--observer", "Read-only: bypass per-agent visibility filter and see ALL events")
        .option("--format <fmt>", "pretty | json (default: json; observer in TTY → pretty)")
        .action(async (opts: LoginOpts) => {
            await runLogin(opts);
        });
}
