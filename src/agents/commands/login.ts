import { randomUUID } from "node:crypto";
import { isInteractive } from "@genesiscz/utils/cli";
import { asResult } from "@genesiscz/utils/cli/result";
import { writeStdout } from "@genesiscz/utils/cli/stdout";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { readProcessCommand } from "@genesiscz/utils/process-identity";
import type { Command } from "commander";
import { readCursor, writeCursor } from "../lib/cursor";
import { deriveRegistry, findById, findByName, nextSubagentId } from "../lib/derived-registry";
import { FriendlyError, runWithFriendlyErrors } from "../lib/errors";
import { FeedLogCursor, withFeedLock } from "../lib/feed";
import { isVisibleToAgent } from "../lib/filter";
import { formatEventPretty } from "../lib/format-pretty";
import { deriveMainAgentId, isMainId } from "../lib/id-gen";
import { announceLeave, leaveReasonOf, logInAndAnnounceJoin } from "../lib/leave";
import { onShutdown } from "../lib/lifecycle";
import { createListenerFilter } from "../lib/listener-filter";
import { formatReadyEvent, loginStderrAllowed, writeLoginJsonLine } from "../lib/login-io";
import { ensureSessionDir, sessionPaths } from "../lib/paths";
import { readSessionMeta, type SessionMeta } from "../lib/session-meta";
import { resolveSession } from "../lib/session-resolve";
import { readSlotPayload, releaseSlot, runStaleSweep, slotLockPath, tryAcquireSlot } from "../lib/slot-lock";
import type { AgentRecord, FeedEvent, SessionPaths, SlotLockPayload } from "../lib/types";

const LISTEN_CAP_MS = 8 * 60 * 60 * 1000;
const WATCH_DEBOUNCE_MS = 0;
const WATCH_POLL_MS = 150;

const log = logger.child({ component: "agents:login" });

interface LoginOpts {
    agentId?: string;
    agentName?: string;
    agentMain?: boolean;
    role?: string;
    meta?: string;
    debug?: boolean;
    once?: boolean;
    timeout?: string;
    session?: string;
    observer?: boolean;
    format?: "pretty" | "json";
    kinds?: string;
    filter?: string;
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
    feedCursor: FeedLogCursor;
    listenerFilter: (event: FeedEvent) => boolean;
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

    const { select } = await import("@genesiscz/utils/prompts/clack");
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
                ? `Example:\n  ${toolCommand("agents login", "--agent-name", "lead", "--agent-main")}\n  ${toolCommand("agents login", "--agent-name", "researcher")}`
                : `Available agents in "${paths.session}":\n  ${registry.map((r) => toolCommand("agents login", "--agent-name", r.agent_name)).join("\n  ")}`
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
            `Example:\n  ${toolCommand("agents login", "--agent-name", "lead", "--agent-main")}\n  ${toolCommand("agents login", "--agent-name", "researcher")}`
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
        registered_seq: event.seq,
        logged_in_at: null,
        logged_out_at: null,
        mode: null,
        meta: opts.meta,
    };
}

