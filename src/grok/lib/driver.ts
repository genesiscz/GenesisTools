import { existsSync, readFileSync } from "node:fs";
import { logger } from "@genesiscz/utils/logger";
import { formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import type { WorkerDriver } from "@genesiscz/utils/worker/driver";
import { runningTurnPids, signalRunningTurns } from "@genesiscz/utils/worker/ps";
import type { Command } from "commander";
import { turnErrPath, turnLogPath } from "./paths";
import { type GrokSessionMeta, GrokSessionStore } from "./store";
import { parseTurnLog } from "./stream";
import { type GrokAuthMode, grokTurnReport, printTurn, runSession, steerSession } from "./worker";

const log = logger.child({ component: "grok:worker:driver" });

/**
 * Grok spawns the CLI fresh for every turn, so a turn IS a process: liveness comes off the
 * process table and `stop` is a signal. There is no daemon to shut down, which is why
 * `shutdown` is absent and the shared `stop` falls through to `interruptTurn`.
 */

function parseAuthMode(value: unknown): GrokAuthMode | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (value !== "subscription" && value !== "api-key") {
        throw new Error(`--auth must be subscription or api-key, got '${String(value)}'.`);
    }

    return value;
}

function requireTurnLog(meta: GrokSessionMeta, turn: number): string {
    const path = turnLogPath(meta.name, turn);

    if (!existsSync(path)) {
        throw new Error(`No log for turn ${turn} of '${meta.name}' (${path})`);
    }

    return path;
}

/**
 * What to hand `runSession` / `steerSession`: the PATH when the caller gave one, else the text.
 *
 * The shared verb layer reads `--prompt-file` into a string, because Claude and Codex need the
 * text. Grok's binary takes the path natively, so forwarding the contents instead pushed the whole
 * brief through argv under `ARG_MAX` and left `promptArgs`' `--prompt-file` branch unreachable
 * from the CLI while its tests stayed green.
 */
export function promptInput(prompt: string | undefined, promptFile: string | undefined): Record<string, string> {
    if (promptFile) {
        return { promptFile };
    }

    return prompt === undefined ? {} : { prompt };
}

