import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pinnedLaunchEnv } from "@app/claude/lib/launch-env";
import { resolveClaudeBinaryForTeammates } from "@app/claude/lib/teammate-wrapper";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { buildWorkerContract } from "@genesiscz/utils/worker/contract";
import { isText, isTurnCompleted, isTurnFailed, type WorkerEvent } from "@genesiscz/utils/worker/events";
import { workerTurnErrPath, workerTurnLogPath } from "./paths";
import { type ClaudeWorkerMeta, ClaudeWorkerStore } from "./store";
import { parseTurnEvents } from "./stream";

const log = logger.child({ component: "claude:worker" });

export interface PinnedAccount {
    name: string;
    label?: string;
    token: string;
}

export interface SpawnWorkerOptions {
    name: string;
    account: PinnedAccount;
    cwd: string;
    prompt: string;
    model?: string;
    /** Pass claude's --safe-mode so the child skips CLAUDE.md/hooks/MCP. A bare turn in this repo without it cost $0.11 in config cache-writes alone (measured 2026-09-01). */
    safeMode?: boolean;
}

export interface SteerWorkerOptions {
    name: string;
    account: PinnedAccount;
    prompt: string;
}

export interface ClaudeTurnResult {
    meta: ClaudeWorkerMeta;
    turn: number;
    events: WorkerEvent[];
    /** The final assistant text of the turn, if any. */
    report: string;
    completed: boolean;
    exitCode: number | null;
    stderr: string;
    logPath: string;
}

/**
 * The prompt is deliberately absent: it goes in on stdin, which `claude -p`
 * reads when no positional prompt is given ("Input must be provided either
 * through stdin or as a prompt argument when using --print"). An argv element
 * is world-readable in `ps` for the whole turn, and this prompt can carry
 * credentials or private code.
 */
export function turnArgs(options: { meta: { sessionId: string; model?: string }; first: boolean; safeMode?: boolean }) {
    const { meta, first, safeMode } = options;
    const args = ["-p", "--output-format", "stream-json", "--verbose"];
    if (first) {
        args.push("--session-id", meta.sessionId);
    } else {
        args.push("--resume", meta.sessionId);
    }

    if (meta.model) {
        args.push("--model", meta.model);
    }

    if (safeMode) {
        args.push("--safe-mode");
    }

    // The shared worker contract, on every turn: --append-system-prompt is per
    // invocation, and --safe-mode is the one switch that drops the user's surfaces.
    args.push(
        "--append-system-prompt",
        buildWorkerContract({
            backend: "claude",
            sandbox: "none",
            surfaces: safeMode ? { skills: false, rules: false } : { skills: true, rules: true },
        })
    );
    return args;
}

/**
 * Claim turn N: create its transcript with O_EXCL, then record the claim in meta
 * BEFORE the child spawns.
 *
 * `turns` used to advance only after a clean exit, so a parent killed mid-turn
 * (Ctrl-C, closed terminal) left an orphan `<name>.turnN.jsonl` behind while
 * meta still said N-1. Every later steer computed turn N again, hit this
 * EEXIST, and the worker was dead — no verb could clear the file.
 */
export function claimTurnLog(args: { store: ClaudeWorkerStore; name: string; turn: number }): number {
    const { store, name, turn } = args;
    let fd: number;

    try {
        // 0600: the transcript carries the prompt, tool output and whatever the
        // worker read, none of it for other local users.
        fd = openSync(workerTurnLogPath(name, turn), "wx", 0o600);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(
                `Turn ${turn} of claude worker '${name}' already has a transcript — another turn is running or died uncleanly. Read it with 'tools claude worker read --name ${name} --turn ${turn}'.`
            );
        }

        throw err;
    }

    store.updateMeta(name, { turns: turn });

    return fd;
}

interface RunTurnOptions {
    store: ClaudeWorkerStore;
    meta: ClaudeWorkerMeta;
    account: PinnedAccount;
    turn: number;
    prompt: string;
    safeMode?: boolean;
}