function claimSlot({
    paths,
    record,
    mode,
    loginId,
}: {
    paths: SessionPaths;
    record: AgentRecord;
    mode: "stream" | "once";
    loginId: string;
}): {
    lockPath: string;
} {
    const lockPath = slotLockPath(paths, record.agent_id);
    const payload: SlotLockPayload = {
        pid: process.pid,
        command: readProcessCommand(process.pid) ?? undefined,
        since: new Date().toISOString(),
        owner: record.agent_id,
        kind: "login",
        mode,
        login_id: loginId,
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

async function emitVisibleEvent(event: FeedEvent, active: ActiveLogin): Promise<boolean> {
    if (!active.observer && !isVisibleToAgent(event, active.record, active.meta)) {
        return false;
    }

    if (!active.listenerFilter(event)) {
        return false;
    }

    if (active.format === "pretty") {
        await writeStdout(asResult(formatEventPretty(event)));
    } else {
        await writeLoginJsonLine(event);
    }

    return true;
}

async function drainPending(active: ActiveLogin): Promise<number> {
    const events = await active.feedCursor.readAppended();
    let lastSeq = active.cursorSeq;
    let emitted = 0;

    for (const event of events) {
        if (await emitVisibleEvent(event, active)) {
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

async function watchUntilDeadline(active: ActiveLogin, deadlineAt: number, exitOnFirst: boolean): Promise<boolean> {
    let emittedAny = false;

    await watchFileFeed({
        path: active.paths.feedPath,
        deadlineAt,
        debounceMs: WATCH_DEBOUNCE_MS,
        pollFallbackMs: WATCH_POLL_MS,
        onChange: async () => {
            const before = active.cursorSeq;
            const emitted = await drainPending(active);

            if (emitted > 0) {
                emittedAny = true;
                log.debug({ before, after: active.cursorSeq }, "drained while watching");

                if (exitOnFirst) {
                    return { done: true };
                }
            }
        },
    });

    return emittedAny;
}

/** Exit status of a `--once --timeout` that expired with an empty mailbox. 124 is what coreutils `timeout` uses. */
export const LOGIN_TIMEOUT_EXIT = 124;

function parseTimeoutSeconds(opts: LoginOpts): number | undefined {
    if (opts.timeout === undefined) {
        return undefined;
    }

    if (!opts.once) {
        throw new FriendlyError(
            "--timeout only applies to --once",
            "Add --once, or bound a stream with your own timeout."
        );
    }

    const seconds = Number(opts.timeout.trim());

    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new FriendlyError(
            `--timeout must be a positive number of seconds (got ${opts.timeout})`,
            "Example: --timeout 300"
        );
    }

    return seconds;
}

async function emitLoggedIn({
    paths,
    record,
    mode,
    loginId,
}: {
    paths: SessionPaths;
    record: AgentRecord;
    mode: "stream" | "once";
    loginId: string;
}): Promise<void> {
    await logInAndAnnounceJoin(paths, {
        agent_id: record.agent_id,
        agent_name: record.agent_name,
        mode,
        login_id: loginId,
    });
}

async function emitLoggedOut({
    paths,
    record,
    reason,
    mode,
    loginId,
}: {
    paths: SessionPaths;
    record: AgentRecord;
    reason: "signal" | "clean_exit" | "cap";
    mode: "stream" | "once";
    loginId: string;
}): Promise<void> {
    const { appendFeed } = await import("../lib/feed");
    await appendFeed(paths, {
        type: "logged_out",
        agent_id: record.agent_id,
        reason,
        mode,
    });

    // Both the shutdown handler and the finally block end a login; one leave per process.
    const leaveReason = leaveReasonOf(mode, reason);
    if (!leaveAnnounced && leaveReason) {
        leaveAnnounced = true;
        // The slot is already released, so a replacement login may be current by now: the leave names this
        // login, and announceLeave drops it when a newer one took over.
        await announceLeave(paths, {
            agent_id: record.agent_id,
            agent_name: record.agent_name,
            reason: leaveReason,
            login_id: loginId,
        });
    }
}

let leaveAnnounced = false;

function emitResumeHint(record: AgentRecord, mode: "stream" | "once"): void {
    const parts = ["tools", "agents", "login", "--agent-id", record.agent_id];

    if (mode === "once") {
        parts.push("--once");
    }

    const hint = `\n# To resume listening:\n${parts.join(" ")}\n`;

    if (loginStderrAllowed()) {
        process.stderr.write(hint);
    } else {
        log.debug({ resume: parts.join(" ") }, "resume hint (stderr silenced for monitor)");
    }
}

async function runLoginImpl(opts: LoginOpts): Promise<void> {
    const timeoutSeconds = parseTimeoutSeconds(opts);
    const resolved = resolveSession(opts.session);

    if (resolved.note) {
        if (loginStderrAllowed()) {
            out.log.warn(resolved.note);
        } else {
            log.debug(resolved.note);
        }
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
    const loginId = randomUUID();
    const { lockPath } = claimSlot({ paths, record, mode, loginId });

    // claimSlot() succeeded — from here until the onShutdown handler below is
    // registered, a thrown error would otherwise skip releaseSlot() entirely
    // (no finally covers this span), permanently locking out this agent_id
    // until stale-lock reaping. Release explicitly on any setup failure.
    let active: ActiveLogin;

    try {
        const meta = readSessionMeta(paths);
        const format: "pretty" | "json" = opts.format ?? (opts.observer && process.stdout.isTTY ? "pretty" : "json");
        const cursorSeq = readCursor(paths, record.agent_id);
        active = {
            paths,
            record,
            lockPath,
            mode,
            meta,
            observer: Boolean(opts.observer),
            format,
            cursorSeq,
            feedCursor: new FeedLogCursor({ paths, sinceSeq: cursorSeq }),
            listenerFilter: createListenerFilter({ kinds: opts.kinds, expression: opts.filter }),
        };

        await emitLoggedIn({ paths, record, mode, loginId });
        await writeLoginJsonLine(formatReadyEvent(record, paths.session, mode));
    } catch (err) {
        releaseSlot(lockPath);
        throw err;
    }

    let exitReason: "signal" | "clean_exit" | "cap" = "clean_exit";
    // Set once a timeout is reported: mail that lands after it stays queued for the next login, so exit
    // 124 always means "nothing was delivered".
    let timedOut = false;

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
            await emitLoggedOut({ paths, record: active.record, reason, mode, loginId });
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
                // Nothing queued: this blocks until a message arrives, for up
                // to the cap. Say so on stderr, or a caller that times out
                // sees an empty stdout and a live process and cannot tell
                // "waiting" from "crashed before it printed anything".
                if (loginStderrAllowed()) {
                    out.log.info(
                        `${record.agent_name}: mailbox empty — waiting for the first message (up to ${Math.round(
                            LISTEN_CAP_MS / 3_600_000
                        )}h). Nothing will print until one arrives.`
                    );
                } else {
                    log.debug(
                        { agentName: record.agent_name },
                        "mailbox empty — waiting for the first message (stderr silenced for monitor)"
                    );
                }
                const startedAt = Date.now();
                const deadline =
                    startedAt + Math.min(LISTEN_CAP_MS, (timeoutSeconds ?? Number.POSITIVE_INFINITY) * 1000);
                const received = await watchUntilDeadline(active, deadline, true);
                // Mail that landed between the watcher's last look and the deadline is delivered, not a timeout.
                const late = received ? 0 : await drainPending(active);

                // Nobody is listening once this returns, unless the agent starts it again (then that is a join):
                // `timeout` when --timeout ended the wait, `cap` when the receiver waited the whole cap.
                if (!received && late === 0 && !leaveAnnounced) {
                    leaveAnnounced = true;
                    await announceLeave(paths, {
                        agent_id: record.agent_id,
                        agent_name: record.agent_name,
                        reason: timeoutSeconds !== undefined ? "timeout" : "cap",
                        login_id: loginId,
                    });
                }

                if (!received && late === 0 && timeoutSeconds !== undefined) {
                    timedOut = true;
                    process.exitCode = LOGIN_TIMEOUT_EXIT;

                    await writeLoginJsonLine({
                        type: "timeout",
                        agent_name: record.agent_name,
                        session: paths.session,
                        waited_ms: Date.now() - startedAt,
                    });
                }
            }
        } else {
            const deadline = Date.now() + LISTEN_CAP_MS;
            await watchUntilDeadline(active, deadline, false);
            exitReason = "cap";
        }
    } finally {
        releaseSlot(lockPath);

        if (timedOut) {
            log.debug({ agentName: record.agent_name }, "timed out: late mail stays queued for the next login");
        } else {
            try {
                await drainPending(active);
            } catch (err) {
                log.warn({ err }, "final drain failed");
            }
        }

        try {
            await emitLoggedOut({ paths, record: active.record, reason: exitReason, mode, loginId });
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
        .option(
            "--timeout <seconds>",
            'With --once and an empty mailbox: give up after this long, print {"type":"timeout"} and exit 124'
        )
        .option("--session <id>", "Override session resolution")
        .option("--observer", "Read-only: bypass per-agent visibility filter and see ALL events")
        .option("--format <fmt>", "pretty | json (default: json; observer in TTY → pretty)")
        .option("--kinds <csv>", "Only emit feed types or structured message op/event kinds")
        .option("--filter <expr>", 'Filter structured bodies, e.g. .op=="approval_request"')
        .action(async (opts: LoginOpts) => {
            await runLogin(opts);
        });
}