export const grokDriver: WorkerDriver<GrokSessionMeta> = {
    backend: "grok",
    store: new GrokSessionStore(),
    help: {
        spawn: "turn 1 of a new session (blocking; can take minutes)",
        steer: "Send the next instruction to an existing session (blocking; can take minutes)",
        read: "its turn report",
        tail: "Follow the running turn's transcript as it is written; stops when the turn ends",
    },

    // 🛑 For grok the cwd IS the sandbox (`WORKER_CAPABILITIES.grok.sandbox === "cwd-jail"`).
    // Letting the shared spawn default it to `process.cwd()` makes the jail boundary implicit and
    // follows wherever the caller happened to be standing; the pre-shared-core command refused
    // outright, and a sandbox you did not name is not one you chose.
    spawnFlags: { cwdRequired: true },

    extendSpawn(command: Command) {
        command
            .option("--readonly", "Review mode: the worker gets no write or terminal tools")
            .option("--worker-home <path>", "GROK_HOME for the isolated worker")
            .option("--auth <mode>", "Credential the worker runs under: subscription | api-key");
    },

    extendSteer(command: Command) {
        command
            .option("--readonly", "switch the session to read-only from this turn on")
            .option("--writable", "switch the session back to the default project-jail mode")
            .option("--skills", "load your personal skills from this turn on")
            .option("--no-skills", "hide your personal skills from this turn on")
            .option("--rules", "load your personal rules from this turn on")
            .option("--no-rules", "hide your personal rules from this turn on");
    },

    async spawn(input) {
        const extras = input.extras as {
            readonly?: boolean;
            workerHome?: string;
            auth?: unknown;
            promptFile?: string;
        };

        const auth = parseAuthMode(extras.auth);
        const result = await runSession({
            name: input.name,
            cwd: input.cwd,
            // Handed on, never swallowed: `runSession` owns the refusal, because the legacy
            // `tools grok run --name` door reaches it without passing through here at all.
            ...(input.account === undefined ? {} : { account: input.account }),
            // Prefer the PATH. The shared reader slurps `--prompt-file` into a string for the
            // backends that need text, but grok takes the path natively, and routing a brief
            // through argv as `-p <whole file>` puts it under ARG_MAX for no gain. `--prompt-file`
            // is the form this tool's README documents as primary.
            ...promptInput(input.prompt, extras.promptFile),
            model: input.model ?? "grok-4.7",
            readOnly: extras.readonly === true,
            ...(extras.workerHome === undefined ? {} : { workerHome: extras.workerHome }),
            ...(auth === undefined ? {} : { auth }),
            surfaces: input.surfaces,
        });

        return { kind: "turn", report: grokTurnReport(result) };
    },

    async steer(meta, input) {
        const extras = input.extras as {
            readonly?: boolean;
            writable?: boolean;
            skills?: boolean;
            rules?: boolean;
            promptFile?: string;
        };
        let readOnly: boolean | undefined;

        if (extras.readonly) {
            readOnly = true;
        } else if (extras.writable) {
            readOnly = false;
        }

        const result = await steerSession({
            name: meta.name,
            ...promptInput(input.prompt, extras.promptFile),
            ...(readOnly === undefined ? {} : { readOnly }),
            // Only the flags given on this steer; an absent one keeps the session's choice.
            surfaces: { skills: extras.skills, rules: extras.rules },
        });

        return { kind: "turn", report: grokTurnReport(result) };
    },

    async liveness(meta) {
        // The grok child carries the session uuid as --session-id (turn 1) or --resume (later
        // turns), and only grok processes carry this uuid.
        const running = await runningTurnPids(meta.sessionId, /grok/);

        return { running: running.length > 0, pids: running.map((entry) => entry.pid) };
    },

    async interruptTurn(meta) {
        const targets = await runningTurnPids(meta.sessionId, /grok/);
        // pid-verified: runningTurnPids matched each pid's live `ps` command line against the
        // session id and the binary; a recycled pid does not carry that marker.
        const { signalled, skipped } = signalRunningTurns(targets, "SIGTERM");

        for (const target of targets) {
            log.info({ pid: target.pid, command: target.command }, "stopping grok worker turn");
        }

        for (const miss of skipped) {
            log.debug({ pid: miss.pid, code: miss.code }, "grok worker turn pid could not be signalled");
        }

        return { kind: "signalled", pids: signalled };
    },

    latestTurn: (meta) => meta.turns,
    turnFile: (meta, turn) => requireTurnLog(meta, turn),

    async readDefault(meta, turn) {
        const logPath = requireTurnLog(meta, turn);
        const errPath = turnErrPath(meta.name, turn);
        printTurn({
            meta,
            turn,
            summary: parseTurnLog(readFileSync(logPath, "utf8")),
            exitCode: meta.lastTurn?.turn === turn ? (meta.lastTurn?.exitCode ?? null) : null,
            stderr: existsSync(errPath) ? readFileSync(errPath, "utf8") : "",
            logPath,
            errPath,
            // A replay has no before/after snapshot, so it cannot honestly claim one.
            worktree: null,
        });

        return Promise.resolve();
    },

    rowHeaders: ["NAME", "TURNS", "MODE", "LAST TURN", "SESSION ID", "CWD"],

    row(meta) {
        const last = meta.lastTurn
            ? formatDotStatus(meta.lastTurn.ended ? "ok" : "err", meta.lastTurn.ended ? "completed" : "died")
            : formatDotStatus("dim", "none");

        return [
            meta.name,
            String(meta.turns),
            meta.readOnly ? "readonly" : "jail",
            last,
            meta.sessionId,
            truncateDisplay(meta.cwd, 40),
        ];
    },
};
