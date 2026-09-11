import { existsSync, readFileSync } from "node:fs";
import { formatDotStatus, truncateDisplay } from "@genesiscz/utils/table";
import type { WorkerDriver } from "@genesiscz/utils/worker/driver";
import { runningTurnPids } from "@genesiscz/utils/worker/ps";
import type { Command } from "commander";
import { turnErrPath, turnLogPath } from "./paths";
import { type GrokSessionMeta, GrokSessionStore } from "./store";
import { parseTurnLog } from "./stream";
import { type GrokAuthMode, grokTurnReport, printTurn, runSession, steerSession } from "./worker";

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

export const grokDriver: WorkerDriver<GrokSessionMeta> = {
    backend: "grok",
    store: new GrokSessionStore(),
    help: {
        spawn: "turn 1 of a new session (blocking; can take minutes)",
        steer: "Send the next instruction to an existing session (blocking; can take minutes)",
        read: "its turn report",
        tail: "Follow the running turn's transcript as it is written; stops when the turn ends",
    },

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
        const extras = input.extras as { readonly?: boolean; workerHome?: string; auth?: unknown };
        const auth = parseAuthMode(extras.auth);
        const result = await runSession({
            name: input.name,
            cwd: input.cwd,
            ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
            model: input.model ?? "grok-4.6",
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
        };
        let readOnly: boolean | undefined;

        if (extras.readonly) {
            readOnly = true;
        } else if (extras.writable) {
            readOnly = false;
        }

        const result = await steerSession({
            name: meta.name,
            prompt: input.prompt,
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
        for (const target of await runningTurnPids(meta.sessionId, /grok/)) {
            // pid-verified: runningTurnPids matched this pid's live `ps` command line against the session id and the binary; a recycled pid does not carry that marker
            process.kill(target.pid, "SIGTERM");
        }
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
