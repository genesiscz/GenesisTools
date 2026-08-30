import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assignedSessionId, resolveAgentHost } from "@genesiscz/utils/agent-host";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { defaultWorkerHome, turnErrPath, turnLogPath } from "./paths";
import { type GrokSessionMeta, GrokSessionStore } from "./store";
import { type GrokTurnSummary, parseTurnLog } from "./stream";

const log = logger.child({ component: "grok:worker" });

/**
 * Without these toggles the worker loads the user's ~/.claude compat config
 * (CLAUDE.md rules, settings.local.json permissions, ~200 personal skills)
 * and acts on it. A fresh GROK_HOME alone does NOT stop that pickup.
 */
const ISOLATION_ENV: Record<string, string> = {
    GROK_CLAUDE_SKILLS_ENABLED: "0",
    GROK_CLAUDE_RULES_ENABLED: "0",
    GROK_CLAUDE_AGENTS_ENABLED: "0",
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_CLAUDE_HOOKS_ENABLED: "0",
    GROK_CLAUDE_SESSIONS_ENABLED: "0",
};

const READ_ONLY_TOOLS = "read_file,list_dir,grep";

export interface RunSessionOptions {
    name: string;
    cwd: string;
    prompt?: string;
    promptFile?: string;
    model?: string;
    readOnly: boolean;
    workerHome?: string;
}

export interface SteerSessionOptions {
    name: string;
    prompt?: string;
    promptFile?: string;
    readOnly?: boolean;
}

export interface TurnResult {
    meta: GrokSessionMeta;
    turn: number;
    summary: GrokTurnSummary;
    exitCode: number | null;
    stderr: string;
    logPath: string;
    errPath: string;
}

/**
 * The environment a worker turn runs under.
 *
 * ISOLATION_ENV is applied AFTER the caller's environment on purpose: whoever
 * launches `tools grok` may already export GROK_CLAUDE_SKILLS_ENABLED=1, and
 * letting that through would hand the worker the user's personal rules, skills
 * and hooks. Extracted so the isolation contract is asserted rather than
 * described (PR #330 review t2).
 */
export function buildTurnEnv(
    baseEnv: Record<string, string | undefined>,
    workerHome: string,
    rendezvousSession?: string | null
): Record<string, string | undefined> {
    return {
        ...baseEnv,
        GROK_HOME: workerHome,
        // The swarm the worker must join. Without it the worker would fall back
        // to a host session id and could start a swarm its parent is not in.
        ...(rendezvousSession ? { GT_RENDEZVOUS_SESSION: rendezvousSession } : {}),
        ...ISOLATION_ENV,
    };
}

/** Arguments for the first turn of a session. */
export function buildRunArgs(
    session: { sessionId: string; model?: string; readOnly: boolean },
    promptArguments: string[]
): string[] {
    const args = [...promptArguments, "--session-id", session.sessionId];
    if (session.model) {
        args.push("-m", session.model);
    }

    if (session.readOnly) {
        args.push("--tools", READ_ONLY_TOOLS);
    }

    return args;
}

/**
 * Arguments for a resumed turn. `--tools` is re-armed every time because the
 * grok CLI drops safety flags on `--resume`; without this a session started
 * read-only silently gains write tools from turn 2 onward.
 */
export function buildSteerArgs(session: { sessionId: string }, readOnly: boolean, promptArguments: string[]): string[] {
    const args = [...promptArguments, "--resume", session.sessionId];
    if (readOnly) {
        args.push("--tools", READ_ONLY_TOOLS);
    }

    return args;
}

export function resolveGrokBinary(): string {
    // `Bun.which("grok")` searches the PATH the PROCESS STARTED WITH, not the
    // current one, so a PATH set after startup is invisible to it. Passing the
    // live value is what makes a wrapper that prepends a directory — or a test
    // that points at a stub binary — actually take effect.
    const binary = Bun.which("grok", { PATH: env.get("PATH") });
    if (!binary) {
        // Says only what it checked. It used to read as though authentication
        // had been verified too, so an unauthenticated grok produced a turn that
        // failed for a reason this message had implicitly ruled out
        // (PR #330 review t8).
        throw new Error(
            "grok CLI not found on PATH. Install it, then authenticate separately (XAI_API_KEY or `grok login`) — this check only looks for the binary."
        );
    }

    return binary;
}

/**
 * The prompt half of a turn's argv.
 *
 * `--prompt-file` is made absolute against the CALLER's cwd, which is where the
 * user typed the path. It has to become absolute here because grok chdirs to
 * `--cwd` before reading it, so a bare relative path would resolve against the
 * session's directory instead of the shell the command was run from.
 */
export function promptArgs(options: { prompt?: string; promptFile?: string }): string[] {
    if (options.promptFile) {
        return ["--prompt-file", resolve(options.promptFile)];
    }

    if (options.prompt) {
        return ["-p", options.prompt];
    }

    throw new Error("A prompt is required: pass --prompt-file <path> or --prompt '<text>'.");
}

/**
 * Blank the prompt payload before the invocation is logged.
 *
 * The flag list must match what `promptArgs` actually emits. It did not: an
 * inline prompt is passed as `-p`, which this only matched in its long
 * `--prompt` spelling, so every inline prompt was written verbatim into the
 * day-stamped log (PR #330 review t15).
 */