async function runTurn(options: RunTurnOptions): Promise<ClaudeTurnResult> {
    const { store, meta, account, turn, prompt, safeMode } = options;

    if (account.name !== meta.account) {
        // The identity is the whole point of this backend: a turn on a different
        // account splits the conversation's billing and its usage window.
        throw new Error(
            `Claude worker '${meta.name}' is pinned to account '${meta.account}'; refusing to run a turn as '${account.name}'.`
        );
    }

    // Never bare Bun.which here: under `bun run`, node_modules/.bin is first on
    // PATH and resolves this repo's vendored @anthropic-ai/claude-code CLI
    // (2.1.45 — no --safe-mode, refuses to nest). The teammate resolver prefers
    // the user's real install for exactly this reason.
    const binary = resolveClaudeBinaryForTeammates();

    const logPath = workerTurnLogPath(meta.name, turn);
    const errPath = workerTurnErrPath(meta.name, turn);
    const args = turnArgs({ meta, first: turn === 1, safeMode });
    // The prompt is user text and can carry credentials or private code, so the
    // day-stamped log gets the shape of the invocation, never its payload.
    log.info({ name: meta.name, turn, account: account.name, logPath }, "starting claude worker turn");

    const logFd = claimTurnLog({ store, name: meta.name, turn });
    let errFd: number;

    try {
        errFd = openSync(errPath, "w", 0o600);
    } catch (err) {
        closeSync(logFd);
        throw err;
    }

    // The worker is routinely spawned FROM a Claude Code session (that is what
    // a handoff is), and the claude CLI refuses to start when it sees the
    // parent's CLAUDECODE marker: "Claude Code cannot be launched inside
    // another Claude Code session… unset the CLAUDECODE environment variable."
    // The session markers go with it so the child never mistakes itself for
    // the parent's session.
    const childEnv: Record<string, string | undefined> = {
        ...env.getProcessEnv(),
        ...pinnedLaunchEnv({ name: account.name, label: account.label }, account.token),
    };
    delete childEnv.CLAUDECODE;
    delete childEnv.CLAUDE_CODE_SESSION_ID;
    delete childEnv.CLAUDE_CODE_ENTRYPOINT;

    let exitCode: number | null = null;
    try {
        const proc = Bun.spawn({
            cmd: [binary, ...args],
            cwd: meta.cwd,
            env: childEnv,
            // The prompt reaches the child here, never as an argv element.
            stdin: new TextEncoder().encode(prompt),
            stdout: logFd,
            stderr: errFd,
        });
        exitCode = await proc.exited;
    } finally {
        closeSync(logFd);
        closeSync(errFd);
    }

    const transcript = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    const events = parseTurnEvents(transcript, meta.sessionId);
    const completed = events.some(isTurnCompleted) && !events.some(isTurnFailed);
    const report = events.filter(isText).at(-1)?.text ?? "";
    const stderr = existsSync(errPath) ? readFileSync(errPath, "utf8") : "";
    const updated = store.updateMeta(meta.name, {
        turns: turn,
        lastTurn: { turn, exitCode, at: new Date().toISOString() },
    });
    log.info({ name: meta.name, turn, exitCode, completed, events: events.length }, "claude worker turn finished");

    return { meta: updated, turn, events, report, completed, exitCode, stderr, logPath };
}

export async function spawnWorker(options: SpawnWorkerOptions): Promise<ClaudeTurnResult> {
    const store = new ClaudeWorkerStore();
    const meta: ClaudeWorkerMeta = {
        name: options.name,
        sessionId: crypto.randomUUID(),
        account: options.account.name,
        cwd: resolve(options.cwd),
        model: options.model,
        safeMode: options.safeMode || undefined,
        turns: 0,
        createdAt: new Date().toISOString(),
    };
    store.createMeta(meta);

    return runTurn({ store, meta, account: options.account, turn: 1, prompt: options.prompt, safeMode: meta.safeMode });
}

export async function steerWorker(options: SteerWorkerOptions): Promise<ClaudeTurnResult> {
    const store = new ClaudeWorkerStore();
    const meta = store.readMeta(options.name);
    if (!meta) {
        throw new Error(`Claude worker not found: ${options.name}. Start one with 'tools claude worker spawn'.`);
    }

    return runTurn({
        store,
        meta,
        account: options.account,
        turn: meta.turns + 1,
        prompt: options.prompt,
        safeMode: meta.safeMode,
    });
}
