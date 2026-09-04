import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assignedSessionId, resolveAgentHost } from "@genesiscz/utils/agent/host";
import { env } from "@genesiscz/utils/env";
import { logger } from "@genesiscz/utils/logger";
import { buildWorkerContract } from "@genesiscz/utils/worker/contract";
import {
    DEFAULT_SURFACES,
    ensureGrokWorkerConfig,
    grokSurfaceEnv,
    surfacesFromFlags,
    type WorkerSurfaces,
} from "@genesiscz/utils/worker/isolation";
import { defaultWorkerHome, turnErrPath, turnLogPath } from "./paths";
import { type GrokSessionMeta, GrokSessionStore } from "./store";
import { type GrokTurnSummary, parseTurnLog } from "./stream";
import { type WorktreeDelta, worktreeDelta, worktreeState } from "./worktree";

const log = logger.child({ component: "grok:worker" });

/**
 * The ~/.claude compat pickups that are side effects or credentials, never
 * user-facing surfaces: hooks run commands, MCP servers carry secrets, session
 * pickup leaks the user's own conversations. Off unconditionally. Skills and
 * rules are surfaces and follow `WorkerSurfaces` (on by default).
 */
const SIDE_EFFECT_ENV: Record<string, string> = {
    GROK_CLAUDE_MCPS_ENABLED: "0",
    GROK_CLAUDE_HOOKS_ENABLED: "0",
    GROK_CLAUDE_SESSIONS_ENABLED: "0",
};

const READ_ONLY_TOOLS = "read_file,list_dir,grep";

export type GrokAuthMode = "subscription" | "api-key";

/**
 * Where `grok login` keeps its OAuth credential. The interactive CLI reads it
 * from its own GROK_HOME (~/.grok by default). The worker's GROK_HOME is a
 * separate directory, so without this the binary falls back to XAI_API_KEY and
 * bills the metered API team instead of the subscription (2026-09-04: five
 * planners died on a 403 "used all available credits").
 */
export function subscriptionAuthPath(baseEnv: Record<string, string | undefined>): string {
    if (baseEnv.GROK_AUTH_PATH) {
        return baseEnv.GROK_AUTH_PATH;
    }

    return join(baseEnv.GROK_HOME ?? join(homedir(), ".grok"), "auth.json");
}

/** An explicit request wins; otherwise subscription when the login file exists, else the API key. */
export function resolveAuthMode(requested: GrokAuthMode | undefined, authPath: string): GrokAuthMode {
    if (requested) {
        return requested;
    }

    return existsSync(authPath) ? "subscription" : "api-key";
}

export interface RunSessionOptions {
    name: string;
    cwd: string;
    prompt?: string;
    promptFile?: string;
    model?: string;
    readOnly: boolean;
    workerHome?: string;
    auth?: GrokAuthMode;
    surfaces?: WorkerSurfaces;
}

export interface SteerSessionOptions {
    name: string;
    prompt?: string;
    promptFile?: string;
    readOnly?: boolean;
    /** Only the flags given on this steer; absent ones keep the session's choice. */
    surfaces?: Partial<WorkerSurfaces>;
}

export interface TurnResult {
    meta: GrokSessionMeta;
    turn: number;
    summary: GrokTurnSummary;
    exitCode: number | null;
    stderr: string;
    logPath: string;
    errPath: string;
    /** What the turn changed in cwd. Null when cwd is not a git repo. */
    worktree: WorktreeDelta | null;
}

/**
 * The environment a worker turn runs under.
 *
 * The toggles are applied AFTER the caller's environment on purpose: whoever
 * launches `tools grok` may already export GROK_CLAUDE_HOOKS_ENABLED=1, and
 * letting that through would run the user's hooks inside the worker. The
 * surfaces (skills, rules) come from the session's choice, never from the
 * ambient environment either. Extracted so the contract is asserted rather
 * than described (PR #330 review t2).
 */
export function buildTurnEnv(
    baseEnv: Record<string, string | undefined>,
    workerHome: string,
    rendezvousSession?: string | null,
    auth?: { mode: GrokAuthMode; authPath: string },
    surfaces: WorkerSurfaces = DEFAULT_SURFACES
): Record<string, string | undefined> {
    const built: Record<string, string | undefined> = {
        ...baseEnv,
        GROK_HOME: workerHome,
        // The swarm the worker must join. Without it the worker would fall back
        // to a host session id and could start a swarm its parent is not in.
        ...(rendezvousSession ? { GT_RENDEZVOUS_SESSION: rendezvousSession } : {}),
        ...grokSurfaceEnv(surfaces),
        ...SIDE_EFFECT_ENV,
    };

    if (auth?.mode === "subscription") {
        // The binary prefers an API key over its OAuth login ("XAI_API_KEY is
        // still set and will be used for authentication" in its own strings),
        // so the key has to go. GROK_AUTH_PATH points the worker at the REAL
        // login file, never a copy, so a token refresh cannot fork the
        // credential between the worker and the interactive CLI.
        delete built.XAI_API_KEY;
        delete built.GROK_CODE_XAI_API_KEY;
        built.GROK_AUTH_PATH = auth.authPath;
    }

    return built;
}

