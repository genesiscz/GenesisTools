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
    PromptAutocompleteInput,
    PromptAutocompleteSuggestion,
    PromptFillArgs,
    ToolCallInput,
    TurnCompleteInput,
    UiCopyResult,
    UiScrollResult,
} from "claude-code";
import { MODS_DEFAULTS, type ModsSettings, modsSettings } from "./settings";
import type { Sidebar } from "./sidebar";

export { isRecord, MODS_DEFAULTS, type ModsSettings, modsSettings } from "./settings";

export interface Host {
    run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>;
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<void>;
    /** Adds `text` at the end of a file, making it and its folder when missing; rejects when the write failed. */
    append: (path: string, text: string) => Promise<void>;
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
    /** Opens a sidebar: docked beside the transcript in fullscreen, a dialog with the keyboard (Esc closes) otherwise. */
    openPane: (id: string, title: string, from?: "command" | "band") => Promise<unknown>;
    /** Closes the sidebar when it shows, else opens it: what a press on its band chip does. */
    togglePane: (id: string, title: string, from?: "command" | "band") => Promise<unknown>;
    closePane: (id: string) => Promise<unknown>;
    copy: (text: string) => Promise<UiCopyResult>;
    /**
     * Scrolls a transcript row into view, its top at the window's top: a message by its transcript `uuid`, a tool
     * call by its id. The engine moves a transcript row only while the call answers the person's own press.
     */
    scroll: (requestId: string) => Promise<UiScrollResult>;
    /** Opens a URL with macOS `open`: a browser page, or a genesis.tools route. */
    openUrl: (url: string) => Promise<unknown>;
    /** A short notice that fades by itself. */
    toast: (text: string) => void;
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
 * The settings as last read, without waiting: the defaults before the first read. For a press, whose engine calls must
 * come before any await (`register.tsx`, `showPane`).
 */
export function settingsNow(): ModsSettings {
    return cached?.value ?? MODS_DEFAULTS;
}

/** Drops the remembered settings: a test sets up another hooks file. */
export function forgetSettings(): void {
    cached = undefined;
}

/** Appends one JSON line, `at` first, to a `.jsonl` file (`Host.append`); a line that could not be written is dropped. */
export async function appendJsonl(host: Host, path: string, record: Record<string, unknown>): Promise<void> {
    await host.append(path, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`).catch(() => undefined);
}

/**
 * Appends one JSON line to `<agents>/mods-log/<feature>.jsonl`, the record of what a feature did, so its heuristics
 * can be checked against what the person then did.
 */
export async function logMod(host: Host, feature: string, record: Record<string, unknown>): Promise<void> {
    const dir = await agentsDir(host);

    if (dir) {
        await appendJsonl(host, `${dir}/mods-log/${feature}.jsonl`, record);
    }
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
    /** As a loop sends a model request (`e.agentId` set for a subagent's); the request does not wait for it. */
    beforeStep?: (host: Host, e: { agentId?: string }) => Promise<void>;
    /** After a turn completed, the main loop's or a subagent's (`e.agentId`). */
    afterTurn?: (host: Host, e: TurnCompleteInput) => Promise<void>;
    /** After a loop compacted (the main loop when `agentId` is undefined). */
    compacted?: (host: Host, agentId: string | undefined) => void | Promise<void>;
    /** The sidebars it opens from the band (`sidebar.tsx`). */
    sidebars?: Sidebar[];
    /** Rows for the prompt's typeahead as the person types (`prompt.autocomplete`); none for most tokens. */
    autocomplete?: (host: Host, e: PromptAutocompleteInput) => Promise<PromptAutocompleteSuggestion[]>;
}
