import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
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

export function resolveGrokBinary(): string {
    const binary = Bun.which("grok");
    if (!binary) {
        throw new Error("grok CLI not found on PATH. Install it and log in (auth via XAI_API_KEY) first.");
    }

    return binary;
}

function promptArgs(options: { prompt?: string; promptFile?: string }): string[] {
    if (options.promptFile) {
        return ["--prompt-file", resolve(options.promptFile)];
    }

    if (options.prompt) {
        return ["-p", options.prompt];
    }

    throw new Error("A prompt is required: pass --prompt-file <path> or --prompt '<text>'.");
}

async function runTurn(
    store: GrokSessionStore,
    meta: GrokSessionMeta,
    turn: number,
    turnArgs: string[]
): Promise<TurnResult> {
    const binary = resolveGrokBinary();
    const logPath = turnLogPath(meta.name, turn);
    const errPath = turnErrPath(meta.name, turn);
    const args = [...turnArgs, "--cwd", meta.cwd, "--output-format", "streaming-json"];
    log.info({ name: meta.name, turn, binary, args, logPath }, "starting grok turn");

    const logFd = openSync(logPath, "w");
    const errFd = openSync(errPath, "w");
    let exitCode: number | null = null;
    try {
        const proc = Bun.spawn({
            cmd: [binary, ...args],
            cwd: meta.cwd,
            env: { ...env.getProcessEnv(), GROK_HOME: meta.workerHome, ...ISOLATION_ENV },
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
    if (store.readMeta(options.name)) {
        throw new Error(
            `Grok session '${options.name}' already exists. Use 'tools grok steer --name ${options.name}' or pick a new name.`
        );
    }

    const meta: GrokSessionMeta = {
        name: options.name,
        sessionId: crypto.randomUUID(),
        cwd: resolve(options.cwd),
        workerHome: options.workerHome ? resolve(options.workerHome) : defaultWorkerHome(),
        model: options.model,
        readOnly: options.readOnly,
        turns: 0,
        createdAt: new Date().toISOString(),
    };
    store.writeMeta(meta);

    const args = [...promptArgs(options), "--session-id", meta.sessionId];
    if (meta.model) {
        args.push("-m", meta.model);
    }

    if (meta.readOnly) {
        args.push("--tools", READ_ONLY_TOOLS);
    }

    return runTurn(store, meta, 1, args);
}

export async function steerSession(options: SteerSessionOptions): Promise<TurnResult> {
    const store = new GrokSessionStore();
    const meta = store.readMeta(options.name);
    if (!meta) {
        throw new Error(`Grok session not found: ${options.name}. Start one with 'tools grok run'.`);
    }

    const readOnly = options.readOnly ?? meta.readOnly;
    if (readOnly !== meta.readOnly) {
        store.updateMeta(meta.name, { readOnly });
    }

    const args = [...promptArgs(options), "--resume", meta.sessionId];
    if (readOnly) {
        // The grok CLI forgets safety flags on every --resume; re-arming here is the fix at the root.
        args.push("--tools", READ_ONLY_TOOLS);
    }

    return runTurn(store, { ...meta, readOnly }, meta.turns + 1, args);
}
