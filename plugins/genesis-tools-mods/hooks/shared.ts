// Helpers every feature of this plugin shares: the host the features reach the engine through, where GenesisTools
// keeps its files, the `mods.*` switches of the hooks file, and the per-feature log the features write so their
// heuristics can be improved from real use.
//
// 🛑 Only `register.tsx` sees `$`. `claude plugin validate` refuses `$` passed into a function another file declares,
// and a `read`/`update` of an atom another file declares (checked 2026-10-23), so a feature file gets a `Host`: the
// closures `register.tsx` builds over `$`, each spelled `$.noun.method(...)` there. A feature keeps its state in
// module variables and calls `host.redraw()` after a change, which draws this plugin's `ui.render` hooks again.
import type {
    AgentInfo,
    CommandRunResult,
    FsEntry,
    FsStat,
    ProcessRunInit,
    ProcessRunResult,
    PromptFillArgs,
    ToolCallInput,
    TurnCompleteInput,
} from "claude-code";
import { type ModsSettings, modsSettings } from "./settings";

export { isRecord, MODS_DEFAULTS, type ModsSettings, modsSettings } from "./settings";

export interface Host {
    run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>;
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
    list: (path: string) => Promise<FsEntry[]>;
    exists: (path: string) => Promise<boolean>;
    stat: (path: string) => Promise<FsStat>;
    /** The validator lists every variable a module reads, so the names are fixed. */
    env: (name: "HOME" | "GENESIS_TOOLS_HOME") => Promise<string | undefined>;
    cwd: () => Promise<string>;
    sessionId: () => Promise<string>;
    messages: () => Promise<readonly { role: string; text: string }[]>;
    agents: () => Promise<AgentInfo[]>;
    every: (ms: number, fn: () => void) => void;
    storeGet: (key: string) => Promise<unknown>;
    storeSet: (key: string, value: unknown) => Promise<void>;
    status: (text: string | undefined) => void;
    fill: (args: PromptFillArgs) => Promise<unknown>;
    submit: (text: string) => Promise<unknown>;
    openPane: (id: string, title: string) => Promise<unknown>;
    closePane: (id: string) => Promise<unknown>;
    /** Draws this plugin's `ui.render` hooks again, so a band or pane shows the state just changed. */
    redraw: () => void;
}

/** `<home>/.genesis-tools/agents`; `GENESIS_TOOLS_HOME` replaces the home, as it does for every tool. */
export async function agentsDir(host: Host): Promise<string | undefined> {
    const home = (await host.env("GENESIS_TOOLS_HOME")) ?? (await host.env("HOME"));

    return home ? `${home}/.genesis-tools/agents` : undefined;
}

export async function readHooksFile(host: Host, dir: string | undefined): Promise<string | undefined> {
    return dir ? host.read(`${dir}/hooks.json`).catch(() => undefined) : undefined;
}

let cached: { at: number; value: ModsSettings } | undefined;

/** `modsSettings` of the hooks file, read at most every 10 s: a band redraws often, and the file changes rarely. */
export async function settingsOf(host: Host): Promise<ModsSettings> {
    const now = Date.now();

    if (cached && now - cached.at < 10_000) {
        return cached.value;
    }

    const value = modsSettings(await readHooksFile(host, await agentsDir(host)));
    cached = { at: now, value };

    return value;
}

/**
 * Appends one JSON line to `<agents>/mods-log/<feature>.jsonl`, the record of what a feature did, so its heuristics
 * can be checked against what the person then did. `$.fs.write` replaces a file, so the append goes through `sh`.
 */
export async function logMod(host: Host, feature: string, record: Record<string, unknown>): Promise<void> {
    const dir = await agentsDir(host);

    if (!dir) {
        return;
    }

    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;

    await host
        .run(["/bin/sh", "-c", 'mkdir -p "$(dirname "$1")" && cat >> "$1"', "sh", `${dir}/mods-log/${feature}.jsonl`], {
            stdin: line,
            timeoutMs: 5_000,
        })
        .catch(() => undefined);
}

/** `12s`, `4m 05s`, `1h 02m`. */
export function shortDuration(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));

    if (s < 60) {
        return `${s}s`;
    }

    if (s < 3600) {
        return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
    }

    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/**
 * One feature's part in the events several features share. The engine takes one unmatched hook per event from a
 * plugin, so `register.tsx` holds that hook and calls each feature's part in turn.
 */
export interface Feature {
    /** On session start: start timers, take a first reading. */
    start?: (host: Host) => Promise<void>;
    /** Slash commands, registered at session start and answered by `command.run`. */
    commands?: {
        name: string;
        description: string;
        argumentHint?: string;
        run: (host: Host, args: string) => Promise<CommandRunResult>;
    }[];
    /** Before a tool call runs; the function it returns runs when the call has ended, however it ended. */
    beforeTool?: (host: Host, e: ToolCallInput) => (() => void) | undefined;
    /** After a tool call answered. */
    afterTool?: (host: Host, e: ToolCallInput) => Promise<void>;
    /** After a turn completed, the main loop's or a subagent's (`e.agentId`). */
    afterTurn?: (host: Host, e: TurnCompleteInput) => Promise<void>;
    /** After a loop compacted (the main loop when `agentId` is undefined). */
    compacted?: (agentId: string | undefined) => void;
}