const PROMPT_FLAGS = new Set(["-p", "--prompt", "--prompt-file"]);

export function redactArgs(args: string[]): string[] {
    return args.map((arg, i) => (i > 0 && PROMPT_FLAGS.has(args[i - 1]) ? "<redacted>" : arg));
}

function openTurnLog(logPath: string, name: string, turn: number): number {
    try {
        return openSync(logPath, "wx");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            throw new Error(
                `Turn ${turn} of grok session '${name}' already has a transcript — another turn is running or died uncleanly. Read it with 'tools grok read --name ${name} --turn ${turn}'.`
            );
        }

        throw err;
    }
}

async function runTurn(
    store: GrokSessionStore,
    meta: GrokSessionMeta,
    turn: number,
    turnArgs: string[],
    /**
     * Metadata to persist only once this turn has WON the reservation below.
     * A safety-mode change must not be written before that: two concurrent
     * steers derive the same next turn, and the loser used to persist its own
     * `readOnly` on the way past. A `steer --writable` that then lost the race
     * left `readOnly: false` behind, so the next unflagged steer of a read-only
     * session ran writable (PR #330 review t28).
     */
    reservedMetaPatch?: Partial<GrokSessionMeta>
): Promise<TurnResult> {
    const binary = resolveGrokBinary();
    const logPath = turnLogPath(meta.name, turn);
    const errPath = turnErrPath(meta.name, turn);
    const args = [...turnArgs, "--cwd", meta.cwd, "--output-format", "streaming-json"];
    // The prompt is user text and can carry credentials or private code, so the
    // day-stamped log gets the shape of the invocation, never its payload.
    log.info({ name: meta.name, turn, binary, args: redactArgs(args), logPath }, "starting grok turn");

    // O_EXCL: the turn log doubles as the turn reservation. Two concurrent
    // steers derive the same next turn from the same metadata, and "w" would
    // let the loser silently truncate the winner's transcript.
    const logFd = openTurnLog(logPath, meta.name, turn);
    let errFd: number;

    try {
        if (reservedMetaPatch) {
            store.updateMeta(meta.name, reservedMetaPatch);
        }

        errFd = openSync(errPath, "w");
    } catch (err) {
        // Anything between winning the reservation and entering the spawn block
        // used to leak logFd, because the try/finally that closes it started
        // after both opens had succeeded (PR #330 review t12).
        closeSync(logFd);
        throw err;
    }

    let exitCode: number | null = null;
    try {
        const proc = Bun.spawn({
            cmd: [binary, ...args],
            cwd: meta.cwd,
            env: buildTurnEnv(env.getProcessEnv(), meta.workerHome, meta.rendezvousSession),
            stdin: "ignore",
            stdout: logFd,
            stderr: errFd,
        });
        exitCode = await proc.exited;
    } finally {
        closeSync(logFd);
        closeSync(errFd);
    }

    const summary = parseTurnLog(existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
    const stderr = existsSync(errPath) ? readFileSync(errPath, "utf8") : "";
    const updated = store.updateMeta(meta.name, {
        turns: turn,
        lastTurn: { turn, ended: summary.ended, exitCode, at: new Date().toISOString() },
    });
    log.info(
        { name: meta.name, turn, exitCode, ended: summary.ended, toolCalls: summary.toolCalls.length },
        "grok turn finished"
    );

    return { meta: updated, turn, summary, exitCode, stderr, logPath, errPath };
}

export async function runSession(options: RunSessionOptions): Promise<TurnResult> {
    const store = new GrokSessionStore();
    // Everything that can fail deterministically has to fail BEFORE the claim.
    // `createMeta` is an O_EXCL reservation of the name, so a throw after it
    // leaves valid metadata for a session that never started: the next `run`
    // is rejected as already existing, and `steer` names a session id whose
    // first turn was never launched (PR #330 review).
    const promptArguments = promptArgs(options);
    resolveGrokBinary();

    const meta: GrokSessionMeta = {
        name: options.name,
        sessionId: crypto.randomUUID(),
        cwd: resolve(options.cwd),
        workerHome: options.workerHome ? resolve(options.workerHome) : defaultWorkerHome(),
        model: options.model,
        readOnly: options.readOnly,
        turns: 0,
        createdAt: new Date().toISOString(),
        // Pinned once: every later steer must land in the same swarm, even if
        // the steering command is issued from a different session.
        rendezvousSession:
            assignedSessionId(env.getProcessEnv()) ?? resolveAgentHost(env.getProcessEnv()).sessionId ?? undefined,
    };
    store.createMeta(meta);

    return runTurn(store, meta, 1, buildRunArgs(meta, promptArguments));
}

export async function steerSession(options: SteerSessionOptions): Promise<TurnResult> {
    const store = new GrokSessionStore();
    const meta = store.readMeta(options.name);
    if (!meta) {
        throw new Error(`Grok session not found: ${options.name}. Start one with 'tools grok run'.`);
    }

    const readOnly = options.readOnly ?? meta.readOnly;
    const args = buildSteerArgs(meta, readOnly, promptArgs(options));
    const modeChange = readOnly === meta.readOnly ? undefined : { readOnly };

    return runTurn(store, { ...meta, readOnly }, meta.turns + 1, args, modeChange);
}