/**
 * The shared worker contract as grok's `--rules <TEXT>` ("custom rules for the
 * system prompt"). Passed on EVERY turn like `--tools`, because the CLI keeps no
 * flag across `--resume`.
 */
export function contractArgs(readOnly: boolean, surfaces: WorkerSurfaces = DEFAULT_SURFACES): string[] {
    return [
        "--rules",
        buildWorkerContract({ backend: "grok", sandbox: readOnly ? "read-only" : "cwd-jail", surfaces }),
    ];
}

/** Arguments for the first turn of a session. */
export function buildRunArgs(
    session: { sessionId: string; model?: string; readOnly: boolean; surfaces?: WorkerSurfaces },
    promptArguments: string[]
): string[] {
    const args = [...promptArguments, "--session-id", session.sessionId];
    if (session.model) {
        args.push("-m", session.model);
    }

    if (session.readOnly) {
        args.push("--tools", READ_ONLY_TOOLS);
    }

    args.push(...contractArgs(session.readOnly, session.surfaces));
    return args;
}

/**
 * Arguments for a resumed turn. `--tools` is re-armed every time because the
 * grok CLI drops safety flags on `--resume`; without this a session started
 * read-only silently gains write tools from turn 2 onward.
 */
export function buildSteerArgs(
    session: { sessionId: string; surfaces?: WorkerSurfaces },
    readOnly: boolean,
    promptArguments: string[]
): string[] {
    const args = [...promptArguments, "--resume", session.sessionId];
    if (readOnly) {
        args.push("--tools", READ_ONLY_TOOLS);
    }

    args.push(...contractArgs(readOnly, session.surfaces));
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
    const authPath = subscriptionAuthPath(env.getProcessEnv());
    const authMode = resolveAuthMode(meta.auth, authPath);
    if (authMode === "subscription" && !existsSync(authPath)) {
        throw new Error(
            `grok subscription login not found at ${authPath}. Run 'grok login' first, or start the session with --auth api-key.`
        );
    }

    // The prompt is user text and can carry credentials or private code, so the
    // day-stamped log gets the shape of the invocation, never its payload.
    log.info({ name: meta.name, turn, binary, args: redactArgs(args), logPath, auth: authMode }, "starting grok turn");

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

    // Snapshot before the spawn so the report can say whether the turn did anything.
    const worktreeBefore = worktreeState(meta.cwd);

    let exitCode: number | null = null;
    try {
        const surfaces = meta.surfaces ?? DEFAULT_SURFACES;
        // `~/.agents/skills` has no env toggle; `--no-skills` lives in the worker home's config.toml.
        ensureGrokWorkerConfig(meta.workerHome, surfaces);
        const proc = Bun.spawn({
            cmd: [binary, ...args],
            cwd: meta.cwd,
            env: buildTurnEnv(
                env.getProcessEnv(),
                meta.workerHome,
                meta.rendezvousSession,
                { mode: authMode, authPath },
                surfaces
            ),
            stdin: "ignore",
            stdout: logFd,
            stderr: errFd,
        });
        exitCode = await proc.exited;
    } finally {
        closeSync(logFd);
        closeSync(errFd);
    }

    const worktree = worktreeDelta(worktreeBefore, worktreeState(meta.cwd));
    const summary = parseTurnLog(existsSync(logPath) ? readFileSync(logPath, "utf8") : "");
    const stderr = existsSync(errPath) ? readFileSync(errPath, "utf8") : "";
    const updated = store.updateMeta(meta.name, {
        turns: turn,
        lastTurn: { turn, ended: summary.ended, exitCode, at: new Date().toISOString() },
    });
    log.info(
        {
            name: meta.name,
            turn,
            exitCode,
            ended: summary.ended,
            toolCalls: summary.toolCalls.length,
            changedThisTurn: worktree?.changedThisTurn ?? null,
        },
        "grok turn finished"
    );

    return { meta: updated, turn, summary, exitCode, stderr, logPath, errPath, worktree };
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
        auth: options.auth,
        surfaces: options.surfaces ?? DEFAULT_SURFACES,
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
    const previous = meta.surfaces ?? DEFAULT_SURFACES;
    const surfaces = surfacesFromFlags(options.surfaces ?? {}, previous);
    const args = buildSteerArgs({ ...meta, surfaces }, readOnly, promptArgs(options));
    const surfacesChanged = surfaces.skills !== previous.skills || surfaces.rules !== previous.rules;
    const modeChange =
        readOnly === meta.readOnly && !surfacesChanged
            ? undefined
            : { ...(readOnly === meta.readOnly ? {} : { readOnly }), ...(surfacesChanged ? { surfaces } : {}) };

    return runTurn(store, { ...meta, readOnly, surfaces }, meta.turns + 1, args, modeChange);
}
