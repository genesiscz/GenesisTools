import { existsSync, readFileSync } from "node:fs";
import { launchGateForVerdict } from "@app/claude/commands/exec";
import { AIConfig } from "@genesiscz/utils/ai/AIConfig";
import { LONG_TOKEN_MIN_LENGTH, probeLongLivedToken } from "@genesiscz/utils/claude/token-verify";
import type { AIAccountEntry } from "@genesiscz/utils/config/ai.types";
import { logger, out } from "@genesiscz/utils/logger";
import { truncateDisplay } from "@genesiscz/utils/table";
import type { WorkerDriver } from "@genesiscz/utils/worker/driver";
import { isToolCall } from "@genesiscz/utils/worker/events";
import { runningTurnPids } from "@genesiscz/utils/worker/ps";
import type { WorkerTurnReport } from "@genesiscz/utils/worker/turn-report";
import pc from "picocolors";
import { workerTurnErrPath, workerTurnLogPath } from "./paths";
import type { ClaudeWorkerMeta } from "./store";
import { ClaudeWorkerStore } from "./store";
import { type ClaudeTurnResult, type PinnedAccount, spawnWorker, steerWorker } from "./worker";

const log = logger.child({ component: "claude:worker:driver" });

/**
 * Resolve the REQUIRED account for a worker. There is deliberately no autopick here:
 * `tools claude exec` without -a silently chooses by usage headroom, and a handoff that bills
 * an account nobody chose is the failure this backend exists to prevent
 * (WORKER_CAPABILITIES.claude.accountRequired).
 */
async function resolvePinnedAccount(name: string | undefined): Promise<PinnedAccount> {
    const config = await AIConfig.load();
    const eligible = config.getAccountsByProvider("anthropic-sub").filter((a) => a.tokens.longLivedToken);
    const names = eligible.map((a: AIAccountEntry) => a.name).join(", ");

    if (!name) {
        throw new Error(`--account is required for a claude worker (no autopick). With a token: ${names}`);
    }

    const match = eligible.find((a: AIAccountEntry) => a.name === name);

    if (!match) {
        throw new Error(`Account "${name}" has no long-lived token. With a token: ${names}`);
    }

    const token = match.tokens.longLivedToken ?? "";

    if (token.length < LONG_TOKEN_MIN_LENGTH) {
        // A truncated token 401s and Claude Code silently falls back to the
        // keychain login, billing the wrong account rather than failing.
        throw new Error(
            `The stored token for "${match.name}" is truncated (${token.length} chars, expect ~108). Recapture it with: tools claude login-long ${match.name}`
        );
    }

    const gate = launchGateForVerdict(await probeLongLivedToken(token), match.name);

    if (!gate.launch) {
        throw new Error(`${gate.reason} Recapture it with: ${gate.fix}`);
    }

    return { name: match.name, label: match.label, token };
}

function turnReport(result: ClaudeTurnResult): WorkerTurnReport {
    return {
        backend: "claude",
        name: result.meta.name,
        turn: result.turn,
        ended: result.completed,
        exitCode: result.exitCode,
        report: result.report,
        stderr: result.stderr,
        errPath: workerTurnErrPath(result.meta.name, result.turn),
        toolCalls: result.events.filter(isToolCall),
        // No git snapshot is taken around a claude turn; the brief plus a git status check hold policy.
        worktree: null,
        logPath: result.logPath,
        transcriptHint: `tools claude worker read --name ${result.meta.name} --turn ${result.turn} --format compact`,
    };
}

function requireTurnLog(meta: ClaudeWorkerMeta, turn: number): string {
    const path = workerTurnLogPath(meta.name, turn);

    if (!existsSync(path)) {
        throw new Error(`No transcript for turn ${turn} of '${meta.name}'.`);
    }

    return path;
}

/**
 * `claude -p` spawns fresh for every turn, so a turn IS a process: liveness comes off the
 * process table and there is no daemon to shut down. The one genuine specific is that the
 * account is pinned at spawn and re-resolved (never re-chosen) on every later turn.
 */
export const claudeWorkerDriver: WorkerDriver<ClaudeWorkerMeta> = {
    backend: "claude",
    store: new ClaudeWorkerStore(),
    spawnFlags: { cwdRequired: true },
    help: {
        spawn: "turn 1 of a new pinned claude -p session (blocking; can take minutes)",
        steer: "Send the next instruction to an existing worker (blocking; can take minutes)",
        read: "the raw stream-json transcript",
        tail: "Follow the running turn's transcript as it is written; stops when the turn ends",
    },

    extendSpawn(command) {
        command.option("--safe-mode", "Launch with claude --safe-mode (skip CLAUDE.md, hooks, skills, MCP)");
    },

    async spawn(input) {
        // The one switch claude -p has is --safe-mode, all or nothing. A trivial turn cost
        // $0.11 with the surfaces on and $0.06 without (2026-09-01); the default follows the
        // other backends: on.
        const asked = (input.extras as { safeMode?: boolean }).safeMode === true;
        const safeMode = asked || input.surfaces.skills === false || input.surfaces.rules === false;

        if (safeMode && !asked) {
            out.printlnErr(
                pc.yellow("claude has no separate skills/rules switch; --no-skills or --no-rules means --safe-mode.")
            );
        }

        const result = await spawnWorker({
            name: input.name,
            account: await resolvePinnedAccount(input.account),
            cwd: input.cwd,
            prompt: input.prompt ?? "",
            ...(input.model === undefined ? {} : { model: input.model }),
            safeMode,
        });

        return { kind: "turn", report: turnReport(result) };
    },

    async steer(meta, input) {
        // Re-resolve the PINNED account, never a flag: every turn of a worker bills the
        // identity chosen at spawn.
        const account = await resolvePinnedAccount(meta.account);
        const result = await steerWorker({ name: meta.name, account, prompt: input.prompt });

        return { kind: "turn", report: turnReport(result) };
    },

    async liveness(meta) {
        // The shared helper, not a private copy: it refuses a marker shorter than 8 characters,
        // which a hand-edited meta file can produce and which then matches every `claude` line
        // in the process table, the user's own interactive TUI included.
        const running = await runningTurnPids(meta.sessionId, /claude/);

        return { running: running.length > 0, pids: running.map((entry) => entry.pid) };
    },

    async interruptTurn(meta) {
        for (const target of await runningTurnPids(meta.sessionId, /claude/)) {
            log.info({ pid: target.pid, command: target.command }, "stopping claude worker turn");
            // pid-verified: runningTurnPids matched this pid's live `ps` command line against the session id and the binary; a recycled pid does not carry that marker
            process.kill(target.pid, "SIGTERM");
        }

        return undefined;
    },

    latestTurn: (meta) => meta.turns,
    turnFile: (meta, turn) => requireTurnLog(meta, turn),

    async readDefault(meta, turn) {
        out.print(readFileSync(requireTurnLog(meta, turn), "utf8"));

        return Promise.resolve();
    },

    rowHeaders: ["NAME", "TURNS", "ACCOUNT", "CWD"],
    row: (meta) => [meta.name, String(meta.turns), meta.account, truncateDisplay(meta.cwd, 40)],
};
